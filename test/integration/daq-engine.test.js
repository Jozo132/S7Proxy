// @ts-check
// Integration test — DaqEngine subscriptions against the demo PLC server

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown } from '../helpers.js';
import { ConnectionPool } from '../../src/client/connection-pool.js';
import { DaqEngine } from '../../src/daq/daq-engine.js';
import { Metrics } from '../../src/metrics/metrics.js';
import { S7AreaDB, S7WLByte } from '../../src/protocol/constants.js';

/** @type {import('../helpers.js').TestContext} */
let ctx;
/** @type {ConnectionPool} */
let pool;
/** @type {DaqEngine} */
let daq;

/** @type {import('../../src/protocol/types.js').FailoverConfig} */
const failoverConfig = {
  healthCheckIntervalMs: 5000,
  healthCheckTimeoutMs: 2000,
  failoverThreshold: 3,
  failbackMode: 'auto',
  failbackDelayMs: 10000,
  failbackThreshold: 2,
};

describe('DaqEngine', () => {
  beforeAll(async () => {
    ctx = await setup();

    /** @type {import('../../src/protocol/types.js').PlcTarget} */
    const target = {
      id: 'plc-daq',
      primary: { ip: '127.0.0.1', rack: 0, slot: 1 },
      maxConnections: 2,
    };

    pool = new ConnectionPool(target, ctx.bridge, failoverConfig, ctx.logger, 1);
    await pool.start();

    const metrics = new Metrics();
    const config = {
      maxScanGroups: 16,
      defaultIntervalMs: 500,
      cacheTtlMs: 5000,
    };
    daq = new DaqEngine(pool, ctx.bridge, config, ctx.logger, metrics);
  });

  afterAll(async () => {
    daq.shutdown();
    await pool.stop();
    await teardown();
  });

  it('should create a subscription and return a subId', () => {
    const subId = daq.subscribe({
      targetId: 'plc-daq',
      tags: [
        { name: 'DB1.DBB0', area: S7AreaDB, dbNumber: 1, start: 0, amount: 2, wordLen: S7WLByte },
      ],
      intervalMs: 500,
    });

    expect(typeof subId).toBe('string');
    expect(subId.length).toBeGreaterThan(0);
  });

  it('should list subscriptions', () => {
    const subs = daq.getSubscriptions();
    expect(subs.length).toBeGreaterThan(0);
  });

  it('should list scan group stats', () => {
    const groups = daq.getScanGroupStats();
    expect(groups.length).toBeGreaterThan(0);
    expect(groups[0]).toHaveProperty('intervalMs');
    expect(groups[0]).toHaveProperty('tagCount');
  });

  it('should emit subscription:data after a scan tick', async () => {
    const subId = daq.subscribe({
      targetId: 'plc-daq',
      tags: [
        { name: 'DB1.DBB10', area: S7AreaDB, dbNumber: 1, start: 10, amount: 4, wordLen: S7WLByte },
      ],
      intervalMs: 200,
    });

    const data = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No data received within 5s')), 5000);
      daq.on('subscription:data', (sid, info) => {
        if (sid === subId) {
          clearTimeout(timer);
          resolve(info);
        }
      });
    });

    expect(data).toBeDefined();
  });

  it('should unsubscribe', () => {
    const subId = daq.subscribe({
      targetId: 'plc-daq',
      tags: [
        { name: 'DB1.DBB20', area: S7AreaDB, dbNumber: 1, start: 20, amount: 1, wordLen: S7WLByte },
      ],
      intervalMs: 1000,
    });

    const before = daq.getSubscriptions().length;
    daq.unsubscribe(subId);
    const after = daq.getSubscriptions().length;
    expect(after).toBe(before - 1);
  });

  it('should serve cached values after a read cycle', async () => {
    const subId = daq.subscribe({
      targetId: 'plc-daq',
      tags: [
        { name: 'DB1.DBB30', area: S7AreaDB, dbNumber: 1, start: 30, amount: 2, wordLen: S7WLByte },
      ],
      intervalMs: 200,
    });

    // Poll until the cache is populated (scan may need a cycle to include the new tag)
    const deadline = Date.now() + 5000;
    let cached;
    while (Date.now() < deadline) {
      cached = daq.getCachedValue('DB1.DBB30');
      if (cached) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(cached).toBeDefined();
    expect(cached?.value).toBeInstanceOf(Buffer);
  });
});
