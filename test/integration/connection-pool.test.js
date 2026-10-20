// @ts-check
// Integration test — ConnectionPool lifecycle

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown } from '../helpers.js';
import { ConnectionPool } from '../../src/client/connection-pool.js';

/** @type {import('../helpers.js').TestContext} */
let ctx;

/** @type {import('../../src/protocol/types.js').FailoverConfig} */
const failoverConfig = {
  healthCheckIntervalMs: 5000,
  healthCheckTimeoutMs: 2000,
  failoverThreshold: 3,
  failbackMode: 'auto',
  failbackDelayMs: 10000,
  failbackThreshold: 2,
};

describe('ConnectionPool', () => {
  beforeAll(async () => {
    ctx = await setup({ port: 11102 });
  });

  afterAll(async () => {
    await teardown();
  });

  it('should start pool and acquire a ready connection', async () => {
    /** @type {import('../../src/protocol/types.js').PlcTarget} */
    const target = {
      id: 'plc-pool-1',
      primary: { ip: '127.0.0.1', rack: 0, slot: 1, port: 11102 },
      maxConnections: 2,
    };

    const pool = new ConnectionPool(target, ctx.bridge, failoverConfig, ctx.logger, 1);
    await pool.start();

    const conn = pool.acquire();
    expect(conn).not.toBeNull();
    expect(conn?.state).toBe('ready');

    await pool.stop();
  });

  it('should create poolSize connections', async () => {
    /** @type {import('../../src/protocol/types.js').PlcTarget} */
    const target = {
      id: 'plc-pool-2',
      primary: { ip: '127.0.0.1', rack: 0, slot: 1, port: 11102 },
      maxConnections: 3,
    };

    const pool = new ConnectionPool(target, ctx.bridge, failoverConfig, ctx.logger, 2);
    await pool.start();

    expect(pool.connections).toHaveLength(2);

    await pool.stop();
    expect(pool.connections).toHaveLength(0);
  });

  it('replaces a closed connection and keeps the replacement ready', async () => {
    const target = {
      id: 'plc-pool-recovery',
      primary: { ip: '127.0.0.1', rack: 0, slot: 1, port: 11102 },
      maxConnections: 1,
    };
    const pool = new ConnectionPool(target, ctx.bridge, failoverConfig, ctx.logger, 1);
    try {
      await pool.start();
      const original = pool.acquire();
      if (!original) throw new Error('No initial connection');
      await original.disconnect();
      expect(pool.acquire()).toBeNull();
      const deadline = Date.now() + 3000;
      while (!pool.acquire() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(pool.acquire()).not.toBeNull();
      expect(pool.acquire()).not.toBe(original);
      expect(pool.acquire()?.state).toBe('ready');
    } finally {
      await pool.stop();
    }
  });

  it('should return null when no connections have free slots', async () => {
    /** @type {import('../../src/protocol/types.js').PlcTarget} */
    const target = {
      id: 'plc-pool-3',
      primary: { ip: '127.0.0.1', rack: 0, slot: 1, port: 11102 },
      maxConnections: 1,
    };

    // Pool with 0 connections means acquire returns null
    const pool = new ConnectionPool(target, ctx.bridge, failoverConfig, ctx.logger, 0);
    await pool.start();

    const conn = pool.acquire();
    expect(conn).toBeNull();

    await pool.stop();
  });
});
