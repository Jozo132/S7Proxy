// @ts-check

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionPool } from '../../src/client/connection-pool.js';
import { PlcConnection } from '../../src/client/plc-connection.js';
import { createLogger } from '../../src/logging/logger.js';
import { WasmBridge } from '../../src/wasm/bridge.js';
import { loadWasmEngine } from '../../src/wasm/loader.js';

const logger = createLogger({ level: 'silent' });
const target = { id: 'lifecycle', primary: { ip: '127.0.0.1', rack: 0, slot: 1 }, maxConnections: 1 };
const config = {
  healthCheckIntervalMs: 5000, healthCheckTimeoutMs: 2000, failoverThreshold: 3,
  /** @type {'auto'} */ failbackMode: 'auto', failbackDelayMs: 10000, failbackThreshold: 2,
};

describe('ConnectionPool recovery ownership', () => {
  /** @type {ConnectionPool} */
  let pool;
  /** @type {PlcConnection[]} */
  let attempts;

  beforeEach(async () => {
    const bridge = new WasmBridge(await loadWasmEngine());
    attempts = [];
    vi.useFakeTimers();
    vi.spyOn(PlcConnection.prototype, 'connect').mockImplementation(
      /** @this {PlcConnection} */
      async function () {
        attempts.push(this);
        const err = new Error('Connection refused');
        this.emit('error', err);
        queueMicrotask(() => this.emit('close'));
        throw err;
      },
    );
    vi.spyOn(PlcConnection.prototype, 'disconnect').mockImplementation(
      /** @this {PlcConnection} */
      async function () { this.emit('close'); },
    );
    pool = new ConnectionPool(target, bridge, config, logger, 1);
  });

  afterEach(async () => {
    await pool.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('deduplicates close and rejection retries and backs off', async () => {
    await pool.start();
    expect(attempts).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(attempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(attempts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('cancels retries and intentional-close recovery when stopped', async () => {
    await pool.start();
    await pool.stop();
    expect(pool.connections).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30000);
    expect(attempts).toHaveLength(1);
  });

  it('caps repeated failures at a five-second retry delay', async () => {
    await pool.start();
    await vi.advanceTimersByTimeAsync(250 + 500 + 1000 + 2000 + 4000);
    expect(attempts).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(4999);
    expect(attempts).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toHaveLength(7);
    await vi.advanceTimersByTimeAsync(4999);
    expect(attempts).toHaveLength(7);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toHaveLength(8);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('does not duplicate connections on repeated starts', async () => {
    await Promise.all([pool.start(), pool.start()]);
    expect(attempts).toHaveLength(1);
    expect(pool.connections).toHaveLength(1);
  });

  it('ignores old endpoints and timers after failover', async () => {
    await pool.start();
    const old = attempts[0];
    const backup = { ip: '127.0.0.2', rack: 0, slot: 1 };
    pool.failoverManager.emit('failover', target.primary, backup);
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toHaveLength(2);
    old.emit('close');
    await vi.advanceTimersByTimeAsync(250);
    expect(attempts).toHaveLength(3);
    expect(attempts.slice(1).every((conn) => conn.endpoint.ip === backup.ip)).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('restarts after stop without reviving the old retry chain', async () => {
    await pool.start();
    const old = attempts[0];
    await pool.stop();
    await pool.start();
    old.emit('close');
    await vi.advanceTimersByTimeAsync(250);
    expect(attempts).toHaveLength(3);
    expect(pool.connections).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
  });
});
