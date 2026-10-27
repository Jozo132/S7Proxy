// @ts-check
import { describe, expect, it } from 'vitest';
import { decodeProgramInventory, decodeProgramEventMetadata } from '../../src/protocol/s7commplus/block-inventory.js';
import { getOperationPolicy } from '../../src/protocol/s7commplus/operation-policy.js';
import { BLOCK_CONTENT_ATTRIBUTES } from '../../src/protocol/s7commplus/operation-policy.js';
import { decodeBlockContent } from '../../src/protocol/s7commplus/block-upload.js';
import { Cursor, decodeValue, decodeObjects, encodeOperation, PlusAssembler, u32, vlq } from '../../src/protocol/s7commplus/codec.js';
import { S7CommPlusClient } from '../../src/client/s7commplus-client.js';
import { fixture } from '../s7commplus-fixture.js';

/** @param {number} rid @param {number} classId @param {number} number @param {string} name */
function block(rid, classId, number, name) {
  return Buffer.concat([Buffer.from([0xA1]), u32(rid), vlq(classId), Buffer.from([0, 0, 0xA3]),
    vlq(233), Buffer.from([0, 21]), vlq(Buffer.byteLength(name)), Buffer.from(name),
    Buffer.from([0xA3]), vlq(2521), Buffer.from([0, 3, number >>> 8, number & 255, 0xA2])]);
}

function inventory() {
  const wire = Buffer.concat([Buffer.from([0xA1]), u32(3), vlq(2520), Buffer.from([0, 0]),
    block(0x8A0E0007, 2574, 7, 'Storage'), block(0x8A130008, 2579, 8, 'Routine'),
    block(0x8A320009, 2647, 9, 'Cycle'), Buffer.from([0xA2])]);
  return { objectId: 3, objects: decodeObjects(new Cursor(wire)), receivedAt: '2026-01-01T00:00:00.000Z' };
}

describe('native program inventory', () => {
  it('preserves independently encoded OB, FC and DB identities without calling metadata block content', () => {
    const result = decodeProgramInventory(inventory());
    expect(result.blocks.map(block => [block.type, block.number, block.objectRid])).toEqual([
      ['DB', 7, 0x8A0E0007], ['FC', 8, 0x8A130008], ['OB', 9, 0x8A320009],
    ]);
    expect(result.blocks.every(block => block.content.byteCount === null && block.knowHowProtection === 'UNKNOWN')).toBe(true);
    expect(result.blocks.every(block => block.content.status === 'NOT_RETRIEVED')).toBe(true);
    expect(result.completeness).toContain('NOT_PROVEN_EXHAUSTIVE');
  });
  it('rejects foreign roots, duplicate objects, attributes and contradictory numbers', () => {
    const original = inventory();
    expect(() => decodeProgramInventory({ ...original, objectId: 4 })).toThrow(/root/);
    expect(() => decodeProgramInventory({ ...original, objects: [...original.objects, original.objects[1]] })).toThrow(/Repeated/);
    const duplicate = inventory();
    duplicate.objects[1].attributes.push(duplicate.objects[1].attributes[0]);
    expect(() => decodeProgramInventory(duplicate)).toThrow(/Repeated/);
    const wrongNumber = inventory();
    wrongNumber.objects[1].attributes[1].value.value = 8;
    expect(() => decodeProgramInventory(wrongNumber)).toThrow(/disagree/);
    const orphan = inventory();
    orphan.objects[1].parentRid = null;
    expect(() => decodeProgramInventory(orphan)).toThrow(/outside/);
  });
  it('does not infer protection, class, missing names or missing numbers', () => {
    const evidence = inventory();
    evidence.objects[1].classId = 0xFFFF;
    evidence.objects[2].attributes = [];
    const result = decodeProgramInventory(evidence);
    expect(result.blocks[0]).toMatchObject({ type: 'UNKNOWN', status: 'UNSUPPORTED_BLOCK_CLASS' });
    expect(result.blocks[1]).toMatchObject({ number: null, name: null, status: 'INCOMPLETE_METADATA' });
  });
  it('rejects malformed name and block-number types', () => {
    for (const id of [233, 2521]) {
      const evidence = inventory();
      evidence.objects[1].attributes = [{ id, value: { flags: 0x10, datatype: 21, value: [], raw: Buffer.alloc(0) } }];
      expect(() => decodeProgramInventory(evidence)).toThrow(/scalar|number|encoding/);
    }
  });
  it('retains unknown typed attributes without assuming a reference label is correct', () => {
    const evidence = inventory();
    evidence.objects[1].attributes.push({ id: 2522, value: { flags: 0, datatype: 1, value: true, raw: Buffer.from([0, 1, 1]) } });
    const block = decodeProgramInventory(evidence).blocks[0];
    expect(block.languageCode).toBeNull();
    expect(block.diagnostics).toEqual([]);
    expect(block.nativeAttributes.at(-1)?.value.value).toBe(true);
  });
  it('decodes the independently documented language attribute and reports unknown encodings', () => {
    const evidence = inventory();
    const language = { flags: 0, datatype: 2, value: 3, raw: Buffer.from([0, 2, 3]) };
    evidence.objects[1].attributes.push({ id: 2523, value: language });
    expect(decodeProgramInventory(evidence).blocks[0].languageCode).toBe(3);
    language.flags = 0x10;
    expect(decodeProgramInventory(evidence).blocks[0].diagnostics).toContainEqual(expect.objectContaining({ attributeId: 2523 }));
  });
  it('preserves independently constructed native code-attribute blob bytes including their headers', () => {
    const content = Buffer.from('synthetic-opaque-content');
    const encoded = Buffer.concat([block(0x8A130008, 2579, 8, 'Routine').subarray(0, -1),
      Buffer.from([0xA3]), vlq(2580), Buffer.from([0, 20]), vlq(0), vlq(content.length), content, Buffer.from([0xA2])]);
    const object = decodeObjects(new Cursor(encoded))[0];
    expect(object.attributes.at(-1)?.value).toMatchObject({ datatype: 20, blobRootId: 0, blobLength: content.length, value: content });
    expect(() => decodeObjects(new Cursor(encoded.subarray(0, -2)))).toThrow(/Truncated/);
  });
  it('uses the existing bounded read-only session and leaves the CPU in RUN', async () => {
    const server = await fixture({ metadata: true });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, limits: { maxRequests: 8 } });
    try {
      await client.connect();
      const result = await client.listProgramBlocks();
      expect(result.blocks[0]).toMatchObject({ type: 'DB', number: 7, status: 'IDENTIFIED' });
      expect(result.blockContentRetrieved).toBe(false);
      expect(await client.readCpuState()).toBe('RUN');
      expect(server.requests.slice(5).map(request => request.functionCode)).toEqual([0x04BB, 0x04BB]);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
});

describe('native program event metadata', () => {
  function samples() {
    const program = inventory();
    const root = { rid: 10, classId: 2483, classFlags: 0, attributeId: 0, parentRid: 3,
      attributes: [{ id: 233, value: { flags: 0, datatype: 21, value: 'SWEvents', raw: Buffer.alloc(0) } }] };
    program.objects.push(root);
    const event = { rid: 96, classId: 2059, classFlags: 0, attributeId: 0, parentRid: 10,
      attributes: [{ id: 233, value: { flags: 0, datatype: 21, value: 'ProgramCycle', raw: Buffer.alloc(0) } }],
      relations: [{ id: 2057, targetRid: 0x8A320009 }] };
    return { inventory: decodeProgramInventory(program), evidence: { objectId: 10,
      objects: /** @type {import('../../src/protocol/s7commplus/codec.js').PlusObject[]} */ ([{ ...root, parentRid: null }, event]),
      receivedAt: '2026-01-01T00:00:01.000Z' } };
  }
  it('resolves native links by exact RID without claiming execution or revision identity', () => {
    const sample = samples();
    const result = decodeProgramEventMetadata(sample.inventory, sample.evidence);
    expect(result).toMatchObject({ status: 'BOUNDED_METADATA', atomicSnapshot: false, revisionStatus: 'UNKNOWN',
      blockContentRetrieved: false, relationSemantics: 'UNINTERPRETED_NATIVE_RELATIONS' });
    expect(result.events[0]).toMatchObject({ name: 'ProgramCycle', objectRid: 96, classId: 2059,
      relations: [{ id: 2057, targetRid: 0x8A320009, status: 'RESOLVED_IN_INVENTORY', targetBlock: { type: 'OB', number: 9, name: 'Cycle' } }] });
    expect(result.receivedAt).not.toBe(result.inventoryReceivedAt);
    result.events[0].nativeAttributes[0].value.value = 'Changed';
    expect(sample.evidence.objects[1].attributes[0].value.value).toBe('ProgramCycle');
  });
  it('preserves unknown relation IDs and unresolved targets without following or guessing them', () => {
    const sample = samples();
    sample.evidence.objects[1].relations = [{ id: 0xFFFFFFFE, targetRid: 0x8A320001 }];
    const result = decodeProgramEventMetadata(sample.inventory, sample.evidence);
    expect(result.status).toBe('PARTIAL');
    expect(result.events[0].relations[0]).toMatchObject({ id: 0xFFFFFFFE, targetRid: 0x8A320001, status: 'UNRESOLVED', targetBlock: null });
    expect(result.diagnostics[0].code).toBe('RELATION_TARGET_UNRESOLVED');
  });
  it('keeps missing names and empty relation lists explicit', () => {
    const sample = samples();
    sample.evidence.objects[1].attributes = [];
    sample.evidence.objects[1].relations = [];
    expect(decodeProgramEventMetadata(sample.inventory, sample.evidence)).toMatchObject({ status: 'PARTIAL',
      events: [{ name: null, relations: [] }], diagnostics: [{ code: 'EVENT_NAME_UNAVAILABLE' }] });
  });
  it('rejects unadvertised or mismatched roots, foreign objects, duplicates and malformed names', () => {
    for (const mutate of [
      /** @param {ReturnType<typeof samples>} sample */ sample => { sample.inventory.evidence.objects.pop(); },
      /** @param {ReturnType<typeof samples>} sample */ sample => { sample.evidence.objects[0].classId = 9999; },
      /** @param {ReturnType<typeof samples>} sample */ sample => { sample.evidence.objects[1].parentRid = 3; },
      /** @param {ReturnType<typeof samples>} sample */ sample => { sample.evidence.objects.push(sample.evidence.objects[1]); },
      /** @param {ReturnType<typeof samples>} sample */ sample => { sample.evidence.objects[1].attributes[0].value.flags = 16; },
    ]) {
      const sample = samples(); mutate(sample);
      expect(() => decodeProgramEventMetadata(sample.inventory, sample.evidence)).toThrow();
    }
  });
  it.each([8, 4])('reads fresh inventory and event metadata without writes in native CPU state %i', async state => {
    const server = await fixture({ programEvents: 'present', state });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, limits: { maxRequests: 10 } });
    try {
      await client.connect();
      const before = server.requests.length;
      const result = await client.readProgramEventMetadata({ maxEvents: 16 });
      expect(result.events[0].relations[0]).toMatchObject({ status: 'RESOLVED_IN_INVENTORY', targetBlock: { type: 'OB', number: 9, name: 'Cycle' } });
      expect(result.artifactClass).toBe('PROGRAM_EVENT_METADATA');
      await client.readProgramEventMetadata();
      expect(server.requests.slice(before).map(request => [request.functionCode, request.frame.readUInt32BE(18)]))
        .toEqual([[0x04BB, 3], [0x04BB, 10], [0x04BB, 3], [0x04BB, 10]]);
      expect(client.report.productionReadOnly).toBe(true);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
  it('does not query an unadvertised container or turn its absence into an empty successful snapshot', async () => {
    const server = await fixture({ programEvents: 'missing' });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port });
    try {
      await client.connect();
      const before = server.requests.length;
      expect(await client.readProgramEventMetadata()).toMatchObject({ status: 'NOT_REPORTED_IN_INVENTORY', events: [], evidence: null });
      expect(server.requests.slice(before).map(request => request.frame.readUInt32BE(18))).toEqual([3]);
    } finally { await client.disconnect(); await server.close(); }
  });
  it('keeps unresolved links partial and stops on a mismatched reply', async () => {
    for (const mode of /** @type {const} */ (['unresolved', 'mismatch'])) {
      const server = await fixture({ programEvents: mode });
      const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port });
      try {
        await client.connect();
        if (mode === 'unresolved') expect(await client.readProgramEventMetadata()).toMatchObject({ status: 'PARTIAL', events: [{ relations: [{ targetBlock: null }] }] });
        else {
          await expect(client.readProgramEventMetadata()).rejects.toMatchObject({ code: 'METADATA_MISMATCH' });
          expect(client.report.failure?.code).toBe('METADATA_MISMATCH');
        }
        expect(server.errors).toEqual([]);
      } finally { await client.disconnect(); await server.close(); }
    }
  });
  it('rejects invalid limits before sending metadata requests', async () => {
    const server = await fixture({ programEvents: 'present' });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port });
    try {
      await client.connect();
      const before = server.requests.length;
      for (const maxEvents of [0, 129, 1.5, NaN]) await expect(client.readProgramEventMetadata({ maxEvents })).rejects.toMatchObject({ code: 'ARGUMENT' });
      expect(server.requests).toHaveLength(before);
      expect(client.report.failure).toBeNull();
    } finally { await client.disconnect(); await server.close(); }
  });
  it('enforces explicit event limits instead of silently dropping objects', () => {
    const sample = samples();
    sample.evidence.objects.push({ ...sample.evidence.objects[1], rid: 107 });
    expect(() => decodeProgramEventMetadata(sample.inventory, sample.evidence, 1)).toThrow(/maxEvents/);
    for (const limit of [0, 129, 1.5, NaN]) expect(() => decodeProgramEventMetadata(sample.inventory, sample.evidence, limit)).toThrow(/maxEvents/);
  });
});

describe('bounded content-value decoding', () => {
  it('preserves sparse BLOB keys, roots, declared sizes, binary data and the terminator', () => {
    const bytes = Buffer.from([0x40, 20, 3, 0, 3, 0, 0xFF, 2, 9, 1, 2, 3, 4, 0]);
    const cursor = new Cursor(bytes);
    expect(decodeValue(cursor)).toMatchObject({ flags: 0x40, datatype: 20, raw: bytes, value: [
      { key: 3, blobRootId: 0, byteCount: 3, bytes: Buffer.from([0, 0xFF, 2]) },
      { key: 9, blobRootId: 1, byteCount: 2, bytes: Buffer.from([3, 4]) },
    ] });
    expect(cursor.offset).toBe(bytes.length);
  });
  it('rejects truncated data, missing sparse terminators, duplicate keys and unqualified extended formats', () => {
    for (const bytes of [
      [0x40, 20, 1, 0, 9, 1], [0x40, 20, 1, 0, 1, 9], [0x40, 20, 1, 0, 0, 1, 0, 0, 0],
      [0x40, 21, 0], [0, 20, 3, 0],
    ]) expect(() => decodeValue(new Cursor(Buffer.from(bytes)))).toThrow();
  });
  it('counts actual protocol fragments rather than TCP or TLS records', () => {
    const assembler = new PlusAssembler();
    assembler.feed(Buffer.from('720200026162720200016372020000', 'hex'));
    expect(assembler.lastMessageFragmentCount).toBe(2);
  });
});

describe('qualified native block-content extraction', () => {
  function evidence() {
    const content = Buffer.from('synthetic-compiled-component');
    const encoded = Buffer.concat([block(0x8A130008, 2579, 8, 'Routine').subarray(0, -1),
      Buffer.from([0xA3]), vlq(2580), Buffer.from([0, 20, 0]), vlq(content.length), content, Buffer.from([0xA2])]);
    return { objects: decodeObjects(new Cursor(encoded)), receivedAt: '2026-01-01T00:00:00.000Z',
      correlation: { fragmentCount: 2, responseBody: encoded } };
  }
  it('extracts byte-identical opaque content but never claims a complete or restorable controller', () => {
    const selected = decodeProgramInventory(inventory()).blocks[1];
    const result = decodeBlockContent(selected, evidence());
    expect(result).toMatchObject({ status: 'CODE_CONTENT_RETRIEVED', artifactClass: 'BLOCK_CONTENT', byteCount: 28,
      transfer: { protocolFragmentCount: 2 }, restorable: false });
    expect(result.rawBytes).toEqual(Buffer.from('synthetic-compiled-component'));
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ name: 'FC8-code-block.bin', format: 'BLOB_PAYLOAD',
      component: 'CODE_BLOCK', attributeId: 2580, byteCount: 28, sha256: result.sha256,
      block: { type: 'FC', number: 8, objectRid: 0x8A130008 } });
    expect(result.files[0].bytes).toEqual(result.rawBytes);
    expect(result.files[0].nativeAttribute).toEqual(result.components[0].rawAttribute);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(decodeBlockContent(selected, evidence()).sha256).toBe(result.sha256);
    expect(result.components.find(component => component.role === 'BODY_DESCRIPTION')?.status).toBe('ABSENT');
  });
  it('does not treat empty code or arbitrary metadata as successful compiled-content uploads', () => {
    const selected = decodeProgramInventory(inventory()).blocks[1];
    const response = evidence();
    response.objects[0].attributes = response.objects[0].attributes.filter(attribute => attribute.id !== 2580);
    expect(decodeBlockContent(selected, response)).toMatchObject({ status: 'UNAVAILABLE', byteCount: 0, sha256: null, rawBytes: null, files: [] });
  });
  it('preserves sparse containers and unsupported native values as opaque files', () => {
    const selected = decodeProgramInventory(inventory()).blocks[1];
    const response = evidence();
    const sparse = Buffer.from([0x40, 20, 1, 0, 1, 0xAA, 2, 0, 1, 0xBB, 0]);
    response.objects[0].attributes.push({ id: 2533, value: decodeValue(new Cursor(sparse)) });
    const opaque = Buffer.from([0, 4, 42]);
    response.objects[0].attributes.push({ id: 2582, value: decodeValue(new Cursor(opaque)) });
    const result = decodeBlockContent(selected, response);
    expect(result.files.find(file => file.attributeId === 2533)).toMatchObject({
      format: 'NATIVE_PVALUE', bytes: sparse, nativeAttribute: sparse, byteCount: sparse.length,
    });
    expect(result.files.find(file => file.attributeId === 2582)).toMatchObject({
      status: 'UNSUPPORTED_ENCODING', format: 'NATIVE_PVALUE', bytes: opaque, nativeAttribute: opaque,
    });
    expect(result.files.every(file => !file.name.includes('/') && !file.name.includes('\\'))).toBe(true);
  });
  it('rejects mismatched identities, duplicate attributes and foreign objects', () => {
    const selected = decodeProgramInventory(inventory()).blocks[1];
    const response = evidence();
    response.objects[0].rid++;
    expect(() => decodeBlockContent(selected, response)).toThrow(/foreign/);
    const duplicate = evidence();
    duplicate.objects[0].attributes.push(duplicate.objects[0].attributes[0]);
    expect(() => decodeBlockContent(selected, duplicate)).toThrow(/Repeated/);
    const renamed = evidence();
    renamed.objects[0].attributes[0].value.value = 'Another';
    expect(() => decodeBlockContent(selected, renamed)).toThrow(/differs/);
  });
  it('does not enable program extraction through plaintext sessions', async () => {
    const server = await fixture({ metadata: true });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port });
    try {
      await client.connect();
      await expect(client.uploadProgramBlock({ type: 'DB', number: 7 })).rejects.toMatchObject({ code: 'SECURITY_REQUIRED' });
      expect(server.requests).toHaveLength(5);
    } finally { await client.disconnect(); await server.close(); }
  });
});

describe('central operation policy', () => {
  it.each(['initSSL', 'createSession', 'setupSession', 'explore', 'read', 'readAttribute'])('allows only qualified operation %s', kind => {
    expect(getOperationPolicy(kind).allowed).toBe(true);
  });
  it.each(['cpuStop', 'cpuStart', 'cpuControl', 'write', 'download', 'delete', 'force', 'setSecurity',
    'uploadProgramBlock', 'controllerBackup', 'unknown', '__proto__', 'constructor', 'toString'])('denies %s before serialization', kind => {
    expect(getOperationPolicy(kind).allowed).toBe(false);
    expect(() => encodeOperation({ kind }, { version: 2, sessionId: 77 }, 0)).toThrow(/not allowlisted/);
  });
  it('qualifies only the exact bounded program-content attribute operation', () => {
    const operation = { kind: 'readBlockContent', objectId: 0x8A130008, attributes: [...BLOCK_CONTENT_ATTRIBUTES] };
    expect(getOperationPolicy(operation.kind).classification).toBe('READ_ONLY_RESOURCE_BOUNDED_PROGRAM_CONTENT');
    expect(() => encodeOperation(operation, { version: 2, sessionId: 77, integrityId: 1 }, 5)).not.toThrow();
    for (const changed of [{ objectId: 3 }, { recursive: true }, { attributes: [2580] }]) {
      expect(() => encodeOperation({ ...operation, ...changed }, { version: 2, sessionId: 77 }, 5)).toThrow(/qualified/);
    }
  });
  it.each([
    { mode: 'stop-required-backup' }, { mode: 'stop-required-backup', yes: true },
    { mode: 'stop-required-backup', force: true }, { mode: 'stop-required-backup', confirmation: 'SAVED' },
    { mode: 'stop-required-backup', challenge: 'EXPIRED' }, { mode: 'stop-required-backup', target: 'DIFFERENT' },
    { mode: 'run', stop: true }, { mode: 'run', start: true }, { mode: 'run', assumeYes: true },
    { mode: 'run', confirmation: 'AGENT_GENERATED' }, { mode: 'run', authorization: { approved: true } },
  ])('never accepts automatic or fabricated mode authorization %j', async options => {
    const client = new S7CommPlusClient({ host: '127.0.0.1' });
    await expect(Reflect.apply(client.uploadProgram, client, [options])).rejects.toMatchObject({
      code: options.mode === 'stop-required-backup' ? 'EXPLICIT_CPU_STOP_CONFIRMATION_REQUIRED' : 'READ_ONLY_DENIED',
    });
    expect(client.report.statistics.sentBytes).toBe(0);
    expect(client.report.capabilities.cpuModeControl).toBe('DENIED');
  });
});
