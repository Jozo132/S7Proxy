// @ts-check
import { describe, it, expect, vi } from 'vitest';
import { Cursor, decodeObjects, decodeValue, encodeOperation, planReadBatches } from '../../src/protocol/s7commplus/codec.js';
import { buildBlockMembers, validateMemberValue, memberValueSize } from '../../src/protocol/s7commplus/type-info.js';
import * as typeInfo from '../../src/protocol/s7commplus/type-info.js';
import { S7CommPlusClient } from '../../src/lib.js';
import { fixture } from '../s7commplus-fixture.js';
import { typeObject, syntheticMembers, le32 } from '../s7commplus-metadata-fixture.js';

const root = 0x92000007;
const child = 0x92000009;
const block = { type: /** @type {const} */ ('DB'), number: 7, name: 'SampleDB', objectRid: 0x8A0E0007, typeInfoId: root, status: 'TYPE_REFERENCE_RESOLVED', evidence: {} };
const objects = () => decodeObjects(new Cursor(Buffer.concat([typeObject(root, syntheticMembers), typeObject(child, [{ name: 'Ready', lid: 132, type: 1 }])])));

describe('symbolic read batch planning', () => {
  /** @param {number} count @param {number} [depth] */
  const addresses = (count, depth = 2) => Array.from({ length: count }, (_, index) => ({
    accessArea: 0x8A0E0007, lids: Array.from({ length: depth }, (_, part) => part ? index + 1 : 1), symbolCrc: 0,
  }));
  it('packs thousands of scalars without reordering or dropping indices', () => {
    const items = addresses(4096);
    const batches = planReadBatches(items, items.map(() => 11), { sessionId: 77, version: 2, integrityId: 1 }, { maxRequestBytes: 900, maxResponseBytes: 65536 });
    expect(batches).toHaveLength(128);
    expect(batches.every(batch => batch.length === 32)).toBe(true);
    expect(batches.flat()).toEqual(items.map((_, index) => index));
  });
  it.each([48, 64])('packs explicitly larger %i-item batches within byte limits', maxItems => {
    const items = addresses(4096);
    for (const sessionKey of [undefined, Buffer.alloc(24, 35)]) {
      const context = { sessionId: 77, version: sessionKey ? 1 : 2, sessionKey, integrityId: 0xFFFFFFFF };
      const batches = planReadBatches(items, items.map(() => 11), context, { maxItems, maxRequestBytes: 900, maxResponseBytes: 65536 });
      expect(batches).toHaveLength(Math.ceil(items.length / maxItems));
      expect(batches.flat()).toEqual(items.map((_, index) => index));
      for (const batch of batches) expect(encodeOperation({ kind: 'read', maxItems, items: batch.map(index => items[index]) }, context, 65535).length).toBeLessThanOrEqual(900);
      expect(() => encodeOperation({ kind: 'read', items: items.slice(0, 33) }, context, 1)).toThrow(/1..32/);
    }
  });
  it.each([false, true])('reserves changing integrity-counter widths and complete framing (legacy=%s)', legacy => {
    const items = addresses(75, 16);
    const context = { sessionId: 77, version: legacy ? 1 : 2, integrityId: 0xFFFFFFFF,
      sessionKey: legacy ? Buffer.alloc(24, 35) : undefined };
    const batches = planReadBatches(items, items.map(() => 11), context, { maxRequestBytes: 250, maxResponseBytes: 65536 });
    expect(batches.length).toBeGreaterThan(3);
    for (const batch of batches) expect(encodeOperation({ kind: 'read', items: batch.map(index => items[index]) }, context, 65535).length).toBeLessThanOrEqual(250);
    expect(batches.flat()).toEqual(items.map((_, index) => index));
  });
  it('splits on estimated response bytes even when request space remains', () => {
    const items = addresses(10);
    const batches = planReadBatches(items, items.map(() => 3), { sessionId: 77, version: 2 }, { maxRequestBytes: 900, maxResponseBytes: 140 });
    expect(batches.map(batch => batch.length)).toEqual([3, 3, 3, 1]);
  });
  it('rejects invalid estimates and individually oversized items before transmission', () => {
    const context = { sessionId: 77, version: 2 };
    expect(() => planReadBatches(addresses(1), [], context, { maxRequestBytes: 900, maxResponseBytes: 65536 })).toThrow(/scalar value sizes/);
    expect(() => planReadBatches(addresses(1, 16), [11], context, { maxRequestBytes: 60, maxResponseBytes: 65536 })).toThrow(/request-byte budget/);
    expect(() => planReadBatches(addresses(1), [11], context, { maxRequestBytes: 900, maxResponseBytes: 139 })).toThrow(/response-byte budget/);
  });
});

describe('native type metadata', () => {
  it('decodes native identities independently of names, software types and offsets', () => {
    const result = objects();
    expect(result[0].typeMembers?.[0]).toMatchObject({ lid: 101, symbolCrc: 0x10203040, softdatatype: 1, offset: { code: 8 } });
    const discovery = buildBlockMembers(block, result);
    expect(discovery.completeness).toBe('COMPLETE');
    expect(discovery.members.find(member => member.path === 'Details.Ready')).toMatchObject({ parentPath: 'Details', memberId: 132, typeInfoId: child, accessPath: [120, 132], readable: true });
    expect(discovery.members.find(member => member.path === 'Samples[-1]')).toMatchObject({ accessPath: [125, 1], datatype: 'INT' });
  });
  it('preserves repeated containing-instance context', () => {
    const types = decodeObjects(new Cursor(Buffer.concat([typeObject(root, [
      { name: 'First', lid: 10, type: 17, code: 12, relation: child },
      { name: 'Second', lid: 20, type: 17, code: 15, relation: child },
    ]), typeObject(child, [{ name: 'Value', lid: 5, type: 5 }])])));
    const members = buildBlockMembers(block, types).members;
    expect(members.find(member => member.path === 'First.Value')?.accessPath).toEqual([10, 5]);
    expect(members.find(member => member.path === 'Second.Value')?.accessPath).toEqual([20, 5]);
  });
  it('constructs multidimensional and struct-array element paths with ordinal addressing', () => {
    const types = decodeObjects(new Cursor(Buffer.concat([typeObject(root, [
      { name: 'Matrix', lid: 40, type: 5, code: 11, dimensions: [{ lowerBound: -1, count: 2 }, { lowerBound: 3, count: 2 }] },
      { name: 'Items', lid: 50, type: 17, code: 13, relation: child, lower: 1, count: 2 },
    ]), typeObject(child, [{ name: 'Value', lid: 5, type: 5 }])])));
    const members = buildBlockMembers(block, types).members;
    expect(members.find(member => member.path === 'Matrix[0,3]')?.accessPath).toEqual([40, 2]);
    expect(members.find(member => member.path === 'Items[2].Value')?.accessPath).toEqual([50, 1, 1, 5]);
  });
  it('does not claim readability for unknown, missing, ambiguous, recursive or reference-backed types', () => {
    const types = decodeObjects(new Cursor(typeObject(root, [
      { name: 'Unknown', lid: 1, type: 255 }, { name: 'Reference', lid: 2, type: 20 },
      { name: 'Missing', lid: 3, type: 17, code: 12, relation: child },
      { name: 'Cycle', lid: 4, type: 17, code: 12, relation: root },
      { name: 'Duplicate', lid: 5, type: 1 }, { name: 'Duplicate', lid: 6, type: 1 },
    ])));
    const result = buildBlockMembers(block, types);
    expect(result.completeness).toBe('PARTIAL');
    expect(result.members.every(member => !member.readable)).toBe(true);
    expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(['TYPE_UNAVAILABLE', 'RECURSIVE_TYPE']));
  });
  it('bounds expansion and never substitutes partial names or leaf-only paths', () => {
    const types = objects();
    types[0].memberNames?.pop();
    expect(buildBlockMembers(block, types).members).toEqual([]);
    expect(() => buildBlockMembers(block, objects(), 2)).toThrow(/budget/);
    expect(() => buildBlockMembers(block, objects(), 0)).toThrow(/budget/);
  });
  it('keeps literal dotted names ambiguous with structurally identical display paths', () => {
    const types = decodeObjects(new Cursor(Buffer.concat([typeObject(root, [
      { name: 'A.B', lid: 1, type: 1 }, { name: 'A', lid: 2, type: 17, code: 12, relation: child },
    ]), typeObject(child, [{ name: 'B', lid: 3, type: 1 }])])));
    const members = buildBlockMembers(block, types).members.filter(member => member.path === 'A.B');
    expect(members).toHaveLength(2);
    expect(members.every(member => member.status === 'AMBIGUOUS' && !member.readable)).toBe(true);
  });
  it('distinguishes a missing member name from ambiguous duplicate names', () => {
    const types = decodeObjects(new Cursor(typeObject(root, [{ name: '', lid: 1, type: 1 }])));
    expect(buildBlockMembers(block, types).members[0]).toMatchObject({ name: null, path: null, status: 'NAME_UNAVAILABLE', readable: false });
  });
  it.each(Array.from({ length: 16 }, (_, code) => code))('consumes offset-info variant %i without crossing list boundaries', code => {
    const bytes = typeObject(root, [{ name: 'Field', lid: 100, type: 5, code,
      dimensions: [{ lowerBound: -2, count: 2 }, { lowerBound: 3, count: 2 }] }]);
    const decoded = decodeObjects(new Cursor(bytes))[0];
    expect(decoded.memberNames).toEqual(['Field']);
    expect(decoded.typeMembers?.[0].offset.code).toBe(code);
  });
  it('rejects truncated metadata, duplicate lists and invalid name terminators', () => {
    const bytes = typeObject(root, syntheticMembers);
    for (const end of [10, 20, bytes.length - 5]) expect(() => decodeObjects(new Cursor(bytes.subarray(0, end)))).toThrow();
    const duplicate = Buffer.concat([bytes.subarray(0, -1), Buffer.from([0xAC, 0, 0, 0xA2])]);
    expect(() => decodeObjects(new Cursor(duplicate))).toThrow(/Duplicate/);
    const corrupt = Buffer.from(bytes);
    corrupt[corrupt.indexOf(Buffer.from('Enabled')) + 7] = 1;
    expect(() => decodeObjects(new Cursor(corrupt))).toThrow(/terminated/);
  });
  it('handles multi-block type lists without treating FirstId as a member count', () => {
    const member = typeObject(root, [{ name: 'A', lid: 1000, type: 1 }]);
    const start = member.indexOf(0xAB) + 1;
    const entry = member.subarray(start + 6, start + 6 + 16);
    const head = member.subarray(0, start);
    const names = Buffer.from([0xAC, 0, 6, 1, 65, 0, 1, 66, 0, 0, 0, 0xA2]);
    const second = Buffer.from(entry); le32(1001).copy(second);
    const bytes = Buffer.concat([head, Buffer.from([0, 20]), le32(999), entry, Buffer.from([0, 16]), second, Buffer.from([0, 0]), names]);
    const decoded = decodeObjects(new Cursor(bytes))[0];
    expect(decoded.firstMemberId).toBe(999);
    expect(decoded.typeMembers?.map(value => value.lid)).toEqual([1000, 1001]);
  });
  it('validates BOOL, signed INT and TIME independently of software datatype numbers', () => {
    const members = buildBlockMembers(block, objects()).members;
    const enabled = /** @type {NonNullable<typeof members[number]>} */ (members.find(member => member.path === 'Enabled'));
    const count = /** @type {NonNullable<typeof members[number]>} */ (members.find(member => member.path === 'Count'));
    const time = /** @type {NonNullable<typeof members[number]>} */ (members.find(member => member.path === 'Delay'));
    expect(validateMemberValue(enabled, decodeValue(new Cursor(Buffer.from([0, 1, 0])))).value).toBe(false);
    expect(validateMemberValue(count, decodeValue(new Cursor(Buffer.from([0, 7, 0xFF, 0x85])))).value).toBe(-123);
    expect(validateMemberValue(time, decodeValue(new Cursor(Buffer.from([0, 8, 0x7F]))))).toMatchObject({ value: -1, representation: { unit: 'ms', bits: 32, signed: true } });
    expect(() => validateMemberValue(enabled, decodeValue(new Cursor(Buffer.from([0, 8, 1]))))).toThrow(/match/);
    expect(() => decodeValue(new Cursor(Buffer.from([0, 1, 2])))).toThrow(/BOOL/);
  });
  it('validates bounded S7 STRING headers, empty values and response-size estimates', () => {
    const member = buildBlockMembers(block, objects()).members.find(candidate => candidate.path === 'Title');
    if (!member) throw new Error('Missing synthetic STRING');
    const native = decodeValue(new Cursor(Buffer.from([0x10, 2, 10, 8, 4, 84, 69, 83, 84, 0, 0, 0, 0])));
    expect(validateMemberValue(member, native)).toMatchObject({ datatype: 'STRING', value: 'TEST', representation: { encoding: 'latin1', maxLength: 8, length: 4 } });
    expect(validateMemberValue(member, { ...native, value: [8, 0, ...Array(8).fill(0)] }).value).toBe('');
    expect(memberValueSize(member)).toBe(260);
    for (const value of [[], [8, 9, ...Array(8).fill(0)], [8, 1, 65], [255, 0, ...Array(255).fill(0)], [1, 1, 256]]) {
      expect(() => validateMemberValue(member, { ...native, value })).toThrow(/capacity and length/);
    }
    expect(() => validateMemberValue(member, { ...native, flags: 0 })).toThrow(/capacity and length/);
    expect(() => validateMemberValue(member, { ...native, datatype: 21 })).toThrow(/capacity and length/);
    const items = Array.from({ length: 5 }, () => ({ accessArea: block.objectRid, lids: member.accessPath }));
    expect(planReadBatches(items, items.map(() => memberValueSize(member)), { sessionId: 77, version: 2 }, { maxRequestBytes: 900, maxResponseBytes: 700 }).map(batch => batch.length)).toEqual([2, 2, 1]);
  });
  it('distinguishes LTIME timespans from LINT wire values and retains 64-bit precision', () => {
    const types = decodeObjects(new Cursor(typeObject(root, [{ name: 'Duration', lid: 1, type: 64 }])));
    const member = buildBlockMembers(block, types).members[0];
    expect(validateMemberValue(member, decodeValue(new Cursor(Buffer.from([0, 17, 0x7F]))))).toMatchObject({ value: '-1', representation: { unit: 'ns', bits: 64 } });
    expect(() => validateMemberValue(member, decodeValue(new Cursor(Buffer.from([0, 9, 0x7F]))))).toThrow(/match/);
  });
});

describe('native I/Q/M area discovery', () => {
  it('resolves native area type references without browsing DBs', async () => {
    const server = await fixture({ metadata: true });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, limits: { maxRequests: 30, readPacingMs: 10 } });
    try {
      await client.connect();
      for (const [type, objectRid, typeInfoId] of /** @type {const} */ ([['I', 80, 0x90010000], ['Q', 81, 0x90020000], ['M', 82, 0x90030000]])) {
        const area = await client.getAreaMetadata({ type });
        expect(area).toMatchObject({ type, name: type, objectRid, typeInfoId, status: 'TYPE_REFERENCE_RESOLVED' });
        const discovery = await client.listAreaMembers({ type });
        expect(discovery.area).toEqual(area);
        expect(discovery.members).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'Enabled', readable: true, datatype: 'BOOL' })]));
        const selected = ['Enabled', 'Count', 'Details.Ready', 'Samples[-1]', 'Title'].map(path => {
          const member = discovery.members.find(candidate => candidate.path === path && candidate.readable);
          if (!member) throw new Error('Missing synthetic area member');
          return member;
        });
        expect(await client.readMember(selected[0])).toMatchObject({ block: { type, objectRid },
          runtime: { objectRid, typeInfoId, accessPath: [101], symbolCrc: 0 }, observation: { value: true, quality: 'GOOD' } });
        expect(await client.readSymbol(`${type}.Details.Ready`)).toMatchObject({ runtime: { objectRid, accessPath: [120, 132] } });
        expect((await client.readMembers(selected, { maxItems: 2 })).map(result => result.observation.value)).toEqual([true, -123, true, -123, 'TEST']);
      }
      expect(server.requests.some(request => request.functionCode === 0x04BB && request.frame.readUInt32BE(18) === 3)).toBe(false);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });

  it('rejects invalid area selectors and discovery budgets before transmission', async () => {
    const server = await fixture({ metadata: true });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port });
    try {
      await client.connect();
      const before = server.requests.length;
      for (const selector of [null, undefined, 'I', {}, { type: 'DB', number: 7 }, { type: 'i' }, { type: 'I', number: 0 }, { type: 'constructor' }, { type: '__proto__' }]) {
        await expect(client.getAreaMetadata(/** @type {any} */ (selector))).rejects.toMatchObject({ code: 'ARGUMENT' });
        await expect(client.listAreaMembers(/** @type {any} */ (selector))).rejects.toMatchObject({ code: 'ARGUMENT' });
      }
      for (const options of [null, [], { maxTypes: 0 }, { maxTypes: 65537 }, { maxTypes: 1.5 }, { maxMembers: 0 }, { maxMembers: 1048577 }, { recursive: false }]) {
        await expect(client.listAreaMembers({ type: 'I' }, /** @type {any} */ (options))).rejects.toMatchObject({ code: 'ARGUMENT' });
      }
      expect(server.requests).toHaveLength(before);
      expect(client.connected).toBe(true);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });

  it('isolates cached area metadata, budgets and name bindings from DBs and other areas', async () => {
    const server = await fixture({ metadata: true });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, limits: { maxRequests: 40, readPacingMs: 10 } });
    try {
      await client.connect();
      const selector = { type: /** @type {'I'|'Q'|'M'} */ ('I') };
      const pending = client.getAreaMetadata(selector);
      selector.type = 'Q';
      const metadata = await pending;
      expect(metadata).toMatchObject({ type: 'I', objectRid: 80 });
      metadata.objectRid = 999;
      expect(await client.getAreaMetadata({ type: 'I' })).toMatchObject({ type: 'I', objectRid: 80 });
      const first = await client.listAreaMembers({ type: 'I' });
      await client.listAreaMembers({ type: 'Q' });
      await client.listAreaMembers({ type: 'M' });
      await client.listBlockMembers({ type: 'DB', number: 7 });
      const before = server.requests.length;
      first.area.typeInfoId = 999;
      first.members[0].accessPath[0] = 999;
      first.members[0].path = 'tampered';
      const cached = await client.listAreaMembers({ type: 'I' });
      expect(cached.area.typeInfoId).toBe(0x90010000);
      expect(cached.members[0]).toMatchObject({ path: 'Enabled', accessPath: [101] });
      expect(cached.receivedAt).toBe(first.receivedAt);
      expect(server.requests).toHaveLength(before);
      const partial = await client.listAreaMembers({ type: 'I' }, { maxTypes: 1 });
      expect(partial.completeness).toBe('PARTIAL');
      expect(partial.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'TYPE_UNAVAILABLE', typeInfoId: child })]));
      await expect(client.listAreaMembers({ type: 'I' }, { maxMembers: 1 })).rejects.toMatchObject({ code: 'RESPONSE_LIMIT' });
      for (const name of ['I.Enabled', 'Q.Enabled', 'M.Enabled', 'SampleDB.Enabled']) {
        expect(await client.readSymbol(name)).toMatchObject({ observation: { value: true, quality: 'GOOD' } });
      }
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });

  it('keeps area descriptors session-owned and supports mixed DB/area batches', async () => {
    const server = await fixture({ metadata: true });
    const options = { host: '127.0.0.1', port: server.port, limits: { maxRequests: 30, readPacingMs: 10 } };
    const client = new S7CommPlusClient(options);
    const other = new S7CommPlusClient(options);
    try {
      await client.connect();
      await other.connect();
      const area = await client.listAreaMembers({ type: 'I' });
      const db = await client.listBlockMembers({ type: 'DB', number: 7 });
      const member = area.members.find(candidate => candidate.path === 'Enabled' && candidate.readable);
      const dbMember = db.members.find(candidate => candidate.path === 'Count' && candidate.readable);
      if (!member || !dbMember) throw new Error('Missing synthetic member');
      const before = server.requests.length;
      await expect(other.readMember(member)).rejects.toMatchObject({ code: 'UNVERIFIED_ADDRESS' });
      await expect(other.readMembers([member])).rejects.toMatchObject({ code: 'UNVERIFIED_ADDRESS' });
      await expect(client.readMember({ ...member })).rejects.toMatchObject({ code: 'UNVERIFIED_ADDRESS' });
      expect(server.requests).toHaveLength(before);
      member.accessPath[0] = 999;
      expect((await client.readMembers([member, dbMember])).map(result => result.observation.value)).toEqual([true, -123]);
      expect(server.requests).toHaveLength(before + 1);
      const request = server.requests.at(-1);
      if (!request) throw new Error('Missing mixed read request');
      const cursor = new Cursor(request.frame.subarray(18, -4));
      cursor.uint32();
      const count = cursor.uint();
      cursor.uint();
      const addresses = Array.from({ length: count }, () => {
        const symbolCrc = cursor.uint();
        const accessArea = cursor.uint();
        const pathLength = cursor.uint() - 1;
        const accessSubArea = cursor.uint();
        return { symbolCrc, accessArea, accessSubArea, lids: Array.from({ length: pathLength }, () => cursor.uint()) };
      });
      expect(addresses).toEqual([
        { symbolCrc: 0, accessArea: 80, accessSubArea: 3736, lids: [101] },
        { symbolCrc: 0, accessArea: 0x8A0E0007, accessSubArea: 2550, lids: [107] },
      ]);
      await client.disconnect();
      await expect(client.readMember(member)).rejects.toMatchObject({ code: 'SESSION_REQUIRED' });
      await expect(client.getAreaMetadata({ type: 'I' })).rejects.toMatchObject({ code: 'SESSION_REQUIRED' });
      await expect(client.listAreaMembers({ type: 'I' })).rejects.toMatchObject({ code: 'SESSION_REQUIRED' });
      expect(other.connected).toBe(true);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await other.disconnect(); await server.close(); }
  });

  it('explores area metadata in STOP but denies process-value reads without traffic', async () => {
    const server = await fixture({ metadata: true, state: 4 });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port });
    try {
      await client.connect();
      const discovery = await client.listAreaMembers({ type: 'M' });
      const member = discovery.members.find(candidate => candidate.path === 'Enabled' && candidate.readable);
      if (!member) throw new Error('Missing synthetic area member');
      expect(client.report.capabilities).toMatchObject({ areaExplore: true, symbolicLidRead: false });
      const before = server.requests.length;
      await expect(client.readMember(member)).rejects.toMatchObject({ code: 'CPU_STATE' });
      await expect(client.readMembers([member])).rejects.toMatchObject({ code: 'CPU_STATE' });
      await expect(client.readSymbol('M.Enabled')).rejects.toMatchObject({ code: 'CPU_STATE' });
      expect(server.requests).toHaveLength(before);
      expect(client.connected).toBe(true);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });

  it.each([
    { option: { areaReference: /** @type {const} */ ('zero') }, status: 'TYPE_UNAVAILABLE' },
    { option: { areaTypeMissing: true }, status: 'TYPE_REFERENCE_RESOLVED' },
  ])('reports unavailable area types as partial without fabricating addresses: $status', async ({ option, status }) => {
    const server = await fixture({ metadata: true, ...option });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port });
    try {
      await client.connect();
      const discovery = await client.listAreaMembers({ type: 'I' });
      expect(discovery.area.status).toBe(status);
      expect(discovery.completeness).toBe('PARTIAL');
      expect(discovery.members).toEqual([]);
      expect(discovery.diagnostics).toEqual([expect.objectContaining({ code: 'TYPE_UNAVAILABLE' })]);
      await expect(client.readSymbol('I.Enabled')).rejects.toMatchObject({ code: 'SYMBOL_UNAVAILABLE' });
      expect(client.connected).toBe(true);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });

  it.each([
    { areaReference: /** @type {const} */ ('invalid'), code: 'DATATYPE_MISMATCH' },
    { areaReference: /** @type {const} */ ('missing'), code: 'ITEM_REJECTED' },
  ])('fails closed on invalid/rejected area references: $code', async ({ areaReference, code }) => {
    const server = await fixture({ metadata: true, areaReference });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port });
    try {
      await client.connect();
      await expect(client.listAreaMembers({ type: 'I' })).rejects.toMatchObject({ code });
      expect(client.connected).toBe(false);
      expect(client.report.failure?.code).toBe(code);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
});

describe('public native discovery and qualified reads', () => {
  it('switches larger batch profiles on the same cached structure without changing value order', async () => {
    const server = await fixture({ metadata: true });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, limits: { maxRequests: 80, readPacingMs: 10 } });
    try {
      await client.connect();
      const discovery = await client.listBlockMembers({ type: 'DB', number: 7 });
      const member = discovery.members.find(candidate => candidate.path === 'Enabled' && candidate.readable);
      if (!member) throw new Error('Missing synthetic member');
      const members = Array(130).fill(member);
      for (const maxItems of [32, 48, 64, 32]) {
        const before = server.requests.length;
        for (let scan = 0; scan < 2; scan++) {
          const results = await client.readMembers(members, { maxItems });
          expect(results).toHaveLength(members.length);
          expect(results.every(result => result.observation.value === true)).toBe(true);
        }
        expect(server.requests.length - before).toBe(2 * Math.ceil(members.length / maxItems));
      }
      const before = server.requests.length;
      for (const maxItems of [0, 65, 1.5]) await expect(client.readMembers(members, { maxItems })).rejects.toMatchObject({ code: 'ARGUMENT' });
      expect(server.requests).toHaveLength(before);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
  it('caches expanded structures without trusting caller mutations or bypassing discovery budgets', async () => {
    const build = vi.spyOn(typeInfo, 'buildBlockMembers');
    const server = await fixture({ metadata: true });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, limits: { maxRequests: 40, readPacingMs: 10 } });
    try {
      await client.connect();
      const first = await client.listBlockMembers({ type: 'DB', number: 7 });
      expect(build).toHaveBeenCalledTimes(1);
      const requests = server.requests.length;
      first.members[0].path = 'tampered';
      const second = await client.listBlockMembers({ type: 'DB', number: 7 });
      expect(build).toHaveBeenCalledTimes(1);
      expect(server.requests).toHaveLength(requests);
      expect(second.receivedAt).toBe(first.receivedAt);
      expect(second.members[0].path).toBe('Enabled');
      expect(second.members).not.toBe(first.members);
      const member = second.members.find(candidate => candidate.path === 'Enabled' && candidate.readable);
      if (!member) throw new Error('Missing cached synthetic member');
      expect(await client.readMembers([member])).toMatchObject([{ observation: { value: true, quality: 'GOOD' } }]);
      await expect(client.listBlockMembers({ type: 'DB', number: 7 }, { maxMembers: 1 })).rejects.toMatchObject({ code: 'RESPONSE_LIMIT' });
      expect(build).toHaveBeenCalledTimes(2);
      await client.listBlockMembers({ type: 'DB', number: 7 });
      expect(build).toHaveBeenCalledTimes(2);
      expect(server.errors).toEqual([]);
    } finally { build.mockRestore(); await client.disconnect(); await server.close(); }
  });
  it('reuses ordered batch plans and rebuilds them when the member array changes', async () => {
    const server = await fixture({ metadata: true });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, limits: { maxRequests: 40, readPacingMs: 10 } });
    try {
      await client.connect();
      const discovery = await client.listBlockMembers({ type: 'DB', number: 7 });
      const selected = ['Enabled', 'Count', 'Delay', 'Title'].map(path => {
        const member = discovery.members.find(candidate => candidate.path === path && candidate.readable);
        if (!member) throw new Error('Missing synthetic member');
        return member;
      });
      const members = Array.from({ length: 80 }, (_, index) => selected[index % selected.length]);
      const expected = members.map(member => member.path === 'Enabled' ? true : member.path === 'Count' ? -123 : member.path === 'Title' ? 'TEST' : -1);
      const before = server.requests.length;
      expect((await client.readMembers(members)).map(result => result.observation.value)).toEqual(expected);
      expect((await client.readMembers(members)).map(result => result.observation.value)).toEqual(expected);
      members.reverse();
      expect((await client.readMembers(members)).map(result => result.observation.value)).toEqual([...expected].reverse());
      expect(server.requests.length - before).toBe(9);
      await expect(client.readMembers([{ ...selected[0] }])).rejects.toMatchObject({ code: 'UNVERIFIED_ADDRESS' });
      expect(client.connected).toBe(true);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
  it('rejects a full batch plan before transmission when the request budget is insufficient', async () => {
    const server = await fixture({ metadata: true });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, limits: { maxRequests: 9 } });
    try {
      await client.connect();
      const discovery = await client.listBlockMembers({ type: 'DB', number: 7 });
      const member = discovery.members.find(candidate => candidate.path === 'Enabled' && candidate.readable);
      if (!member) throw new Error('Missing synthetic member');
      const before = server.requests.length;
      await expect(client.readMembers(Array(65).fill(member))).rejects.toMatchObject({ code: 'REQUEST_LIMIT' });
      expect(server.requests).toHaveLength(before);
      expect(client.connected).toBe(true);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
  it('discovers and reads synthetic scalar/nested members from a larger bounded inventory through the standalone entry point', async () => {
    const server = await fixture({ metadata: true, inventorySize: 155 });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, limits: { maxRequests: 20, maxObjects: 256 } });
    try {
      await client.connect();
      expect((await client.listDataBlocks()).blocks).toHaveLength(155);
      const metadata = await client.getBlockMetadata({ type: 'DB', number: 7 });
      expect(metadata).toMatchObject({ name: 'SampleDB', objectRid: 0x8A0E0007, typeInfoId: root });
      const discovery = await client.listBlockMembers({ type: 'DB', number: 7 });
      expect(await client.readSymbol('SampleDB.Enabled')).toMatchObject({ observation: { value: true, quality: 'GOOD' },
        runtime: { accessPath: [101], symbolCrc: 0, metadataSymbolCrc: 0x10203040 } });
      expect(await client.readSymbol('SampleDB.Count')).toMatchObject({ observation: { value: -123, datatype: 'INT' } });
      expect(await client.readSymbol('SampleDB.Delay')).toMatchObject({ observation: { value: -1, representation: { unit: 'ms' } } });
      expect(await client.readSymbol('SampleDB.Details.Ready')).toMatchObject({ runtime: { accessPath: [120, 132] } });
      const member = /** @type {NonNullable<typeof discovery.members[number]>} */ (discovery.members.find(member => member.path === 'Enabled'));
      await expect(client.readMember({ ...member, accessPath: [999] })).rejects.toMatchObject({ code: 'UNVERIFIED_ADDRESS' });
      await expect(client.readSymbol('SampleDB.Missing')).rejects.toMatchObject({ code: 'SYMBOL_UNAVAILABLE' });
      expect(server.errors).toEqual([]);
      expect(server.requests.every(request => [0x5B3, 0x4CA, 0x542, 0x4BB, 0x586, 0x54C].includes(request.functionCode))).toBe(true);
    } finally { await client.disconnect(); await server.close(); }
  });
  it('discovers DB types and members in STOP while denying process-value reads without closing the session', async () => {
    const server = await fixture({ metadata: true, state: 4 });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port });
    try {
      await client.connect();
      const discovery = await client.listBlockMembers({ type: 'DB', number: 7 });
      expect(discovery.members.some(member => member.path === 'Details.Ready')).toBe(true);
      expect(client.report).toMatchObject({ cpuState: 'STOP', connected: true,
        capabilities: { objectExplore: true, symbolicLidRead: false, namedSymbolResolution: false } });
      const count = server.requests.length;
      await expect(client.readSymbol('SampleDB.Enabled')).rejects.toMatchObject({ code: 'CPU_STATE' });
      expect(server.requests).toHaveLength(count);
      expect(client.connected).toBe(true);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
  it('fails before transmission for invalid selectors or unqualified members', async () => {
    const server = await fixture({ metadata: true });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port });
    try {
      await client.connect();
      const count = server.requests.length;
      await expect(client.getBlockMetadata({ type: 'DB', number: 0 })).rejects.toMatchObject({ code: 'ARGUMENT' });
      await expect(client.getTypeInfo(0)).rejects.toMatchObject({ code: 'ARGUMENT' });
      await expect(client.listBlockMembers({ type: 'DB', number: 7 }, { maxTypes: 65537 })).rejects.toMatchObject({ code: 'ARGUMENT' });
      expect(server.requests).toHaveLength(count);
    } finally { await client.disconnect(); await server.close(); }
  });
  it.each([
    { option: { memberError: true }, code: 'ITEM_REJECTED' },
    { option: { memberTypeMismatch: true }, code: 'DATATYPE_MISMATCH' },
  ])('fails closed on qualified member errors: $code', async ({ option, code }) => {
    const server = await fixture({ metadata: true, ...option });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port });
    try {
      await client.connect();
      await client.listBlockMembers({ type: 'DB', number: 7 });
      await expect(client.readSymbol('SampleDB.Enabled')).rejects.toMatchObject({ code });
      expect(client.connected).toBe(false);
      expect(client.report.failure?.code).toBe(code);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
});
