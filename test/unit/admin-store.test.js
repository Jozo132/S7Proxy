// @ts-check
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AdminStore } from '../../src/admin/store.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

describe('AdminStore', () => {
  /** @type {AdminStore} */
  let store;
  /** @type {string} */
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 's7proxy-test-'));
    store = new AdminStore(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Structs ────────────────────────────────────────

  it('saves and loads a struct definition', () => {
    /** @type {import('../../src/protocol/db-struct.js').S7StructDef} */
    const def = { name: 'Motor', db: 10, offset: 0, items: [{ name: 'speed', type: 'REAL' }, { name: 'running', type: 'BOOL' }] };
    store.saveStruct(def, { description: 'Motor data' });

    const loaded = store.loadStructs();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('Motor');
    expect(loaded[0].db).toBe(10);
    expect(loaded[0].items).toEqual(def.items);
    expect(loaded[0].description).toBe('Motor data');
  });

  it('upserts a struct (update on conflict)', () => {
    store.saveStruct({ name: 'Motor', db: 10, offset: 0, items: [{ name: 'a', type: 'INT' }] });
    store.saveStruct({ name: 'Motor', db: 11, offset: 4, items: [{ name: 'b', type: 'REAL' }] });

    const loaded = store.loadStructs();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].db).toBe(11);
    expect(loaded[0].offset).toBe(4);
    expect(loaded[0].items[0].name).toBe('b');
  });

  it('gets a single struct by name', () => {
    store.saveStruct({ name: 'Pump', db: 20, offset: 0, items: [{ name: 'flow', type: 'REAL' }] });
    const s = store.getStruct('Pump');
    expect(s).toBeDefined();
    expect(s?.db).toBe(20);
    expect(store.getStruct('NoExist')).toBeUndefined();
  });

  it('deletes a struct', () => {
    store.saveStruct({ name: 'Temp', db: 1, offset: 0, items: [{ name: 'v', type: 'INT' }] });
    expect(store.deleteStruct('Temp')).toBe(true);
    expect(store.loadStructs()).toHaveLength(0);
    expect(store.deleteStruct('Temp')).toBe(false);
  });

  it('stores subscription config with struct', () => {
    store.saveStruct(
      { name: 'S1', db: 5, offset: 0, items: [{ name: 'x', type: 'BYTE' }] },
      {
        targetId: 'plc1',
        subscribeMode: 'items',
        subscribeItems: ['x'],
        subscribeIntervalMs: 500,
        subscribeTargetId: 'plc1',
      },
    );
    const s = store.getStruct('S1');
    expect(s?.targetId).toBe('plc1');
    expect(s?.subscribeMode).toBe('items');
    expect(s?.subscribeItems).toEqual(['x']);
    expect(s?.subscribeIntervalMs).toBe(500);
    expect(s?.subscribeTargetId).toBe('plc1');
  });

  it('clears struct metadata when saving with DAQ disabled', () => {
    store.saveStruct(
      { name: 'S2', db: 7, offset: 0, items: [{ name: 'x', type: 'BYTE' }] },
      { targetId: 'plc1', subscribeMode: 'items', subscribeItems: ['x'], subscribeIntervalMs: 250 },
    );
    store.saveStruct(
      { name: 'S2', db: 7, offset: 2, items: [{ name: 'y', type: 'BYTE' }] },
      { targetId: undefined, subscribeMode: 'none', subscribeItems: undefined, subscribeIntervalMs: undefined },
    );

    const s = store.getStruct('S2');
    expect(s?.offset).toBe(2);
    expect(s?.targetId).toBeUndefined();
    expect(s?.subscribeMode).toBe('none');
    expect(s?.subscribeItems).toBeUndefined();
    expect(s?.subscribeIntervalMs).toBeUndefined();
  });

  // ─── Targets ────────────────────────────────────────

  it('saves and loads a target', () => {
    store.saveTarget({
      id: 'plc1',
      primary: { ip: '192.168.1.10', rack: 0, slot: 1, port: 102 },
      maxConnections: 4,
      requestTimeoutMs: 3000,
      keepAliveIntervalMs: 30000,
      reconnectBackoffMs: [1000, 2000, 5000],
    });
    const targets = store.loadTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0].id).toBe('plc1');
    expect(targets[0].primary.ip).toBe('192.168.1.10');
    expect(targets[0].maxConnections).toBe(4);
    expect(targets[0].requestTimeoutMs).toBe(3000);
    expect(targets[0].keepAliveIntervalMs).toBe(30000);
    expect(targets[0].reconnectBackoffMs).toEqual([1000, 2000, 5000]);
  });

  it('saves target with backups', () => {
    store.saveTarget({
      id: 'plc2',
      primary: { ip: '10.0.0.1', rack: 0, slot: 1 },
      backups: [{ ip: '10.0.0.2', rack: 0, slot: 1 }],
    });
    const targets = store.loadTargets();
    expect(targets[0].backups).toEqual([{ ip: '10.0.0.2', rack: 0, slot: 1 }]);
  });

  it('deletes a target', () => {
    store.saveTarget({ id: 'plc1', primary: { ip: '1.1.1.1', rack: 0, slot: 1 } });
    expect(store.deleteTarget('plc1')).toBe(true);
    expect(store.loadTargets()).toHaveLength(0);
    expect(store.deleteTarget('plc1')).toBe(false);
  });

  // ─── Settings ───────────────────────────────────────

  it('sets and gets settings', () => {
    store.setSetting('foo', 'bar');
    expect(store.getSetting('foo')).toBe('bar');
    expect(store.getSetting('missing', 'default')).toBe('default');
  });

  it('overwrites settings on conflict', () => {
    store.setSetting('key', 'v1');
    store.setSetting('key', 'v2');
    expect(store.getSetting('key')).toBe('v2');
  });

  it('returns all settings', () => {
    store.setSetting('a', '1');
    store.setSetting('b', '2');
    expect(store.getAllSettings()).toEqual({ a: '1', b: '2' });
  });

  it('tracks disabled config targets', () => {
    store.setTargetDisabled('plc-disabled', true);
    expect(store.getDisabledTargets()).toEqual(['plc-disabled']);

    store.setTargetDisabled('plc-disabled', false);
    expect(store.getDisabledTargets()).toEqual([]);
  });

  // ─── Audit log ──────────────────────────────────────

  it('records audit entries on struct save/delete', () => {
    store.saveStruct({ name: 'X', db: 1, offset: 0, items: [{ name: 'v', type: 'INT' }] });
    store.deleteStruct('X');
    const log = store.getAuditLog(10);
    expect(log.length).toBeGreaterThanOrEqual(2);
    expect(log.find((e) => e.action === 'struct:save')).toBeDefined();
    expect(log.find((e) => e.action === 'struct:delete')).toBeDefined();
  });

  it('records audit entries on target operations', () => {
    store.saveTarget({ id: 'plc1', primary: { ip: '1.2.3.4', rack: 0, slot: 1 } });
    store.deleteTarget('plc1');
    const log = store.getAuditLog();
    const actions = log.map((e) => e.action);
    expect(actions).toContain('target:save');
    expect(actions).toContain('target:delete');
  });

  it('limits audit log results', () => {
    for (let i = 0; i < 10; i++) store.setSetting(`k${i}`, `v${i}`);
    store.saveStruct({ name: 'A', db: 1, offset: 0, items: [{ name: 'v', type: 'INT' }] });
    const log = store.getAuditLog(1);
    expect(log).toHaveLength(1);
  });

  // ─── Edge cases ─────────────────────────────────────

  it('persists data across close and reopen', () => {
    const dbPath = join(tmpDir, 'persist.db');
    const s1 = new AdminStore(dbPath);
    s1.saveStruct({ name: 'Persistent', db: 99, offset: 0, items: [{ name: 'val', type: 'DINT' }] });
    s1.setSetting('mode', 'production');
    s1.setTargetDisabled('plc-z', true);
    s1.close();

    const s2 = new AdminStore(dbPath);
    expect(s2.getStruct('Persistent')?.db).toBe(99);
    expect(s2.getSetting('mode')).toBe('production');
    expect(s2.getDisabledTargets()).toEqual(['plc-z']);
    s2.close();
  });
});
