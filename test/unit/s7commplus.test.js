// @ts-check
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { rootCertificates } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { Cursor, decodeValue, vlq, u32, PlusAssembler, encodeOperation, assertOutgoing, responsePayload, decodeObjects } from '../../src/protocol/s7commplus/codec.js';
import { S7CommPlusClient } from '../../src/client/s7commplus-client.js';
import { fixture, validateSessionRequest, encodeTestUInt64 } from '../s7commplus-fixture.js';
import { saveSoftwareSnapshot, verifySoftwareSnapshot } from '../helpers/program-store.js';

const context = { version: 1, sessionId: 0x12345678 };
describe('S7CommPlus read-only codec', () => {
  it('restricts targets, read-only mode, pacing and TLS configuration before connecting', async () => {
    expect(() => new S7CommPlusClient({ host: '192.0.2.1' })).toThrow(/authorized/);
    expect(() => new S7CommPlusClient({ host: '127.0.0.1', productionReadOnly: false })).toThrow(/cannot disable/);
    expect(() => new S7CommPlusClient({ host: '127.0.0.1', limits: { pacingMs: 1 } })).toThrow(/Pacing/);
    expect(() => new S7CommPlusClient({ host: '127.0.0.1', securityMode: 'tls' })).toThrow(/CA certificate/);
    const client = new S7CommPlusClient({ host: '127.0.0.1' });
    await expect(client.uploadBlock({ number: 1 })).rejects.toThrow(/nothing transmitted/);
    expect(client.report.statistics.sentBytes).toBe(0);
    await expect(client.readSymbolic({ accessArea: 1, lids: [1] })).rejects.toThrow(/session/);
  });
  it.each(['write', 'download', 'delete', 'cpuControl', 'invoke', 'setVariable', 'upload', '__proto__'])('denies %s before serialization', kind => {
    expect(() => encodeOperation({ kind }, context, 0)).toThrow(/not allowlisted/);
  });
  it('revalidates canonical bytes before transmission', () => {
    const operation = { kind: 'explore', objectId: 52, attributes: [0x8BD] };
    const frame = encodeOperation(operation, context, 2);
    expect(() => assertOutgoing(frame, operation, context, 2)).not.toThrow();
    frame.writeUInt16BE(0x04F2, 7);
    expect(() => assertOutgoing(frame, operation, context, 2)).toThrow(/allowlisted/);
  });
  it.each([0, 127, 128, 0x7FFFFFFF, 0xFFFFFFFF])('round trips UInt32 %i', value => {
    expect(new Cursor(vlq(value)).uint()).toBe(value);
  });
  it('preserves 64-bit precision including the ninth VLQ byte', () => {
    const cursor = new Cursor(Buffer.from([0, 5, ...Array(9).fill(255)]));
    expect(decodeValue(cursor).value).toBe('18446744073709551615');
    expect(decodeValue(new Cursor(Buffer.from([0, 9, 0x7F]))).value).toBe('-1');
    expect(decodeValue(new Cursor(Buffer.from([0, 8, 0xFF, 0x00]))).value).toBe(-128);
  });
  it('rejects overflow, unknown types, packed structs, truncation and large arrays', () => {
    expect(() => new Cursor(Buffer.from('ffffffff7f', 'hex')).uint()).toThrow(/overflow/);
    expect(() => new Cursor(Buffer.from('8080808080', 'hex')).uint()).toThrow(/Unterminated/);
    expect(() => decodeValue(new Cursor(Buffer.from([0, 0xFF])))).toThrow(/datatype/);
    expect(() => decodeValue(new Cursor(Buffer.from([0, 14, 0])))).toThrow(/Truncated/);
    expect(() => decodeValue(new Cursor(Buffer.concat([Buffer.from([0x10, 1]), vlq(5000)])))).toThrow(/4096/);
    expect(() => decodeValue(new Cursor(Buffer.concat([Buffer.from([0, 23]), u32(0x90010000)])))).toThrow(/Packed struct/);
  });
  it('walks real boundaries and preserves object parents and struct member IDs', () => {
    const bytes = Buffer.concat([Buffer.from([0xA1]), u32(52), vlq(1), Buffer.from([0, 0, 0xA3]), vlq(0x8BD),
      Buffer.from([0, 23]), u32(0xD99), vlq(0xD9E), Buffer.from([0, 8, 8, 0, 0xA2])]);
    const result = decodeObjects(new Cursor(bytes));
    expect(result[0].rid).toBe(52);
    expect(result[0].attributes[0].value.value[0]).toMatchObject({ id: 0xD9E, value: { value: 8 } });
    expect(() => decodeObjects(new Cursor(bytes.subarray(0, -1)))).toThrow(/Unclosed/);
  });
  it('decodes an independently constructed rich Explore header and RUN structure', () => {
    const body = Buffer.concat([Buffer.from('32000004bb0000000334', 'hex'), Buffer.from([0]), u32(48), vlq(3),
      Buffer.from([0xA1]), u32(52), vlq(2179), vlq(48), vlq(2393), vlq(6),
      Buffer.from([0xA3]), vlq(0x8BD), Buffer.from([0, 23]), u32(0xD99),
      vlq(0xD9E), Buffer.from([0, 8, 8, 0, 0xA2]), Buffer.alloc(4)]);
    const { cursor } = responsePayload(body, 0x04BB, 3);
    expect(cursor.uint32()).toBe(48);
    expect(cursor.uint()).toBe(3);
    const objects = decodeObjects(cursor);
    expect(objects[0]).toMatchObject({ rid: 52, classId: 2179, classFlags: 48, attributeId: 2393, attributeFlags: 6 });
    expect(objects[0].attributes[0].value.value).toContainEqual(expect.objectContaining({ id: 0xD9E, value: expect.objectContaining({ datatype: 8, value: 8 }) }));
  });
  it('reassembles segmented replies only with the explicit end trailer', () => {
    const parser = new PlusAssembler();
    expect(parser.feed(Buffer.from('720100026162', 'hex'))).toEqual([]);
    expect(parser.feed(Buffer.from('72010001637201', 'hex'))).toEqual([]);
    expect(parser.feed(Buffer.from('0000', 'hex'))).toEqual([{ version: 1, body: Buffer.from('abc') }]);
  });
  it('rejects unsupported versions, changing versions and response allocation overruns', () => {
    expect(() => new PlusAssembler().feed(Buffer.from('72030000', 'hex'))).toThrow(/V3/);
    const parser = new PlusAssembler();
    parser.feed(Buffer.from('7201000161', 'hex'));
    expect(() => parser.feed(Buffer.from('72020000', 'hex'))).toThrow(/version changed/);
    expect(() => new PlusAssembler(32).feed(Buffer.from('7201ffff', 'hex'))).toThrow(/budget/);
    expect(() => new PlusAssembler().feed(Buffer.from('72010000', 'hex'))).toThrow(/Empty/);
  });
  it('matches the ten-byte response header and rejects PLC errors', () => {
    const header = Buffer.from('32000004bb0000000234', 'hex');
    expect(responsePayload(Buffer.concat([header, Buffer.from([0])]), 0x04BB, 2).cursor.offset).toBe(1);
    expect(() => responsePayload(Buffer.concat([header, Buffer.from([0])]), 0x04BB, 3)).toThrow(/sequence/);
    expect(() => responsePayload(Buffer.concat([header, Buffer.from([1])]), 0x04BB, 2)).toThrow(/ReturnValue/);
  });
  it('decodes an independently constructed composite rejection at the header boundary', () => {
    const parser = new PlusAssembler();
    const status = encodeTestUInt64(0x8000000000008001n);
    const body = Buffer.concat([Buffer.from('32000004ca0000000134', 'hex'), status, Buffer.alloc(5)]);
    const outer = Buffer.from([0x72, 1, 0, body.length]);
    const messages = parser.feed(Buffer.concat([outer, body, Buffer.from([0x72, 1, 0, 0])]));
    expect(messages).toHaveLength(1);
    const cursor = new Cursor(messages[0].body.subarray(10));
    expect(cursor.integer(64)).toBe(0x8000000000008001n);
    expect(cursor.offset).toBe(9);
    try { responsePayload(messages[0].body, 0x04CA, 1); throw new Error('Expected rejection'); }
    catch (error) {
      expect(error).toMatchObject({ code: 'SESSION_CREATE_REJECTED', details: {
        returnValue: '0x8000000000008001', returnValueHex: status.toString('hex'), returnValueBodyOffset: 10,
        returnValueBytes: 9, remainingPayloadBytes: 5,
      } });
    }
  });
  it('does not parse invalid headers or generic-error payloads as service ReturnValues', () => {
    const header = Buffer.from('32000004ca0000000134', 'hex');
    header[1] = 1;
    expect(() => responsePayload(Buffer.concat([header, Buffer.from([1])]), 0x04CA, 1)).toThrow(/header/);
    header[1] = 0; header.writeUInt16BE(0x04B1, 3);
    try { responsePayload(Buffer.concat([header, encodeTestUInt64(0x8000000000008001n)]), 0x04CA, 1); }
    catch (error) { expect(error).toMatchObject({ code: 'INDETERMINATE_PROTOCOL_ERROR' }); expect(/** @type {any} */ (error).details.returnValue).toBeUndefined(); }
  });
  it('permits inspection of a nonzero CreateObject status only for verified TLS, never other services', () => {
    const body = Buffer.from('32000004ca000000013612014d', 'hex');
    expect(() => responsePayload(body, 0x04CA, 1)).toThrow(/ReturnValue/);
    const decoded = responsePayload(body, 0x04CA, 1, true);
    expect(decoded.statusDetails.returnValue).toBe('0x0000000000000012');
    expect(decoded.cursor.byte()).toBe(1);
    expect(decoded.cursor.uint()).toBe(77);
    body.writeUInt16BE(0x04BB, 3);
    expect(() => responsePayload(body, 0x04BB, 1, true)).toThrow(/ReturnValue/);
  });
  it('classifies a synthetic Multi-ES composite result and never treats a negative status as success', () => {
    const body = Buffer.concat([Buffer.from('32000004ca0000000136', 'hex'), encodeTestUInt64(0x800000000000FF7An), Buffer.from([0])]);
    for (const verifiedTls of [false, true]) {
      try { responsePayload(body, 0x04CA, 1, verifiedTls); throw new Error('Expected rejection'); }
      catch (error) {
        expect(error).toMatchObject({ code: 'ENGINEERING_SESSION_IN_USE', details: {
          returnValue: '0x800000000000ff7a', serviceResultCode: -134,
        } });
      }
    }
    const rejected = Buffer.concat([Buffer.from('32000004ca0000000134', 'hex'), encodeTestUInt64(0x8000000000008001n), Buffer.alloc(5)]);
    expect(() => responsePayload(rejected, 0x04CA, 1, true)).toThrow(/ReturnValue/);
  });
});

describe('S7CommPlus loopback lifecycle (never live)', () => {
  it('establishes one session, checks health, explores and reads one typed value', async () => {
    const server = await fixture();
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port });
    try {
      await client.connect();
      expect(client.report.identity).toMatchObject({ orderNumber: 'TEST-ORDER', firmware: 'V0.0', model: null });
      expect(client.report.cpuState).toBe('RUN');
      expect(client.report.effectiveProtectionLevel).toBe(2);
      const second = new S7CommPlusClient({ host: '127.0.0.1', port: server.port });
      await expect(second.connect()).rejects.toThrow(/One active/);
      const result = await client.explore(3, { attributes: [233] });
      expect(result.objects[0].rid).toBe(3);
      const value = await client.readSymbolic({ accessArea: 0x8A0E0001, lids: [1], name: 'fixtureOnly' });
      expect(value.value).toMatchObject({ datatype: 8, value: 42 });
      expect(value.nativeTimestamp).toBeNull();
      const setup = server.requests.find(request => request.functionCode === 0x0542);
      expect(setup).toBeDefined();
      const cursor = new Cursor(/** @type {Buffer} */ (setup?.frame).subarray(18));
      expect(cursor.uint32()).toBe(77);
      expect([cursor.uint(), cursor.uint(), cursor.uint()]).toEqual([1, 1, 306]);
      expect(server.requests.map(request => request.functionCode)).toEqual([0x05B3, 0x04CA, 0x0542, 0x04BB, 0x0586, 0x04BB, 0x054C]);
      for (let index = 1; index < server.requests.length; index++) {
        expect(server.requests[index].receivedAt - server.requests[index - 1].receivedAt).toBeGreaterThanOrEqual(240);
      }
    } finally { await client.disconnect(); await server.close(); }
    expect(client.connected).toBe(false);
    expect(client.report.sessionEstablished).toBe(true);
  });
  it.each([
    [{ state: 6 }, 'CPU_STATE', 4],
    [{ challenge: true }, 'LEGACY_SESSION_KEY_REQUIRED', 2],
    [{ wrongSequence: true }, 'CORRELATION', 1],
    [{ oversized: true }, 'RESPONSE_LIMIT', 1],
    [{ smallTpdu: true }, 'UNSUPPORTED_TRANSPORT', 0],
  ])('stops on fixture condition %j', async (options, code, count) => {
    const server = await fixture(/** @type {any} */ (options));
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port });
    try {
      await expect(client.connect()).rejects.toMatchObject({ code });
      expect(server.requests).toHaveLength(count);
      expect(client.connected).toBe(false);
    } finally { await client.disconnect(); await server.close(); }
  });
  it('times out once without reconnecting or retrying', async () => {
    const server = await fixture({ stall: true });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, limits: { requestTimeoutMs: 300 } });
    try {
      await expect(client.connect()).rejects.toMatchObject({ code: 'TIMEOUT' });
      expect(server.requests).toHaveLength(1);
      await expect(client.connect()).rejects.toThrow(/new client/);
    } finally { await client.disconnect(); await server.close(); }
  });
  it('enforces the session request budget', async () => {
    const server = await fixture();
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, limits: { maxRequests: 2 } });
    try {
      await expect(client.connect()).rejects.toMatchObject({ code: 'REQUEST_LIMIT' });
      expect(server.requests).toHaveLength(2);
    } finally { await client.disconnect(); await server.close(); }
  });
  it.each([
    [{ itemError: true }, 'ITEM_REJECTED', /0x8104/],
    [{ badTail: true }, 'UNSUPPORTED_DECODING', /suffix/],
  ])('preserves read failures without reporting GOOD: %j', async (options, code, message) => {
    const server = await fixture(/** @type {any} */ (options));
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port });
    try {
      await client.connect();
      await expect(client.readSymbolic({ accessArea: 0x8A0E0001, lids: [1] })).rejects.toMatchObject({ code, message });
      expect(client.connected).toBe(false);
    } finally { await client.disconnect(); await server.close(); }
  });
  it('recognizes only the structurally anchored protection marker', async () => {
    const server = await fixture({ protectionMarker: true });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port });
    try { await client.connect(); expect(client.report.effectiveProtectionLevel).toBe(2); }
    finally { await client.disconnect(); await server.close(); }
  });
  it('does not expose an unqualified production TLS profile', () => {
    vi.stubEnv('S7PROXY_PRODUCTION_HOST', '192.0.2.10');
    try {
      expect(() => new S7CommPlusClient({ securityMode: 'tls', tls: { ca: 'fixture-only-not-a-certificate' } })).toThrow(/not qualified/);
    } finally { vi.unstubAllEnvs(); }
  });
  it('requires an explicit lab profile without relaxing the separate production target', () => {
    vi.stubEnv('S7PROXY_PRODUCTION_HOST', '192.0.2.10');
    vi.stubEnv('S7PROXY_LAB_HOST', '192.0.2.11');
    try {
      expect(() => new S7CommPlusClient({ host: '192.0.2.11' })).toThrow(/profile/);
      const lab = new S7CommPlusClient({ host: '192.0.2.11', securityMode: 'legacy' });
      expect(lab.report).toMatchObject({ selectedProfile: 'LEGACY_PLAINTEXT', productionReadOnly: true });
      expect(() => new S7CommPlusClient({ host: '192.0.2.11', securityMode: /** @type {any} */ ('auto') })).toThrow(/fallback/);
      expect(() => new S7CommPlusClient({ host: '192.0.2.10', securityMode: 'tls', tls: { ca: 'fixture', certificateSha256: '00'.repeat(32) } })).toThrow(/not qualified/);
      vi.stubEnv('S7PROXY_LAB_HOST', '192.0.2.10');
      expect(() => new S7CommPlusClient({ host: '192.0.2.10', securityMode: 'legacy' })).toThrow(/separate/);
    } finally { vi.unstubAllEnvs(); }
  });
  it.each([
    [{ reject: 'initSSL' }, 'INITSSL_REJECTED', 1, 'initSSL'],
    [{ reject: 'createSession' }, 'SESSION_CREATE_REJECTED', 2, 'createSession'],
    [{ reject: 'setupSession' }, 'SESSION_SETUP_REJECTED', 3, 'setupSession'],
    [{ setupError: true }, 'SESSION_SETUP_REJECTED', 3, 'setupSession'],
    [{ badSetupTail: true }, 'MALFORMED_RESPONSE', 3, 'setupSession'],
    [{ badInitTail: true }, 'MALFORMED_RESPONSE', 1, 'initSSL'],
    [{ createVersion: 2 }, 'SECURITY_REQUIRED', 2, 'createSession'],
    [{ createVersion: 3 }, 'PROTOCOL_VERSION_UNSUPPORTED', 2, 'createSession'],
    [{ versionSchema: 'missing' }, 'SESSION_CREATE_REJECTED', 2, 'createSession'],
    [{ versionSchema: 'duplicate' }, 'SESSION_CREATE_REJECTED', 2, 'createSession'],
    [{ versionSchema: 'foreignOwner' }, 'SESSION_CREATE_REJECTED', 2, 'createSession'],
    [{ versionSchema: 'invalid' }, 'SESSION_SETUP_REJECTED', 2, 'setupSession'],
    [{ malformed: 'reserved' }, 'MALFORMED_RESPONSE', 1, 'initSSL'],
    [{ malformed: 'opcode' }, 'MALFORMED_RESPONSE', 1, 'initSSL'],
    [{ malformed: 'function' }, 'CORRELATION', 1, 'initSSL'],
    [{ malformed: 'genericError' }, 'INDETERMINATE_PROTOCOL_ERROR', 1, 'initSSL'],
    [{ malformed: 'empty' }, 'MALFORMED_RESPONSE', 1, 'initSSL'],
    [{ malformed: 'duplicate' }, 'CORRELATION', 1, 'initSSL'],
    [{ malformed: 'cotp' }, 'MALFORMED_RESPONSE', 1, 'initSSL'],
    [{ malformed: 'truncated' }, 'PEER_CLOSED', 1, 'initSSL'],
    [{ malformed: 'trailer' }, 'TIMEOUT', 1, 'initSSL'],
    [{ malformed: 'length' }, 'TIMEOUT', 1, 'initSSL'],
    [{ terminate: true }, 'PEER_CLOSED', 1, 'initSSL'],
  ])('preserves stage, evidence and no-retry bounds for %j', async (options, code, count, phase) => {
    const server = await fixture(/** @type {import('../s7commplus-fixture.js').FixtureOptions} */ (options));
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, limits: { requestTimeoutMs: 400 } });
    try {
      await expect(client.connect()).rejects.toMatchObject({ code });
      expect(client.report.failure).toMatchObject({ code, phase });
      expect(client.report.sessionEstablished).toBe(false);
      expect(client.connected).toBe(false);
      expect(server.requests).toHaveLength(count);
      expect(server.errors).toEqual([]);
      if ('reject' in options) expect(client.report.failure?.details).toMatchObject({ returnValue: '0x0000000000000001', returnValueBytes: 1, returnValueHex: '01' });
    } finally { await client.disconnect(); await server.close(); }
  });
  it('rejects noncanonical or foreign session housekeeping in the fixture', () => {
    const serverVersion = Buffer.from('00170000013a823b00048400823f00150000', 'hex');
    const setup = encodeOperation({ kind: 'setupSession' }, { sessionId: 77, version: 1, serverVersion }, 2);
    expect(() => validateSessionRequest(setup, 2)).not.toThrow();
    const foreign = Buffer.from(setup); foreign.writeUInt32BE(88, 18);
    expect(() => validateSessionRequest(foreign, 2)).toThrow(/owned session/);
    const changed = Buffer.from(setup); changed[31] ^= 1;
    expect(() => validateSessionRequest(changed, 2)).toThrow(/owned session/);
    for (const context of [{ sessionId: 0, version: 1, serverVersion }, { sessionId: 77, version: 1, serverVersion: Buffer.from([0, 1, 1]) }]) {
      expect(() => encodeOperation({ kind: 'setupSession' }, context, 2)).toThrow();
    }
  });
});

describe('S7CommPlus verified loopback TLS (never live)', () => {
  let directory = '';
  /** @type {{key:Buffer,cert:Buffer}} */
  let credentials;
  let certificateSha256 = '';
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 's7proxy-loopback-tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-keyout', join(directory, 'key.pem'),
      '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
    credentials = { key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')) };
    certificateSha256 = new X509Certificate(credentials.cert).fingerprint256.replaceAll(':', '').toLowerCase();
  });
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
  it.each([['run', 8], ['stop', 4]])('connects in %s and retrieves unchanged native files without CPU control', async (mode, state) => {
    const server = await fixture({ tls: credentials, programContent: true, state: Number(state) });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, securityMode: 'tls',
      tls: { ca: credentials.cert, certificateSha256 }, limits: { maxRequests: 22 } });
    try {
      await client.connect();
      expect(client.connected).toBe(true);
      expect(client.report.failure).toBeNull();
      expect(await client.readCpuState()).toBe(String(mode).toUpperCase());
      await client.explore(3, { attributes: [233] });
      if (mode === 'stop') {
        const requestCount = server.requests.length;
        await expect(client.readSymbolic({ accessArea: 0x8A0E0007, lids: [1] })).rejects.toMatchObject({ code: 'CPU_STATE' });
        expect(server.requests).toHaveLength(requestCount);
        await expect(client.uploadProgram()).rejects.toMatchObject({ code: 'CPU_STATE' });
        expect(client.connected).toBe(true);
      }
      const result = await client.uploadProgram({ mode: String(mode) });
      expect(result).toMatchObject({ status: 'AVAILABLE_COMPONENTS_CAPTURED', failure: null,
        cpuState: { before: String(mode).toUpperCase(), after: String(mode).toUpperCase() } });
      expect(result.files.map(file => file.bytes.toString('hex'))).toEqual(['100700ff', '100800ff', '100900ff']);
      const block = await client.uploadProgramBlock({ type: 'FC', number: 8 }, { mode: state === 4 ? 'stop' : 'run' });
      expect(block.cpuState).toEqual(result.cpuState);
      expect(block.files[0].bytes.toString('hex')).toBe('100800ff');
      expect(client.connected).toBe(true);
      expect(server.requests.every(request => [0x05B3, 0x04CA, 0x0542, 0x04BB, 0x0586].includes(request.functionCode))).toBe(true);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
  it.each(['changed', 'unknown', 'wrong-mode', 'resume'])('handles %s CPU mode without treating normal STOP as a broken session', async scenario => {
    const states = scenario === 'changed' ? [8, 8, 4] : scenario === 'unknown' ? [8, 6]
      : scenario === 'resume' ? [4, 8] : [8, 8];
    const server = await fixture({ tls: credentials, programContent: true, states });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, securityMode: 'tls',
      tls: { ca: credentials.cert, certificateSha256 }, limits: { maxRequests: 16 } });
    try {
      await client.connect();
      if (scenario === 'changed') {
        const result = await client.uploadProgram();
        expect(result).toMatchObject({ status: 'PARTIAL', failure: { code: 'CPU_STATE' }, cpuState: { before: 'RUN', after: 'STOP' } });
        expect(result.files).toHaveLength(3);
        expect(client.connected).toBe(true);
      } else if (scenario === 'unknown') {
        await expect(client.readCpuState()).rejects.toMatchObject({ code: 'CPU_STATE' });
        expect(client.report.cpuState).toBe('UNKNOWN');
        expect(client.connected).toBe(false);
      } else if (scenario === 'wrong-mode') {
        await expect(client.uploadProgram({ mode: 'stop' })).rejects.toMatchObject({ code: 'CPU_STATE' });
        expect(server.requests).toHaveLength(6);
        expect(client.connected).toBe(true);
      } else {
        expect(client.report.cpuState).toBe('STOP');
        expect(await client.readCpuState()).toBe('RUN');
        expect((await client.readSymbolic({ accessArea: 0x8A0E0007, lids: [1] })).value.value).toBe(42);
        expect(client.connected).toBe(true);
      }
      expect(server.requests.every(request => [0x05B3, 0x04CA, 0x0542, 0x04BB, 0x0586, 0x054C].includes(request.functionCode))).toBe(true);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
  it.each(['complete', 'failure', 'limit', 'empty', 'timeout'])('captures native software components without mode-control operations: %s', async mode => {
    const server = await fixture({ tls: credentials, programContent: true,
      programFailure: mode === 'failure', programEmpty: mode === 'empty', programStall: mode === 'timeout' });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, securityMode: 'tls',
      tls: { ca: credentials.cert, certificateSha256 },
      limits: { maxRequests: mode === 'limit' ? 9 : 16, requestTimeoutMs: mode === 'timeout' ? 400 : 1500 } });
    try {
      await client.connect();
      const result = await client.uploadProgram();
      expect(result.restorable).toBe(false);
      expect(result.cpuState.before).toBe('RUN');
      if (mode === 'complete') {
        expect(result.status).toBe('AVAILABLE_COMPONENTS_CAPTURED');
        expect(result.artifacts).toHaveLength(3);
        expect(result.totalContentBytes).toBe(12);
        expect(result.files.map(file => file.name)).toEqual([
          'DB7-interface-description.bin', 'FC8-code-block.bin', 'OB9-code-block.bin',
        ]);
        expect(result.files.map(file => file.bytes)).toEqual(result.artifacts.map(artifact => artifact.rawBytes));
        expect(result.files.reduce((sum, file) => sum + file.byteCount, 0)).toBe(12);
        expect(result.artifacts.every(artifact => artifact.transfer.protocolFragmentCount === 2)).toBe(true);
        expect(result.cpuState.after).toBe('RUN');
        const saved = await saveSoftwareSnapshot(result, join(directory, 'snapshots'));
        expect(await verifySoftwareSnapshot(saved.manifestPath)).toMatchObject({ valid: true, protocolBlocksVerified: 3, protocolEvidenceUnavailable: 0 });
      } else {
        expect(result.status).toBe('PARTIAL');
        if (mode === 'failure') expect(result.failure?.code).toBe('PLC_REJECTED');
        if (mode === 'limit') { expect(result.failure?.code).toBe('REQUEST_LIMIT'); expect(result.cpuState.after).toBe('RUN'); }
        if (mode === 'timeout') expect(result.failure?.code).toBe('TIMEOUT');
        if (mode === 'empty') {
          expect(result.artifacts.every(artifact => artifact.status === 'UNAVAILABLE')).toBe(true);
          expect(result.files).toEqual([]);
        } else {
          expect(result.files.map(file => file.name)).toEqual(mode === 'timeout' ? [] : ['DB7-interface-description.bin']);
        }
      }
      expect(server.requests.every(request => [0x05B3, 0x04CA, 0x0542, 0x04BB, 0x0586].includes(request.functionCode))).toBe(true);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
  it('rejects concurrent acquisitions and cancels an active upload by disconnecting its own session', async () => {
    const server = await fixture({ tls: credentials, programContent: true, programStall: true });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, securityMode: 'tls',
      tls: { ca: credentials.cert, certificateSha256 }, limits: { maxRequests: 16, requestTimeoutMs: 2000 } });
    try {
      await client.connect();
      const acquisition = client.uploadProgram();
      await expect(client.uploadProgram()).rejects.toMatchObject({ code: 'CONCURRENCY_LIMIT' });
      const deadline = Date.now() + 1800;
      while (server.requests.length < 8 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      expect(server.requests).toHaveLength(8);
      await client.disconnect();
      expect(await acquisition).toMatchObject({ status: 'PARTIAL', failure: { code: 'DISCONNECTED' }, cpuState: { after: 'UNKNOWN' } });
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
  it.each(['protected', 'no-selected'])('records %s blocks explicitly without sending unqualified content requests', async mode => {
    const server = await fixture({ tls: credentials, programContent: true, programProtected: mode === 'protected' });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, securityMode: 'tls',
      tls: { ca: credentials.cert, certificateSha256 }, limits: { maxRequests: 16 } });
    try {
      await client.connect();
      const result = await client.uploadProgram({ include: mode === 'protected' ? ['DB', 'FC', 'OB'] : ['FB'] });
      expect(result.status).toBe(mode === 'protected' ? 'PARTIAL' : 'UNAVAILABLE');
      expect(result.cpuState).toEqual({ before: 'RUN', after: 'RUN' });
      expect(result.omissions).toContainEqual(expect.objectContaining({ status: mode === 'protected' ? 'PROTECTED_BLOCK' : 'NOT_OBSERVED_IN_BOUNDED_INVENTORY' }));
      expect(server.requests.some(request => request.functionCode === 0x04BB && request.frame.readUInt32BE(18) === 0x8A130008)).toBe(false);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
  it('verifies an IP SAN without sending an IP address as TLS SNI', async () => {
    const server = await fixture({ tls: credentials });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, securityMode: 'tls',
      tls: { ca: credentials.cert, certificateSha256 } });
    try {
      await client.connect();
      expect(client.report.securityMode).toBe('TLS_VERIFIED');
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
  it.each(['valid', 'missing', 'duplicate', 'foreignOwner', 'rejected'])('validates all session objects despite a nonzero TLS CreateObject status: %s', async schema => {
    const server = await fixture({ tls: credentials, nonzeroCreateStatus: true,
      versionSchema: schema === 'missing' || schema === 'duplicate' || schema === 'foreignOwner' ? schema : undefined,
      compositeReject: schema === 'rejected' });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, securityMode: 'tls',
      tls: { ca: credentials.cert, servername: 'localhost', certificateSha256 } });
    try {
      if (schema === 'valid') {
        await client.connect();
        expect(client.report.sessionEstablished).toBe(true);
        expect(client.report.observations).toContainEqual(expect.objectContaining({ kind: 'createSessionStatus', returnValue: '0x0000000000000012' }));
      } else {
        await expect(client.connect()).rejects.toMatchObject({ code: 'SESSION_CREATE_REJECTED' });
        expect(client.report.sessionEstablished).toBe(false);
        expect(server.requests).toHaveLength(2);
      }
      expect(client.report.transcript.some(entry => entry.direction === 'in' && entry.layer === 'S7CommPlus')).toBe(true);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
  it.each([1, 2])('carries TLS after InitSSL V%s, creates V1 then sets up V2 and correlates counters', async initVersion => {
    const server = await fixture({ tls: credentials, initVersion });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, securityMode: 'tls', tls: { ca: credentials.cert, servername: 'localhost', certificateSha256 } });
    try {
      await client.connect();
      const result = await client.readSymbolic({ accessArea: 0x8A0E0001, lids: [1] });
      expect(result.value.value).toBe(42);
      expect(client.report).toMatchObject({ securityMode: 'TLS_VERIFIED', peerCertificateSha256: certificateSha256, protocolVersion: 2, sessionEstablished: true });
      expect(server.requests.map(request => request.frame[1])).toEqual([1, 1, 2, 2, 2, 2]);
      expect(server.tlsRecords).toBeGreaterThan(0);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
  it('does not mistake a legacy challenge for a password requirement after verified TLS', async () => {
    const server = await fixture({ tls: credentials, challenge: true });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, securityMode: 'tls',
      tls: { ca: credentials.cert, servername: 'localhost', certificateSha256 } });
    try {
      await client.connect();
      expect(client.report).toMatchObject({ securityMode: 'TLS_VERIFIED', sessionEstablished: true, effectiveProtectionLevel: 2, cpuState: 'RUN' });
      expect(server.requests).toHaveLength(5);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
  it.each(['wrongHost', 'untrustedCA', 'wrongPin', 'abort', 'stallTLS', 'badIntegrity'])('stops without downgrade on %s', async mode => {
    const server = await fixture({ tls: mode === 'abort' ? undefined : credentials, abortTLS: mode === 'abort', stallTLS: mode === 'stallTLS', badIntegrity: mode === 'badIntegrity' });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, securityMode: 'tls',
      tls: { ca: mode === 'untrustedCA' ? rootCertificates[0] : credentials.cert, servername: mode === 'wrongHost' ? 'wrong.invalid' : 'localhost', certificateSha256: mode === 'wrongPin' ? '00'.repeat(32) : certificateSha256 }, limits: { requestTimeoutMs: 500 } });
    try {
      const code = mode === 'badIntegrity' ? 'INDETERMINATE_PROTOCOL_ERROR' : mode === 'abort' ? 'PEER_CLOSED' : mode === 'stallTLS' ? 'TIMEOUT' : mode === 'wrongPin' ? 'CERTIFICATE_PIN_MISMATCH' : 'CERTIFICATE_REJECTED';
      await expect(client.connect()).rejects.toMatchObject({ code });
      expect(client.report.failure).toMatchObject({ code, phase: mode === 'badIntegrity' ? 'ready' : 'tls' });
      expect(server.requests).toHaveLength(mode === 'badIntegrity' ? 4 : 1);
      if (mode === 'wrongPin') expect(client.report).toMatchObject({ securityMode: 'TLS_UNVERIFIED', peerCertificateSha256: certificateSha256 });
      expect(client.connected).toBe(false);
      if (mode !== 'abort') expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
  it('rejects missing and malformed pins before opening a socket', () => {
    for (const pin of [undefined, '', 'bad']) {
      expect(() => new S7CommPlusClient({ host: '127.0.0.1', securityMode: 'tls', tls: { ca: credentials.cert, certificateSha256: pin } })).toThrow(/certificate pin/);
    }
  });
  it('does not treat a V2 InitSSL envelope as permission for plaintext CreateObject', async () => {
    const server = await fixture({ initVersion: 2 });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, securityMode: 'legacy' });
    try {
      await expect(client.connect()).rejects.toMatchObject({ code: 'PROTOCOL_VERSION_UNSUPPORTED' });
      expect(server.requests).toHaveLength(1);
    } finally { await client.disconnect(); await server.close(); }
  });
  it('requires an explicit CLI profile and an approved pin before reading CA files or connecting', () => {
    expect(() => execFileSync(process.execPath, ['src/plus-explore.js', '--live'], { stdio: 'pipe' })).toThrow();
    expect(() => execFileSync(process.execPath, ['src/plus-explore.js', '--live', '--lab', '--tls'], {
      stdio: 'pipe', env: { ...process.env, S7PROXY_PRODUCTION_HOST: '192.0.2.10', S7PROXY_LAB_HOST: '192.0.2.11', S7PLUS_TLS_CA: '/nonexistent/ca.pem', S7PLUS_TLS_CERT_SHA256: '' },
    })).toThrow(/approved certificate pin/);
  });
});