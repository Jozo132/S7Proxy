// @ts-check
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { rootCertificates } from 'node:tls';
import { Cursor, decodeValue, vlq, u32, PlusAssembler, encodeOperation, assertOutgoing, responsePayload, decodeObjects } from '../../src/protocol/s7commplus/codec.js';
import { S7CommPlusClient } from '../../src/client/s7commplus-client.js';
import { fixture, validateSessionRequest } from '../s7commplus-fixture.js';

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
  it('decodes the recorded rejection at its real boundary without interpreting its cause', () => {
    const parser = new PlusAssembler();
    const messages = parser.feed(Buffer.from('7201001832000004ca0000000134d180bae08087f3fdf8000000000072010000', 'hex'));
    expect(messages).toHaveLength(1);
    const cursor = new Cursor(messages[0].body.subarray(10));
    expect(cursor.integer(64)).toBe(0xa201d60001f9fdf8n);
    expect(cursor.offset).toBe(9);
    try { responsePayload(messages[0].body, 0x04CA, 1); throw new Error('Expected rejection'); }
    catch (error) {
      expect(error).toMatchObject({ code: 'SESSION_CREATE_REJECTED', details: {
        returnValue: '0xa201d60001f9fdf8', returnValueHex: 'd180bae08087f3fdf8', returnValueBodyOffset: 10,
        returnValueBytes: 9, remainingPayloadBytes: 5,
      } });
    }
  });
  it('does not parse invalid headers or generic-error payloads as service ReturnValues', () => {
    const header = Buffer.from('32000004ca0000000134', 'hex');
    header[1] = 1;
    expect(() => responsePayload(Buffer.concat([header, Buffer.from([1])]), 0x04CA, 1)).toThrow(/header/);
    header[1] = 0; header.writeUInt16BE(0x04B1, 3);
    try { responsePayload(Buffer.concat([header, Buffer.from('d180bae08087f3fdf8', 'hex')]), 0x04CA, 1); }
    catch (error) { expect(error).toMatchObject({ code: 'INDETERMINATE_PROTOCOL_ERROR' }); expect(/** @type {any} */ (error).details.returnValue).toBeUndefined(); }
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
    [{ state: 4 }, 'CPU_STATE', 4],
    [{ challenge: true }, 'AUTHENTICATION_REQUIRED', 2],
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
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 's7proxy-loopback-tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-keyout', join(directory, 'key.pem'),
      '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
    credentials = { key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')) };
  });
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
  it('carries TLS inside COTP, creates V1 then sets up V2 and correlates counters', async () => {
    const server = await fixture({ tls: credentials });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, securityMode: 'tls', tls: { ca: credentials.cert, servername: 'localhost' } });
    try {
      await client.connect();
      const result = await client.readSymbolic({ accessArea: 0x8A0E0001, lids: [1] });
      expect(result.value.value).toBe(42);
      expect(client.report).toMatchObject({ securityMode: 'TLS_VERIFIED', protocolVersion: 2, sessionEstablished: true });
      expect(server.requests.map(request => request.frame[1])).toEqual([1, 1, 2, 2, 2, 2]);
      expect(server.tlsRecords).toBeGreaterThan(0);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
  it.each(['wrongHost', 'untrustedCA', 'abort', 'badIntegrity'])('stops without downgrade on %s', async mode => {
    const server = await fixture({ tls: mode === 'abort' ? undefined : credentials, badIntegrity: mode === 'badIntegrity' });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, securityMode: 'tls',
      tls: { ca: mode === 'untrustedCA' ? rootCertificates[0] : credentials.cert, servername: mode === 'wrongHost' ? 'wrong.invalid' : 'localhost' }, limits: { requestTimeoutMs: 500 } });
    try {
      const code = mode === 'badIntegrity' ? 'INDETERMINATE_PROTOCOL_ERROR' : mode === 'abort' ? 'PEER_CLOSED' : 'CERTIFICATE_REJECTED';
      await expect(client.connect()).rejects.toMatchObject({ code });
      expect(client.report.failure).toMatchObject({ code, phase: mode === 'badIntegrity' ? 'ready' : 'tls' });
      expect(server.requests).toHaveLength(mode === 'badIntegrity' ? 4 : 1);
      expect(client.connected).toBe(false);
      if (mode !== 'abort') expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
});