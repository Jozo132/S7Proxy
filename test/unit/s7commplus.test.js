// @ts-check
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { rootCertificates } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { Cursor, decodeValue, vlq, u32, PlusAssembler, encodeOperation, assertOutgoing, responsePayload, decodeObjects } from '../../src/protocol/s7commplus/codec.js';
import { S7CommPlusClient } from '../../src/client/s7commplus-client.js';
import { fixture, validateSessionRequest, encodeTestUInt64 } from '../s7commplus-fixture.js';
import { saveSoftwareSnapshot, verifySoftwareSnapshot } from '../helpers/program-store.js';

const context = { version: 1, sessionId: 0x12345678 };
describe('S7CommPlus read-only codec', () => {
  it('encodes only the current-alarm diagnostic Explore request', () => {
    const operation = { kind: 'readActiveAlarms', objectId: 8, recursive: true, attributes: [2670, 2671, 2672, 2673, 2677, 4079, 7813, 233, 7917, 2715] };
    const secured = { sessionId: 77, version: 2, integrityId: 7 };
    const frame = encodeOperation(operation, secured, 5);
    expect(frame.readUInt16BE(7)).toBe(0x04BB);
    expect(frame.subarray(18, -4).toString('hex')).toBe('00000008946b010100000a946e946f9470947194759f6fbd058169bd6d951b070000000000');
    expect(() => assertOutgoing(frame, operation, secured, 5)).not.toThrow();
    for (const change of [{ objectId: 52 }, { recursive: false }, { attributes: [2670] }, { attribute: 1 }]) {
      expect(() => encodeOperation({ ...operation, ...change }, secured, 5)).toThrow(/exact alarm subsystem/);
    }
    expect(() => encodeOperation(operation, { ...secured, version: 1 }, 5)).toThrow(/TLS V2/);
    expect(() => encodeOperation(operation, { ...secured, sessionId: 0 }, 5)).toThrow(/TLS V2/);
    frame[23] ^= 1;
    expect(() => assertOutgoing(frame, operation, secured, 5)).toThrow(/canonical/);
  });
  it('restricts targets, read-only mode, pacing and TLS configuration before connecting', async () => {
    expect(() => new S7CommPlusClient({ host: 'invalid/host' })).toThrow(/IP address or hostname/);
    expect(() => new S7CommPlusClient({ host: '127.0.0.1', productionReadOnly: false })).toThrow(/cannot disable/);
    expect(() => new S7CommPlusClient({ host: '127.0.0.1', limits: { pacingMs: 1 } })).toThrow(/Pacing/);
    expect(() => new S7CommPlusClient({ host: '127.0.0.1', limits: { maxConnectionsPerTarget: 17 } })).toThrow(/allocation/);
    expect(() => new S7CommPlusClient({ host: '127.0.0.1', limits: { maxQueuedRequests: 4097 } })).toThrow(/allocation/);
    expect(() => new S7CommPlusClient({ host: '127.0.0.1', securityMode: 'tls' })).toThrow(/CA certificate/);
    const client = new S7CommPlusClient({ host: '127.0.0.1' });
    await expect(client.uploadBlock({ number: 1 })).rejects.toThrow(/nothing transmitted/);
    expect(client.report.statistics.sentBytes).toBe(0);
    await expect(client.readSymbolic({ accessArea: 1, lids: [1] })).rejects.toThrow(/session/);
  });
  it.each(['write', 'download', 'delete', 'cpuControl', 'invoke', 'setVariable', 'upload', '__proto__'])('denies %s before serialization', kind => {
    expect(() => encodeOperation({ kind }, context, 0)).toThrow(/not allowlisted/);
  });
  it('denies CPU start and stop without a dedicated authorization context', () => {
    for (const kind of ['cpuStart', 'cpuStop']) {
      expect(() => encodeOperation({ kind }, context, 0)).toThrow(/not allowlisted/);
    }
  });
  it('encodes only the explicitly authorized V2 CPU RUN request and rechecks its bytes', () => {
    const authorized = { version: 2, sessionId: 77, integrityId: 0, cpuStartAuthorized: true };
    const frame = encodeOperation({ kind: 'cpuStart' }, authorized, 6);
    expect(frame.toString('hex')).toBe('7202003531000004f2000000060000004d3400000034019077000803000004e88969001200000000896a001300896b0004000000000000000072020000');
    expect(() => assertOutgoing(frame, { kind: 'cpuStart' }, authorized, 6)).not.toThrow();
    expect(() => assertOutgoing(frame, { kind: 'cpuStart' }, { ...authorized, cpuStartAuthorized: false }, 6)).toThrow(/not allowlisted/);
    expect(() => encodeOperation({ kind: 'cpuStop' }, authorized, 6)).toThrow(/not allowlisted/);
    expect(() => encodeOperation({ kind: 'setVariable' }, authorized, 6)).toThrow(/not allowlisted/);
    expect(() => encodeOperation({ kind: 'cpuStart', objectId: 53 }, authorized, 6)).toThrow(/arbitrary/);
    expect(() => encodeOperation({ kind: 'cpuStart' }, { ...authorized, sessionId: 0 }, 6)).toThrow(/owned TLS/);
    expect(() => encodeOperation({ kind: 'cpuStart' }, { ...authorized, version: 1 }, 6)).toThrow(/owned TLS/);
    frame[28] = 1;
    expect(() => assertOutgoing(frame, { kind: 'cpuStart' }, authorized, 6)).toThrow(/canonical/);
  });
  it('accepts larger inventories within the current default and explicit object budgets', () => {
    const bytes = Buffer.concat(Array.from({ length: 156 }, (_, index) =>
      Buffer.concat([Buffer.from([0xA1]), u32(index + 1), vlq(511), Buffer.from([0, 0, 0xA2])])));
    expect(decodeObjects(new Cursor(bytes))).toHaveLength(156);
    expect(() => decodeObjects(new Cursor(bytes), 32)).toThrow(/Object count/);
    expect(decodeObjects(new Cursor(bytes), 256)).toHaveLength(156);
    const client = new S7CommPlusClient({ host: '127.0.0.1', limits: { maxObjects: 256, requestTimeoutMs: 3000 } });
    expect(client.report.limits).toMatchObject({ maxObjects: 256, requestTimeoutMs: 3000, tlsHandshakeTimeoutMs: 10000 });
    expect(() => new S7CommPlusClient({ host: '127.0.0.1', limits: { maxObjects: 262145 } })).toThrow(/allocation/);
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
  it('extracts informational and negative low-word codes from positive composite statuses', () => {
    const header = Buffer.from('32000004ca0000000136', 'hex');
    const accepted = Buffer.concat([header, encodeTestUInt64(0x6000000000000011n), Buffer.from([1, 77])]);
    expect(responsePayload(accepted, 0x04CA, 1, true).statusDetails.serviceResultCode).toBe(17);
    expect(() => responsePayload(accepted, 0x04CA, 1)).toThrow(/ReturnValue/);
    const rejected = Buffer.concat([header, encodeTestUInt64(0x6000000000008001n), Buffer.alloc(5)]);
    expect(() => responsePayload(rejected, 0x04CA, 1, true)).toThrow(/ReturnValue/);
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
  it('rejects an unqualified current-alarm diagnostic profile without sending the query', async () => {
    const server = await fixture();
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port });
    try {
      await expect(client.readActiveAlarms()).rejects.toMatchObject({ code: 'SESSION_REQUIRED' });
      await client.connect();
      const count = server.requests.length;
      await expect(client.readActiveAlarms()).rejects.toMatchObject({ code: 'UNSUPPORTED_PROFILE' });
      expect(server.requests).toHaveLength(count);
      expect(client.connected).toBe(true);
      expect(client.report.failure).toBeNull();
    } finally { await client.disconnect(); await server.close(); }
  });
  it('records a reset during explicit disconnect as a teardown warning', async () => {
    const server = await fixture({ resetOnDisconnect: true });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port });
    try {
      await client.connect();
      const sample = await client.readSymbolic({ accessArea: 0x8A0E0001, lids: [1] });
      expect(sample.value.value).toBe(42);
      expect(client.report.failure).toBeNull();
      const requests = server.requests.length;
      await Promise.all([client.disconnect(), client.disconnect()]);
      expect(client.report).toMatchObject({ connected: false, phase: 'closed', failure: null,
        teardownWarning: { code: 'TRANSPORT_REJECTED', phase: 'closed', details: { transportCode: 'ECONNRESET' } } });
      expect(server.requests).toHaveLength(requests);
      const report = client.report;
      if (!report.teardownWarning) throw new Error('Missing teardown warning');
      report.teardownWarning.message = 'tampered';
      expect(client.report.teardownWarning?.message).toContain('ECONNRESET');
      await client.disconnect();
      expect(client.report.failure).toBeNull();
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
  it('keeps a reset during an active read fatal after disconnect', async () => {
    const server = await fixture({ resetOnRead: true });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port });
    try {
      await client.connect();
      await expect(client.readSymbolic({ accessArea: 0x8A0E0001, lids: [1] })).rejects.toMatchObject({
        code: 'TRANSPORT_REJECTED', details: { transportCode: 'ECONNRESET' },
      });
      const failure = client.report.failure;
      expect(failure).toMatchObject({ code: 'TRANSPORT_REJECTED', phase: 'ready' });
      await client.disconnect();
      expect(client.report.failure).toEqual(failure);
      expect(client.report.teardownWarning).toBeNull();
      expect(client.connected).toBe(false);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
  it('settles cancelled active and queued reads when teardown resets the socket', async () => {
    const server = await fixture({ resetOnDisconnect: true, readStall: true });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port });
    try {
      await client.connect();
      const pending = Promise.allSettled(Array.from({ length: 3 }, () => client.readSymbolic({ accessArea: 0x8A0E0001, lids: [1] })));
      await vi.waitFor(() => expect(server.requests.some(request => request.functionCode === 0x054C)).toBe(true));
      await client.disconnect();
      const results = await pending;
      expect(results).toHaveLength(3);
      expect(results.every(result => result.status === 'rejected' && result.reason.code === 'DISCONNECTED')).toBe(true);
      expect(client.report).toMatchObject({ connected: false, failure: null,
        teardownWarning: { details: { transportCode: 'ECONNRESET' } },
        concurrency: { activeConnectionsPerTarget: 0, queuedRequests: 0, inFlightRequests: 0 } });
      expect(server.requests.filter(request => request.functionCode === 0x054C)).toHaveLength(1);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
  it.each(['rejected', 'error2'])('continues past recognized legacy InitSSL %s only in an explicit legacy profile', async legacyInit => {
    const server = await fixture({ legacyInit: /** @type {'rejected'|'error2'} */ (legacyInit) });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, securityMode: 'legacy' });
    try {
      await client.connect();
      expect(client.connected).toBe(true);
      expect(client.report.observations).toContainEqual(expect.objectContaining({ kind: 'legacyInitSSLStatus', serviceResultCode: legacyInit === 'error2' ? -119 : -519 }));
      expect(server.requests).toHaveLength(5);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
    const strictServer = await fixture({ legacyInit: /** @type {'rejected'|'error2'} */ (legacyInit) });
    const strict = new S7CommPlusClient({ host: '127.0.0.1', port: strictServer.port, securityMode: 'tls', tls: { allowAnyCertificate: true } });
    try {
      await expect(strict.connect()).rejects.toMatchObject({ code: legacyInit === 'error2' ? 'INDETERMINATE_PROTOCOL_ERROR' : 'INITSSL_REJECTED' });
      expect(strictServer.requests).toHaveLength(1);
    } finally { await strict.disconnect(); await strictServer.close(); }
  });
  it('establishes one session, checks health, explores and reads one typed value', async () => {
    const server = await fixture();
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port });
    try {
      await client.connect();
      expect(client.report.identity).toMatchObject({ orderNumber: 'TEST-ORDER', firmware: 'V0.0', model: null });
      expect(client.report.cpuState).toBe('RUN');
      expect(client.report.effectiveProtectionLevel).toBe(2);
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
  it('bounds parallel endpoint sessions and releases only the disconnected connection', async () => {
    const server = await fixture();
    const clients = Array.from({ length: 3 }, (_, index) => new S7CommPlusClient({ host: '127.0.0.1', port: server.port, limits: { maxConnectionsPerTarget: index === 2 ? 16 : 2 } }));
    try {
      await Promise.all(clients.slice(0, 2).map(client => client.connect()));
      await expect(clients[2].connect()).rejects.toMatchObject({ code: 'SESSION_LIMIT' });
      const values = await Promise.all(clients.slice(0, 2).map(client => client.readSymbolic({ accessArea: 0x8A0E0001, lids: [9] })));
      expect(values.map(value => value.value.value)).toEqual([42, 42]);
      expect(clients.slice(0, 2).map(client => client.report.statistics.requests)).toEqual([6, 6]);
      await clients[0].disconnect();
      await clients[0].disconnect();
      await clients[2].connect();
      expect(await clients[1].readCpuState()).toBe('RUN');
      expect(clients[2].connected).toBe(true);
      expect(server.errors).toEqual([]);
    } finally { await Promise.all(clients.map(client => client.disconnect())); await server.close(); }
  });
  it('accounts for host and port separately and releases slots after failed handshakes', async () => {
    const options = { wrongSequence: true };
    const server = await fixture(options);
    const otherServer = await fixture();
    const failed = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, limits: { maxConnectionsPerTarget: 1 } });
    const clients = [server, otherServer].map(endpoint => new S7CommPlusClient({ host: '127.0.0.1', port: endpoint.port, limits: { maxConnectionsPerTarget: 1 } }));
    try {
      await expect(failed.connect()).rejects.toMatchObject({ code: 'CORRELATION' });
      expect(failed.report.concurrency.activeConnectionsPerTarget).toBe(0);
      options.wrongSequence = false;
      await Promise.all(clients.map(client => client.connect()));
      expect(clients.every(client => client.connected)).toBe(true);
      expect(clients.map(client => client.report.concurrency.activeConnectionsPerTarget)).toEqual([1, 1]);
    } finally { await Promise.all([failed, ...clients].map(client => client.disconnect())); await Promise.all([server.close(), otherServer.close()]); }
  });
  it('queues concurrent calls FIFO with independent address snapshots and response correlation', async () => {
    const server = await fixture();
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port });
    try {
      await client.connect();
      const addresses = [9, 10, 11].map(lid => ({ accessArea: 0x8A0E0001, lids: [lid] }));
      const reads = addresses.map(address => client.readSymbolic(address));
      addresses[1].lids[0] = 999;
      expect(client.report.concurrency).toMatchObject({ inFlightRequests: 1, queuedRequests: 2 });
      const results = await Promise.all(reads);
      expect(results.map(result => result.correlation.sequence)).toEqual([5, 6, 7]);
      expect(results.map(result => result.correlation.request.lids)).toEqual([[9], [10], [11]]);
      expect(results.map(result => result.address.lids)).toEqual([[9], [10], [11]]);
      expect(results.every(result => result.timing.sentAtMonotonicMs > 0 && result.timing.receivedAtMonotonicMs >= result.timing.sentAtMonotonicMs && result.timing.latencyMs >= 0)).toBe(true);
      expect(client.report.concurrency).toMatchObject({ inFlightRequests: 0, queuedRequests: 0 });
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
  it('rejects queue overflow without closing the healthy session or sending the rejected call', async () => {
    const server = await fixture();
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, limits: { maxQueuedRequests: 1 } });
    try {
      await client.connect();
      const first = client.readSymbolic({ accessArea: 0x8A0E0001, lids: [9] });
      const second = client.readSymbolic({ accessArea: 0x8A0E0001, lids: [10] });
      await expect(client.readSymbolic({ accessArea: 0x8A0E0001, lids: [11] })).rejects.toMatchObject({ code: 'REQUEST_QUEUE_FULL' });
      await Promise.all([first, second]);
      expect(client.connected).toBe(true);
      expect(client.report.failure).toBeNull();
      expect(server.requests).toHaveLength(7);
    } finally { await client.disconnect(); await server.close(); }
  });
  it('does not exceed the request budget when concurrent calls are queued', async () => {
    const server = await fixture();
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, limits: { maxRequests: 6 } });
    try {
      await client.connect();
      const results = await Promise.allSettled([9, 10, 11].map(lid => client.readSymbolic({ accessArea: 0x8A0E0001, lids: [lid] })));
      expect(results[0].status).toBe('fulfilled');
      expect(results.slice(1).every(result => result.status === 'rejected' && result.reason.code === 'REQUEST_LIMIT')).toBe(true);
      expect(client.report.statistics.requests).toBe(6);
      expect(client.report.concurrency.queuedRequests).toBe(0);
      expect(server.requests).toHaveLength(6);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
  it.each(['disconnect', 'disconnect-pending', 'timeout'])('settles active and queued requests on %s without affecting another session', async mode => {
    const server = await fixture({ readStall: true });
    const clients = Array.from({ length: 2 }, () => new S7CommPlusClient({ host: '127.0.0.1', port: server.port, limits: { requestTimeoutMs: 400 } }));
    try {
      await Promise.all(clients.map(client => client.connect()));
      const results = Promise.allSettled([9, 10, 11].map(lid => clients[0].readSymbolic({ accessArea: 0x8A0E0001, lids: [lid] })));
      if (mode === 'disconnect-pending') await vi.waitFor(() => expect(server.requests.some(request => request.functionCode === 0x054C)).toBe(true));
      if (mode !== 'timeout') await clients[0].disconnect();
      const settled = await results;
      expect(settled.every(result => result.status === 'rejected' && result.reason.code === (mode === 'timeout' ? 'TIMEOUT' : 'DISCONNECTED'))).toBe(true);
      expect(clients[0].report.concurrency.queuedRequests).toBe(0);
      expect(await clients[1].readCpuState()).toBe('RUN');
      expect(server.requests.filter(request => request.functionCode === 0x054C)).toHaveLength(mode === 'disconnect' ? 0 : 1);
      expect(server.errors).toEqual([]);
    } finally { await Promise.all(clients.map(client => client.disconnect())); await server.close(); }
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
  it('supports TLS for the configured default target without opening a socket on construction', () => {
    vi.stubEnv('S7PROXY_PRODUCTION_HOST', '192.0.2.10');
    try {
      const client = new S7CommPlusClient({ securityMode: 'tls', tls: { allowAnyCertificate: true } });
      expect(client.report).toMatchObject({ target: { host: '192.0.2.10', port: 102 }, statistics: { sentBytes: 0 } });
    } finally { vi.unstubAllEnvs(); }
  });
  it('supports explicit configured hosts independently of lab and production environment labels', () => {
    vi.stubEnv('S7PROXY_PRODUCTION_HOST', '192.0.2.10');
    vi.stubEnv('S7PROXY_LAB_HOST', '192.0.2.11');
    try {
      const lab = new S7CommPlusClient({ host: '192.0.2.11', securityMode: 'legacy' });
      expect(lab.report).toMatchObject({ selectedProfile: 'LEGACY_PLAINTEXT', productionReadOnly: true });
      expect(() => new S7CommPlusClient({ host: '192.0.2.11', securityMode: /** @type {any} */ ('auto') })).toThrow(/fallback/);
      for (const host of ['192.0.2.10', '192.0.2.12', 'plc.example.test', '::1']) {
        const client = new S7CommPlusClient({ host, port: 1102, securityMode: 'tls', tls: { allowAnyCertificate: true } });
        expect(client.report).toMatchObject({ target: { host, port: 1102 }, statistics: { sentBytes: 0 } });
      }
      vi.stubEnv('S7PROXY_LAB_HOST', '192.0.2.10');
      expect(() => new S7CommPlusClient({ host: '192.0.2.10', securityMode: 'legacy' })).not.toThrow();
      vi.stubEnv('S7PROXY_PRODUCTION_HOST', 'invalid-fallback');
      expect(() => new S7CommPlusClient({ host: 'plc.example.test', securityMode: 'legacy' })).not.toThrow();
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
  it('validates current-alarm diagnostic options locally and reads available languages in STOP', async () => {
    const server = await fixture({ tls: credentials, state: 4, currentAlarms: 'present' });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, securityMode: 'tls',
      tls: { ca: credentials.cert, certificateSha256 } });
    try {
      await client.connect();
      const count = server.requests.length;
      for (const options of [null, [], { languageId: 0 }, { languageId: 65536 }, { maxAlarms: 0 }, { maxAlarms: 4097 }, { acknowledge: true }]) {
        await expect(client.readActiveAlarms(/** @type {any} */ (options))).rejects.toMatchObject({ code: 'ARGUMENT' });
      }
      expect(server.requests).toHaveLength(count);
      const snapshot = await client.readActiveAlarms({ languageId: 1031 });
      expect(snapshot.alarms[0].text).toBe('Testmeldung');
      expect(client.report.cpuState).toBe('STOP');
      expect(client.report.failure).toBeNull();
      expect(server.requests).toHaveLength(count + 1);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
  it.each(['present', 'empty', 'partial', 'invalidText', 'unknownClass', 'multiple'])('reads bounded current-alarm diagnostic snapshots over verified TLS (%s)', async mode => {
    const server = await fixture({ tls: credentials, currentAlarms: /** @type {'present'|'empty'|'partial'|'invalidText'|'unknownClass'|'multiple'} */ (mode) });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, securityMode: 'tls',
      tls: { ca: credentials.cert, certificateSha256 } });
    try {
      await client.connect();
      const snapshot = await client.readActiveAlarms({ languageId: 1033, maxAlarms: 1 });
      expect(snapshot.scope).toBe('CURRENT_UPDATE_RELEVANT_ALARMS_NOT_DIAGNOSTIC_HISTORY');
      expect(snapshot.alarms).toHaveLength(['empty', 'unknownClass'].includes(mode) ? 0 : 1);
      if (mode === 'present' || mode === 'multiple') {
        const alarm = snapshot.alarms[0];
        expect(BigInt(alarm.cpuAlarmId).toString(16)).toBe('8a7e000000010000');
        expect(alarm.text).toBe('I/O device unavailable');
        expect(alarm.infoText).toBe('PROFINET device missing');
        expect(alarm.availableLanguages).toEqual([1033, 1031]);
        expect(alarm.coming?.timestamp).toMatchObject({ nanosecondsSinceUnixEpoch: '1700000000123456789', utc: '2023-11-14T22:13:20.123Z', subMillisecondNanoseconds: 456789 });
        expect(alarm.coming?.acknowledgementTimestamp?.utc).toBeNull();
        expect(alarm.status).toBe('DECODED');
      }
      expect(snapshot.completeness).toBe(mode === 'multiple' ? 'TRUNCATED' : ['partial', 'invalidText', 'unknownClass'].includes(mode) ? 'PARTIAL' : 'BOUNDED_RESPONSE');
      if (mode === 'multiple') expect(snapshot.reportedAlarmCount).toBe(3);
      if (mode === 'partial') expect(snapshot.alarms[0].cpuAlarmId).toBeNull();
      if (mode === 'invalidText') expect(snapshot.alarms[0].text).toBeNull();
      expect(client.report.failure).toBeNull();
      expect(client.report.capabilities.currentAlarmRead).toBe(true);
      expect(client.productionReadOnly).toBe(true);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
  it.each(['complete', 'partial'])('reads communication resources with verified TLS integrity (%s)', async mode => {
    const server = await fixture({ tls: credentials, communicationResources: /** @type {'complete'|'partial'} */ (mode) });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, securityMode: 'tls',
      tls: { ca: credentials.cert, certificateSha256 } });
    try {
      await client.connect();
      const snapshot = await client.readCommunicationResources();
      expect(snapshot.completeness).toBe(mode === 'complete' ? 'COMPLETE' : 'PARTIAL');
      expect(snapshot.counters.tagsPerReadRequestMax.value).toBe(mode === 'complete' ? 64 : null);
      expect(snapshot.counters.subscriptionMemoryFree.value).toBe(9000);
      expect(snapshot.request.integrityId).not.toBeNull();
      expect(client.report.securityMode).toBe('TLS_VERIFIED');
      expect(client.report.failure).toBeNull();
      expect(client.report.capabilities.communicationResourceRead).toBe(true);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
  it.each(['disconnect', 'read', 'clean'])('classifies verified TLS resets during %s without masking acquisition errors', async resetAt => {
    const server = await fixture({ tls: credentials, resetOnDisconnect: resetAt === 'disconnect', resetOnRead: resetAt === 'read' });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, securityMode: 'tls',
      tls: { ca: credentials.cert, certificateSha256 } });
    try {
      await client.connect();
      if (resetAt === 'read') {
        await expect(client.readSymbolic({ accessArea: 0x8A0E0001, lids: [1] })).rejects.toMatchObject({ code: 'TRANSPORT_REJECTED' });
      } else {
        expect((await client.readSymbolic({ accessArea: 0x8A0E0001, lids: [1] })).value.value).toBe(42);
      }
      const before = client.report.failure;
      await client.disconnect();
      expect(client.report.securityMode).toBe('TLS_VERIFIED');
      expect(client.report.failure).toEqual(before);
      if (resetAt === 'disconnect') {
        expect(client.report.failure).toBeNull();
        expect(client.report.teardownWarning).toMatchObject({ details: { transportCode: 'ECONNRESET' } });
      } else if (resetAt === 'read') {
        expect(client.report.failure).toMatchObject({ code: 'TRANSPORT_REJECTED', phase: 'ready' });
        expect(client.report.teardownWarning).toBeNull();
      } else {
        expect(client.report.failure).toBeNull();
        expect(client.report.teardownWarning).toBeNull();
      }
      expect(client.connected).toBe(false);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
  it('keeps TLS integrity, native member ownership and queued reads isolated across parallel sessions', async () => {
    const server = await fixture({ tls: credentials, metadata: true });
    const clients = Array.from({ length: 2 }, () => new S7CommPlusClient({ host: '127.0.0.1', port: server.port, securityMode: 'tls',
      tls: { ca: credentials.cert, certificateSha256 }, limits: { maxRequests: 24 } }));
    try {
      await Promise.all(clients.map(client => client.connect()));
      const discoveries = await Promise.all(clients.map(client => client.listBlockMembers({ type: 'DB', number: 7 })));
      const members = discoveries.map(discovery => discovery.members.find(member => member.path === 'Enabled' && member.readable));
      if (!members[0] || !members[1]) throw new Error('Missing fixture members');
      await expect(clients[0].readMember(members[1])).rejects.toMatchObject({ code: 'UNVERIFIED_ADDRESS' });
      const results = await Promise.all(clients.flatMap((client, index) => [client.readMember(/** @type {NonNullable<typeof members[0]>} */ (members[index])), client.readMember(/** @type {NonNullable<typeof members[0]>} */ (members[index]))]));
      expect(results.every(result => result.observation.value === true && result.observation.quality === 'GOOD')).toBe(true);
      expect(clients.every(client => client.report.securityMode === 'TLS_VERIFIED')).toBe(true);
      await clients[0].disconnect();
      expect(await clients[1].readCpuState()).toBe('RUN');
      expect(server.errors).toEqual([]);
    } finally { await Promise.all(clients.map(client => client.disconnect())); await server.close(); }
  });
  it('requires exclusive endpoint ownership for CPU start and blocks new sessions during control', async () => {
    const server = await fixture({ tls: credentials, programContent: true, state: 4, cpuStart: 'success' });
    const clients = Array.from({ length: 3 }, () => new S7CommPlusClient({ host: '127.0.0.1', port: server.port, securityMode: 'tls',
      tls: { ca: credentials.cert, certificateSha256 }, limits: { maxRequests: 16 } }));
    const confirmation = { confirmRun: true, confirmTarget: `127.0.0.1:${server.port}` };
    try {
      await Promise.all(clients.slice(0, 2).map(client => client.connect()));
      await expect(clients[0].cpuStart(confirmation)).rejects.toMatchObject({ code: 'CONCURRENCY_LIMIT' });
      expect(server.requests.some(request => request.functionCode === 0x04F2)).toBe(false);
      await clients[1].disconnect();
      const start = clients[0].cpuStart(confirmation);
      await expect(clients[2].connect()).rejects.toMatchObject({ code: 'CONCURRENCY_LIMIT' });
      await expect(start).resolves.toMatchObject({ after: 'RUN', commandSent: true, verified: true });
      expect(server.errors).toEqual([]);
    } finally { await Promise.all(clients.map(client => client.disconnect())); await server.close(); }
  });
  it.each(['good', 'item-error', 'wrong-type'])('validates verified TLS read batches: %s', async mode => {
    const server = await fixture({ tls: credentials, metadata: true, memberError: mode === 'item-error', memberTypeMismatch: mode === 'wrong-type' });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, securityMode: 'tls',
      tls: { ca: credentials.cert, certificateSha256 }, limits: { maxRequests: 24, readPacingMs: 10 } });
    try {
      await client.connect();
      const discovery = await client.listBlockMembers({ type: 'DB', number: 7 });
      const member = discovery.members.find(candidate => candidate.path === 'Enabled' && candidate.readable);
      if (!member) throw new Error('Missing synthetic member');
      const members = Array(65).fill(member);
      if (mode === 'good') {
        for (let scan = 0; scan < 2; scan++) {
          const results = await client.readMembers(members);
          expect(results).toHaveLength(65);
          expect(results.every(result => result.observation.value === true && result.observation.quality === 'GOOD')).toBe(true);
          expect(results.every(result => result.request.sentAtMonotonicMs > 0 && result.request.receivedAtMonotonicMs >= result.request.sentAtMonotonicMs)).toBe(true);
          expect(new Set(results.map(result => result.request.sequence)).size).toBe(3);
        }
        expect(client.report.securityMode).toBe('TLS_VERIFIED');
      } else {
        await expect(client.readMembers(members)).rejects.toMatchObject({ code: mode === 'item-error' ? 'ITEM_REJECTED' : 'DATATYPE_MISMATCH' });
        expect(client.connected).toBe(false);
      }
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
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
  it.each(['success', 'rejected', 'unchanged', 'badIntegrity', 'badTail', 'lost', 'alreadyRun', 'unverifiedLab'])('performs one explicitly confirmed CPU start: %s', async mode => {
    const scenario = /** @type {'success'|'rejected'|'unchanged'|'badIntegrity'|'badTail'|'lost'} */ (mode === 'alreadyRun' || mode === 'unverifiedLab' ? 'success' : mode);
    const server = await fixture({ tls: credentials, programContent: true, state: mode === 'alreadyRun' ? 8 : 4, cpuStart: scenario });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, securityMode: 'tls',
      tls: mode === 'unverifiedLab' ? { allowAnyCertificate: true } : { ca: credentials.cert, certificateSha256 }, limits: { maxRequests: 12 } });
    try {
      await client.connect();
      await expect(client.cpuStart()).rejects.toMatchObject({ code: 'CPU_START_CONFIRMATION_REQUIRED' });
      await expect(client.cpuStart({ confirmRun: true, confirmTarget: 'wrong:102' })).rejects.toMatchObject({ code: 'CPU_START_CONFIRMATION_REQUIRED' });
      expect(server.requests).toHaveLength(5);
      const start = client.cpuStart({ confirmRun: true, confirmTarget: `127.0.0.1:${server.port}`, allowUnverifiedIdentity: mode === 'unverifiedLab' });
      await expect(client.cpuStart({ confirmRun: true, confirmTarget: `127.0.0.1:${server.port}` })).rejects.toMatchObject({ code: 'CONCURRENCY_LIMIT' });
      await expect(client.readCpuState()).rejects.toMatchObject({ code: 'CONCURRENCY_LIMIT' });
      await expect(client.explore(52)).rejects.toMatchObject({ code: 'CONCURRENCY_LIMIT' });
      if (mode === 'success' || mode === 'alreadyRun' || mode === 'unverifiedLab') {
        await expect(start).resolves.toMatchObject({ before: mode === 'alreadyRun' ? 'RUN' : 'STOP', after: 'RUN', commandSent: mode !== 'alreadyRun', verified: true });
        expect(await client.readCpuState()).toBe('RUN');
      } else {
        const code = mode === 'unchanged' ? 'CPU_START_NOT_CONFIRMED' : mode === 'badIntegrity' ? 'INDETERMINATE_PROTOCOL_ERROR'
          : mode === 'badTail' ? 'UNSUPPORTED_DECODING' : mode === 'lost' ? 'PEER_CLOSED' : 'PLC_REJECTED';
        await expect(start).rejects.toMatchObject({ code });
      }
      expect(server.requests.filter(request => request.functionCode === 0x04F2)).toHaveLength(mode === 'alreadyRun' ? 0 : 1);
      expect(client.productionReadOnly).toBe(mode === 'alreadyRun');
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
  it.each(['restricted', 'unverified', 'budget'])('denies CPU start before transmission when %s', async mode => {
    const server = await fixture({ tls: credentials, programContent: mode !== 'restricted', state: 4 });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, securityMode: 'tls',
      tls: mode === 'unverified' ? { allowAnyCertificate: true } : { ca: credentials.cert, certificateSha256 },
      limits: { maxRequests: mode === 'budget' ? 6 : 12 } });
    try {
      await client.connect();
      await expect(client.cpuStart({ confirmRun: true, confirmTarget: `127.0.0.1:${server.port}` })).rejects.toMatchObject({
        code: mode === 'restricted' ? 'ACCESS_RESTRICTED' : mode === 'unverified' ? 'SECURITY_REQUIRED' : 'REQUEST_LIMIT',
      });
      expect(server.requests).toHaveLength(5);
      expect(client.productionReadOnly).toBe(true);
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
  it.each(['noTrust', 'wrongTrust', 'challenge', 'nonzeroStatus'])('reads over explicitly unverified TLS with %s', async mode => {
    const server = await fixture({ tls: credentials, challenge: mode === 'challenge', nonzeroCreateStatus: mode === 'nonzeroStatus' });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, securityMode: 'tls',
      tls: { allowAnyCertificate: true, ...(mode === 'wrongTrust' ? { ca: rootCertificates[0], servername: 'wrong.invalid', certificateSha256: '00'.repeat(32) } : {}) } });
    try {
      await client.connect();
      const result = await client.readSymbolic({ accessArea: 0x8A0E0001, lids: [1] });
      expect(result.value.value).toBe(42);
      expect(client.report).toMatchObject({ securityMode: 'TLS_UNVERIFIED', allowAnyCertificate: true,
        peerCertificateSha256: certificateSha256, protocolVersion: 2, sessionEstablished: true,
        capabilities: { blockUpload: 'UNSUPPORTED_PROFILE' } });
      expect(server.tlsRecords).toBeGreaterThan(0);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
  it('requires a boolean TLS-only certificate opt-in', () => {
    expect(() => new S7CommPlusClient({ host: '127.0.0.1', securityMode: 'legacy', tls: { allowAnyCertificate: true } })).toThrow(/plaintext/);
    expect(() => new S7CommPlusClient({ host: '127.0.0.1', securityMode: 'tls', tls: { allowAnyCertificate: /** @type {any} */ ('true') } })).toThrow(/boolean/);
    expect(() => new S7CommPlusClient({ host: '127.0.0.1', securityMode: 'tls', tls: { allowAnyCertificate: false } })).toThrow(/CA certificate/);
  });
  it('supports an explicit TLS 1.3 AES-GCM profile', async () => {
    const server = await fixture({ tls: credentials });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, securityMode: 'tls',
      tls: { allowAnyCertificate: true, minVersion: 'TLSv1.3' } });
    try {
      await client.connect();
      expect(client.report.observations).toContainEqual(expect.objectContaining({ kind: 'tls', protocol: 'TLSv1.3',
        cipher: expect.stringMatching(/^TLS_AES_/), certificateVerified: false }));
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
    expect(() => new S7CommPlusClient({ host: '127.0.0.1', securityMode: 'tls',
      tls: { allowAnyCertificate: true, minVersion: /** @type {any} */ ('TLSv1') } })).toThrow(/minVersion/);
  });
  it('allows a slow TLS handshake without relaxing ordinary request deadlines', async () => {
    const server = await fixture({ tls: credentials, tlsDelayMs: 750 });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, securityMode: 'tls',
      tls: { allowAnyCertificate: true }, limits: { requestTimeoutMs: 500, tlsHandshakeTimeoutMs: 2000 } });
    try {
      await client.connect();
      expect(client.connected).toBe(true);
      expect(client.report.limits).toMatchObject({ requestTimeoutMs: 500, tlsHandshakeTimeoutMs: 2000 });
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
  it.each(['wrongHost', 'untrustedCA', 'wrongPin', 'abort', 'stallTLS', 'badIntegrity'])('stops without downgrade on %s', async mode => {
    const server = await fixture({ tls: mode === 'abort' ? undefined : credentials, abortTLS: mode === 'abort', stallTLS: mode === 'stallTLS', badIntegrity: mode === 'badIntegrity' });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, securityMode: 'tls',
      tls: { ca: mode === 'untrustedCA' ? rootCertificates[0] : credentials.cert, servername: mode === 'wrongHost' ? 'wrong.invalid' : 'localhost', certificateSha256: mode === 'wrongPin' ? '00'.repeat(32) : certificateSha256 }, limits: { requestTimeoutMs: 500, tlsHandshakeTimeoutMs: 500 } });
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
  it('accepts the CLI certificate opt-in only with TLS and skips CA/pin prerequisites', async () => {
    expect(() => execFileSync(process.execPath, ['src/plus-explore.js', '--live', '--legacy', '--allow-any-certificate'], { stdio: 'pipe' })).toThrow(/Usage/);
    const server = await fixture({ tls: credentials });
    try {
      const { stdout, stderr } = await new Promise((resolve, reject) => {
        execFile(process.execPath, ['src/plus-explore.js', '--live', '--host', '127.0.0.1', '--port', String(server.port), '--tls', '--tls-min-version', 'TLSv1.3', '--allow-any-certificate'], {
          timeout: 10000, env: { ...process.env, S7PLUS_TLS_CA: '/nonexistent/ca.pem', S7PLUS_TLS_CERT_SHA256: '' },
        }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
      });
      expect(stderr).toMatch(/identity is not authenticated/);
      expect(JSON.parse(stdout)).toMatchObject({ target: { host: '127.0.0.1', port: server.port }, targetKind: 'CONFIGURED', securityMode: 'TLS_UNVERIFIED', sessionEstablished: true, disconnected: true, statistics: { requests: 5 } });
      expect(server.errors).toEqual([]);
    } finally { await server.close(); }
  });
});