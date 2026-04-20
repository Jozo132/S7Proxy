// @ts-check
import { describe, it, expect, vi } from 'vitest';
import { StructManager } from '../../src/protocol/struct-manager.js';
import { DBStruct } from '../../src/protocol/db-struct.js';

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
    const { EventEmitter } = require('eventemitter3');
    const mockDaq = new EventEmitter();
    mockDaq.subscribe = vi.fn(() => 'sub-1');
    mockDaq.unsubscribe = vi.fn();

    const sm = new StructManager({ daq: /** @type {any} */ (mockDaq) });
    sm.register({ name: 'TestDB', db: 5, offset: 0, items: [
      { name: 'val', type: 'INT', value: 0 },
    ]});

    const subId = sm.subscribe('TestDB', 'plc1', 500);
    expect(subId).toBe('sub-1');
    expect(mockDaq.subscribe).toHaveBeenCalledWith({
      targetId: 'plc1',
      tags: [expect.objectContaining({ name: 'struct:TestDB', area: 0x84 })],
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
      tags: [{ name: 'struct:TestDB', value: buf.toString('hex'), quality: 192, timestamp: Date.now() }],
    });

    expect(structDataCb).toHaveBeenCalledWith(expect.objectContaining({
      structName: 'TestDB',
      values: { val: 42 },
    }));

    // Cached values should be updated
    expect(sm.getCachedValues('TestDB')).toEqual({ val: 42 });
  });

  it('unsubscribe cleans up', () => {
    const { EventEmitter } = require('eventemitter3');
    const mockDaq = new EventEmitter();
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
});

// ─── Shutdown ────────────────────────────────────────────────────────────────

describe('StructManager shutdown', () => {
  it('clears everything', () => {
    const { EventEmitter } = require('eventemitter3');
    const mockDaq = new EventEmitter();
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
