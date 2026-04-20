// @ts-check
import { describe, it, expect, vi } from 'vitest';
import { StructManager } from '../../src/protocol/struct-manager.js';
import { DBStruct } from '../../src/protocol/db-struct.js';
import { S7AreaDB, S7WLByte, S7_MSG_ACK, S7_MSG_ACK_DATA } from '../../src/protocol/constants.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** @returns {import('../../src/protocol/db-struct.js').S7StructDef} */
function motorDef() {
  return {
    name: 'MotorDB',
    db: 10,
    offset: 0,
    items: [
      { name: 'speed', type: 'REAL' },
      { name: 'running', type: 'BOOL' },
      { name: 'fault', type: 'BOOL' },
      { name: 'setpoint', type: 'REAL' },
      { name: 'label', type: 'STRING', strlen: 8 },
    ],
  };
}

/**
 * @param {number | Buffer} value
 * @returns {Buffer}
 */
function makeReadAckDataResponse(value) {
  const payload = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : (() => {
      const buf = Buffer.alloc(2);
      buf.writeInt16BE(value, 0);
      return buf;
    })();
  const response = Buffer.alloc(25 + payload.length);
  response[21] = 0xFF;
  response[22] = 0x04;
  response.writeUInt16BE(payload.length * 8, 23);
  payload.copy(response, 25);
  return response;
}

/** @returns {Buffer} */
function makeWriteAckDataResponse() {
  const response = Buffer.alloc(22);
  response[21] = 0xFF;
  return response;
}

/**
 * @param {{ messageType: number, paramLength: number, response: Buffer }} writeReply
 */
function makeOnlineStructManager(writeReply) {
  const conn = {
    sendRequest: vi.fn()
      .mockResolvedValueOnce(makeReadAckDataResponse(10))
      .mockResolvedValueOnce(writeReply.response),
  };

  const bridge = {
    buildReadRequest: vi.fn(() => {
      const frame = Buffer.alloc(13);
      frame.writeUInt16BE(0x1001, 11);
      return frame;
    }),
    buildWriteRequest: vi.fn(() => {
      const frame = Buffer.alloc(13);
      frame.writeUInt16BE(0x1002, 11);
      return frame;
    }),
    parseFrame: vi.fn()
      .mockReturnValueOnce({
        cotpType: 0xF0,
        pdu: {
          raw: Buffer.alloc(0),
          messageType: S7_MSG_ACK_DATA,
          functionCode: 0x04,
          pduRef: 0x1001,
          paramLength: 2,
          dataLength: 6,
          errorClass: 0,
          errorCode: 0,
        },
      })
      .mockReturnValueOnce({
        cotpType: 0xF0,
        pdu: {
          raw: writeReply.response,
          messageType: writeReply.messageType,
          functionCode: 0,
          pduRef: 0x1002,
          paramLength: writeReply.paramLength,
          dataLength: 0,
          errorClass: 0,
          errorCode: 0,
        },
      }),
  };

  const sm = new StructManager({
    pool: /** @type {any} */ ({
      targetId: 'plc1',
      acquire: () => conn,
    }),
    bridge: /** @type {any} */ (bridge),
  });

  sm.register({
    name: 'WriteDB',
    db: 1,
    offset: 0,
    targetId: 'plc1',
    items: [{ name: 'x', type: 'INT' }],
  });

  return { sm, conn, bridge };
}

function makeAtomicBitWriteStructManager() {
  const writeResponse = makeWriteAckDataResponse();
  const refreshedStruct = Buffer.from([0x02, 0x00, 0x00, 0x2A]);
  const conn = {
    sendRequest: vi.fn()
      .mockResolvedValueOnce(writeResponse)
      .mockResolvedValueOnce(makeReadAckDataResponse(refreshedStruct)),
  };

  const bridge = {
    buildBitWriteRequest: vi.fn(() => {
      const frame = Buffer.alloc(13);
      frame.writeUInt16BE(0x2001, 11);
      return frame;
    }),
    buildReadRequest: vi.fn(() => {
      const frame = Buffer.alloc(13);
      frame.writeUInt16BE(0x2002, 11);
      return frame;
    }),
    parseFrame: vi.fn()
      .mockReturnValueOnce({
        cotpType: 0xF0,
        pdu: {
          raw: writeResponse,
          messageType: S7_MSG_ACK_DATA,
          functionCode: 0x05,
          pduRef: 0x2001,
          paramLength: 2,
          dataLength: 1,
          errorClass: 0,
          errorCode: 0,
        },
      })
      .mockReturnValueOnce({
        cotpType: 0xF0,
        pdu: {
          raw: Buffer.alloc(0),
          messageType: S7_MSG_ACK_DATA,
          functionCode: 0x04,
          pduRef: 0x2002,
          paramLength: 2,
          dataLength: 8,
          errorClass: 0,
          errorCode: 0,
        },
      }),
  };

  const sm = new StructManager({
    pool: /** @type {any} */ ({
      targetId: 'plc1',
      acquire: () => conn,
    }),
    bridge: /** @type {any} */ (bridge),
  });

  sm.register({
    name: 'BitDB',
    db: 1,
    offset: 4,
    targetId: 'plc1',
    items: [
      { name: 'a', type: 'BOOL' },
      { name: 'b', type: 'BOOL' },
      { name: 'word', type: 'INT' },
    ],
  });

  return { sm, conn, bridge };
}

// ─── Registry ────────────────────────────────────────────────────────────────

describe('StructManager registry', () => {
  it('register / get / has / list', () => {
    const sm = new StructManager();
    const struct = sm.register(motorDef());
    expect(struct).toBeInstanceOf(DBStruct);
    expect(sm.has('MotorDB')).toBe(true);
    expect(sm.get('MotorDB')).toBe(struct);
    expect(sm.list()).toEqual(['MotorDB']);
  });

  it('registerMany', () => {
    const sm = new StructManager();
    const structs = sm.registerMany([
      motorDef(),
      { name: 'Sensor', db: 11, offset: 0, items: [{ name: 'temp', type: 'REAL' }] },
    ]);
    expect(structs.length).toBe(2);
    expect(sm.list()).toEqual(['MotorDB', 'Sensor']);
  });

  it('unregister', () => {
    const sm = new StructManager();
    sm.register(motorDef());
    sm.unregister('MotorDB');
    expect(sm.has('MotorDB')).toBe(false);
    expect(sm.list()).toEqual([]);
  });

  it('listInfo returns field names and sizes', () => {
    const sm = new StructManager();
    sm.register(motorDef());
    const info = sm.listInfo();
    expect(info.length).toBe(1);
    expect(info[0].name).toBe('MotorDB');
    expect(info[0].db).toBe(10);
    expect(info[0].fields).toEqual(['speed', 'running', 'fault', 'setpoint', 'label']);
    expect(info[0].size).toBeGreaterThan(0);
  });

  it('emits registered / unregistered events', () => {
    const sm = new StructManager();
    const registered = vi.fn();
    const unregistered = vi.fn();
    sm.on('registered', registered);
    sm.on('unregistered', unregistered);
    sm.register(motorDef());
    expect(registered).toHaveBeenCalledWith('MotorDB', expect.any(DBStruct));
    sm.unregister('MotorDB');
    expect(unregistered).toHaveBeenCalledWith('MotorDB');
  });

  it('requireStruct throws for unregistered', () => {
    const sm = new StructManager();
    expect(() => sm.getCachedValues('Nope')).not.toThrow(); // undefined is fine
    // But read/write/subscribe should throw
  });
});

// ─── Read with key filter ────────────────────────────────────────────────────

describe('StructManager read key filter (offline validation)', () => {
  it('read throws without pool/bridge', async () => {
    const sm = new StructManager();
    sm.register(motorDef());
    await expect(sm.read('MotorDB')).rejects.toThrow('requires a ConnectionPool');
  });

  it('read throws for unregistered struct', async () => {
    const sm = new StructManager();
    await expect(sm.read('Missing')).rejects.toThrow('not registered');
  });

  it('read with keys still validates struct exists', async () => {
    const sm = new StructManager();
    await expect(sm.read('Missing', ['x'])).rejects.toThrow('not registered');
  });
});

// ─── DAQ struct decoding ─────────────────────────────────────────────────────

describe('StructManager DAQ integration', () => {
  it('decodes struct:data from DAQ subscription events', () => {
    // Create a mock DAQ engine (EventEmitter)
    const { EventEmitter } = require('node:events');
    const mockDaq = /** @type {any} */ (new EventEmitter());
    mockDaq.subscribe = vi.fn(() => 'sub-1');
    mockDaq.unsubscribe = vi.fn();

    const sm = new StructManager({ daq: /** @type {any} */ (mockDaq) });
    sm.register({ name: 'TestDB', db: 5, offset: 0, items: [
      { name: 'val', type: 'INT', value: 0 },
    ]});

    const subId = sm.subscribe('TestDB', 'plc1', 500);
    const subscription = sm.getStructSubscriptions()[0];
    expect(subId).toBe('sub-1');
    expect(mockDaq.subscribe).toHaveBeenCalledWith({
      targetId: 'plc1',
      tags: [expect.objectContaining({
        name: expect.stringMatching(/^struct:TestDB:/),
        area: 0x84,
        target: 'plc1',
      })],
      intervalMs: 500,
    });

    // Simulate DAQ emitting data
    const structDataCb = vi.fn();
    sm.on('struct:data', structDataCb);

    // Encode a test value (INT 42 → 0x002A)
    const buf = Buffer.alloc(2);
    buf.writeInt16BE(42, 0);

    mockDaq.emit('subscription:data', 'sub-1', {
      targetId: 'plc1',
      groupId: 'plc1:500',
      tags: [{ name: subscription.tagName, value: buf.toString('hex'), quality: 192, timestamp: Date.now() }],
    });

    expect(structDataCb).toHaveBeenCalledWith(expect.objectContaining({
      structName: 'TestDB',
      values: { val: 42 },
    }));

    // Cached values should be updated
    expect(sm.getCachedValues('TestDB')).toEqual({ val: 42 });
  });

  it('unsubscribe cleans up', () => {
    const { EventEmitter } = require('node:events');
    const mockDaq = /** @type {any} */ (new EventEmitter());
    mockDaq.subscribe = vi.fn(() => 'sub-2');
    mockDaq.unsubscribe = vi.fn();

    const sm = new StructManager({ daq: /** @type {any} */ (mockDaq) });
    sm.register({ name: 'X', db: 1, offset: 0, items: [{ name: 'a', type: 'BYTE' }] });

    const subId = sm.subscribe('X', 'plc1', 1000);
    sm.unsubscribe(subId);

    expect(mockDaq.unsubscribe).toHaveBeenCalledWith('sub-2');
    expect(sm.getStructSubscriptions()).toEqual([]);
  });
});

// ─── Error cases ─────────────────────────────────────────────────────────────

describe('StructManager error handling', () => {
  it('read throws without pool/bridge', async () => {
    const sm = new StructManager();
    sm.register({ name: 'Err', db: 1, offset: 0, items: [{ name: 'x', type: 'INT' }] });
    await expect(sm.read('Err')).rejects.toThrow('requires a ConnectionPool');
  });

  it('write throws without pool/bridge', async () => {
    const sm = new StructManager();
    sm.register({ name: 'Err', db: 1, offset: 0, items: [{ name: 'x', type: 'INT' }] });
    await expect(sm.write('Err', { x: 1 })).rejects.toThrow('requires a ConnectionPool');
  });

  it('subscribe throws without DAQ', () => {
    const sm = new StructManager();
    sm.register({ name: 'Err', db: 1, offset: 0, items: [{ name: 'x', type: 'INT' }] });
    expect(() => sm.subscribe('Err', 'plc1', 500)).toThrow('requires a DaqEngine');
  });

  it('read throws for unregistered struct', async () => {
    const sm = new StructManager();
    await expect(sm.read('Missing')).rejects.toThrow('not registered');
  });

  it('write throws for unregistered struct', async () => {
    const sm = new StructManager();
    await expect(sm.write('Missing', { x: 1 })).rejects.toThrow('not registered');
  });

  it('accepts bare ACK write responses without requiring a function code', async () => {
    const { sm, conn } = makeOnlineStructManager({
      messageType: S7_MSG_ACK,
      paramLength: 2,
      response: Buffer.alloc(19),
    });

    await expect(sm.write('WriteDB', { x: 42 })).resolves.toBeUndefined();
    expect(conn.sendRequest).toHaveBeenCalledTimes(2);
    expect(sm.getCachedValues('WriteDB')).toEqual({ x: 42 });
  });

  it('still accepts ACK_DATA write responses with a success return code', async () => {
    const response = makeWriteAckDataResponse();

    const { sm, conn } = makeOnlineStructManager({
      messageType: S7_MSG_ACK_DATA,
      paramLength: 2,
      response,
    });

    await expect(sm.write('WriteDB', { x: 42 })).resolves.toBeUndefined();
    expect(conn.sendRequest).toHaveBeenCalledTimes(2);
    expect(sm.getCachedValues('WriteDB')).toEqual({ x: 42 });
  });

  it('writes a single BOOL as an atomic bit write and refreshes the struct cache', async () => {
    const { sm, conn, bridge } = makeAtomicBitWriteStructManager();

    await expect(sm.write('BitDB', { b: true })).resolves.toBeUndefined();

    expect(bridge.buildBitWriteRequest).toHaveBeenCalledWith(
      S7AreaDB,
      1,
      4,
      1,
      true,
    );
    expect(bridge.buildReadRequest).toHaveBeenCalledWith(S7AreaDB, 1, 4, 4, S7WLByte);
    expect(bridge.buildBitWriteRequest.mock.invocationCallOrder[0]).toBeLessThan(bridge.buildReadRequest.mock.invocationCallOrder[0]);
    expect(conn.sendRequest).toHaveBeenCalledTimes(2);
    expect(sm.getCachedValues('BitDB')).toEqual({ a: false, b: true, word: 42 });
  });
});

// ─── Shutdown ────────────────────────────────────────────────────────────────

describe('StructManager shutdown', () => {
  it('clears everything', () => {
    const { EventEmitter } = require('node:events');
    const mockDaq = /** @type {any} */ (new EventEmitter());
    mockDaq.subscribe = vi.fn(() => 'sub-99');
    mockDaq.unsubscribe = vi.fn();

    const sm = new StructManager({ daq: /** @type {any} */ (mockDaq) });
    sm.register({ name: 'A', db: 1, offset: 0, items: [{ name: 'x', type: 'INT' }] });
    sm.subscribe('A', 'plc1', 500);

    sm.shutdown();

    expect(sm.list()).toEqual([]);
    expect(sm.getStructSubscriptions()).toEqual([]);
    expect(mockDaq.unsubscribe).toHaveBeenCalled();
  });
});
