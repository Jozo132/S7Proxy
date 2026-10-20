// @ts-check

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionPool } from '../../src/client/connection-pool.js';
import { PlcConnection } from '../../src/client/plc-connection.js';
import { DaqEngine } from '../../src/daq/daq-engine.js';
import { Metrics } from '../../src/metrics/metrics.js';
import { createLogger } from '../../src/logging/logger.js';
import { WasmBridge } from '../../src/wasm/bridge.js';
import { loadWasmEngine } from '../../src/wasm/loader.js';

const logger = createLogger({ level: 'silent' });
const tag = { name: 'counter', area: 0x84, dbNum: 1, start: 0, amount: 1, wordLen: 0x02, target: 'plc1' };
/** @type {import('../../src/protocol/types.js').DaqConfig} */
const config = {
  minScanIntervalMs: 10, maxScanGroupsPerTarget: 16, maxTagsPerSubscription: 500,
  maxGapBytes: 4, cacheEnabled: true, cacheTtlMs: 5000,
  priorityQueue: { fairnessWindow: 10, agingThresholdMs: 2000 },
  slowClient: { maxSendBufferBytes: 65536, maxDroppedFrames: 100, dropWindowMs: 10000 },
};

describe('DAQ scan lifecycle', () => {
  /** @type {DaqEngine} */
  let daq;
  /** @type {ConnectionPool} */
  let pool;
  /** @type {PlcConnection} */
  let conn;

  beforeEach(async () => {
    const bridge = new WasmBridge(await loadWasmEngine());
    const target = { id: 'plc1', primary: { ip: '127.0.0.1', rack: 0, slot: 1 }, maxConnections: 1 };
    pool = new ConnectionPool(target, bridge, {
      healthCheckIntervalMs: 5000, healthCheckTimeoutMs: 2000, failoverThreshold: 3,
      failbackMode: 'auto', failbackDelayMs: 10000, failbackThreshold: 2,
    }, logger, 1);
    conn = new PlcConnection('scan-test', 'plc1', target.primary, bridge, logger);
    vi.spyOn(pool, 'acquire').mockReturnValue(conn);
    vi.spyOn(conn, 'sendRequest').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const response = Buffer.alloc(26);
      response[21] = 0xFF;
      response.writeUInt16BE(8, 23);
      response[25] = 42;
      return response;
    });
    daq = new DaqEngine(pool, bridge, config, logger, new Metrics());
    vi.useFakeTimers();
  });

  afterEach(() => {
    daq.shutdown();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('skips overlapping ticks instead of queuing scans', async () => {
    daq.subscribe({ targetId: 'plc1', tags: [tag], intervalMs: 10 });
    await vi.advanceTimersByTimeAsync(99);
    expect(conn.sendRequest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(11);
    expect(conn.sendRequest).toHaveBeenCalledTimes(2);
    expect(daq.getCachedValue(tag.name)?.value).toEqual(Buffer.from([42]));
  });

  it('discards successful responses after shutdown', async () => {
    const updates = vi.fn();
    daq.on('subscription:data', updates);
    daq.subscribe({ targetId: 'plc1', tags: [tag], intervalMs: 10 });
    daq.shutdown();
    await vi.advanceTimersByTimeAsync(200);
    expect(conn.sendRequest).toHaveBeenCalledTimes(1);
    expect(daq.dataCache.size).toBe(0);
    expect(updates).not.toHaveBeenCalled();
  });

  it('does not publish old results into a replacement scan group', async () => {
    const sub = daq.subscribe({ targetId: 'plc1', tags: [tag], intervalMs: 10 });
    daq.unsubscribe(sub);
    const updates = vi.fn();
    daq.on('subscription:data', updates);
    daq.subscribe({ targetId: 'plc1', tags: [tag], intervalMs: 10 });
    await vi.advanceTimersByTimeAsync(100);
    expect(daq.getCachedValue(tag.name)).toBeUndefined();
    expect(updates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(110);
    expect(daq.getCachedValue(tag.name)?.quality).toBe(192);
    expect(updates).toHaveBeenCalled();
  });

  it('marks unavailable reads bad instead of returning stale good data', () => {
    vi.mocked(pool.acquire).mockReturnValue(null);
    daq.dataCache.set(tag.name, Buffer.from([99]), 192);
    daq.subscribe({ targetId: 'plc1', tags: [tag], intervalMs: 10 });
    expect(daq.getCachedValue(tag.name)?.quality).toBe(0);
    expect(daq.getCachedValue(tag.name)?.value).toEqual(Buffer.alloc(0));
  });
});
