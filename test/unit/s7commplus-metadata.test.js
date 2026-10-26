// @ts-check
import { describe, it, expect } from 'vitest';
import { Cursor, decodeObjects, decodeValue } from '../../src/protocol/s7commplus/codec.js';
import { buildBlockMembers, validateMemberValue } from '../../src/protocol/s7commplus/type-info.js';
import { S7CommPlusClient } from '../../src/lib.js';
import { fixture } from '../s7commplus-fixture.js';
import { typeObject, syntheticMembers, le32 } from '../s7commplus-metadata-fixture.js';

const root = 0x92000007;
const child = 0x92000009;
const block = { type: /** @type {const} */ ('DB'), number: 7, name: 'SampleDB', objectRid: 0x8A0E0007, typeInfoId: root, status: 'TYPE_REFERENCE_RESOLVED', evidence: {} };
const objects = () => decodeObjects(new Cursor(Buffer.concat([typeObject(root, syntheticMembers), typeObject(child, [{ name: 'Ready', lid: 132, type: 1 }])])));

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
  it('distinguishes LTIME timespans from LINT wire values and retains 64-bit precision', () => {
    const types = decodeObjects(new Cursor(typeObject(root, [{ name: 'Duration', lid: 1, type: 64 }])));
    const member = buildBlockMembers(block, types).members[0];
    expect(validateMemberValue(member, decodeValue(new Cursor(Buffer.from([0, 17, 0x7F]))))).toMatchObject({ value: '-1', representation: { unit: 'ns', bits: 64 } });
    expect(() => validateMemberValue(member, decodeValue(new Cursor(Buffer.from([0, 9, 0x7F]))))).toThrow(/match/);
  });
});

describe('public native discovery and qualified reads', () => {
  it('discovers and reads synthetic scalar/nested members through the standalone entry point', async () => {
    const server = await fixture({ metadata: true });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, limits: { maxRequests: 20 } });
    try {
      await client.connect();
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
      await expect(client.listBlockMembers({ type: 'DB', number: 7 }, { maxTypes: 100 })).rejects.toMatchObject({ code: 'ARGUMENT' });
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
