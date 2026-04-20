// @ts-check
// Integration test — REST API against the demo PLC server

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown } from '../helpers.js';
import { ConnectionPool } from '../../src/client/connection-pool.js';
import { DaqEngine } from '../../src/daq/daq-engine.js';
import { RestServer } from '../../src/api/rest-server.js';
import { Metrics } from '../../src/metrics/metrics.js';
import { S7AreaDB, S7WLByte } from '../../src/protocol/constants.js';

/** @type {import('../helpers.js').TestContext} */
let ctx;
/** @type {ConnectionPool} */
let pool;
/** @type {DaqEngine} */
let daq;
/** @type {RestServer} */
let rest;
/** @type {string} */
let baseUrl;

/** @type {import('../../src/protocol/types.js').FailoverConfig} */
const failoverConfig = {
  healthCheckIntervalMs: 5000,
  healthCheckTimeoutMs: 2000,
  failoverThreshold: 3,
  failbackMode: 'auto',
  failbackDelayMs: 10000,
  failbackThreshold: 2,
};

describe('REST API', () => {
  beforeAll(async () => {
    ctx = await setup();

    /** @type {import('../../src/protocol/types.js').PlcTarget} */
    const target = {
      id: 'plc-rest',
      primary: { ip: '127.0.0.1', rack: 0, slot: 1 },
      maxConnections: 2,
    };

    pool = new ConnectionPool(target, ctx.bridge, failoverConfig, ctx.logger, 1);
    await pool.start();

    const metrics = new Metrics();
    daq = new DaqEngine(pool, ctx.bridge, { maxScanGroups: 16, defaultIntervalMs: 500, cacheTtlMs: 5000 }, ctx.logger, metrics);

    rest = new RestServer(pool, daq, metrics, { enabled: true, port: 0, host: '127.0.0.1' }, ctx.logger);
    await rest.start();
    const addr = rest.server.server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' ? addr?.port : addr}`;
  });

  afterAll(async () => {
    await rest.stop();
    daq.shutdown();
    await pool.stop();
    await teardown();
  });

  it('GET /api/health returns 200', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('timestamp');
  });

  it('GET /api/targets returns target info', async () => {
    const res = await fetch(`${baseUrl}/api/targets`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('targetId');
    expect(body).toHaveProperty('connections');
  });

  it('GET /api/subscriptions initially empty', async () => {
    const res = await fetch(`${baseUrl}/api/subscriptions`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('POST /api/subscriptions creates a subscription', async () => {
    const res = await fetch(`${baseUrl}/api/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetId: 'plc-rest',
        tags: [{ name: 'DB1.DBB0', area: S7AreaDB, dbNumber: 1, start: 0, amount: 4, wordLen: S7WLByte }],
        intervalMs: 500,
      }),
    });

    expect(res.status).toBe(201);
  });

  it('DELETE /api/subscriptions/:subId removes it', async () => {
    // Create first
    const createRes = await fetch(`${baseUrl}/api/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetId: 'plc-rest',
        tags: [{ name: 'DB1.DBB4', area: S7AreaDB, dbNumber: 1, start: 4, amount: 2, wordLen: S7WLByte }],
        intervalMs: 1000,
      }),
    });
    const { subscriptionId } = await createRes.json();

    const delRes = await fetch(`${baseUrl}/api/subscriptions/${subscriptionId}`, {
      method: 'DELETE',
    });
    expect(delRes.status).toBe(200);
  });

  it('GET /api/scan-groups returns array', async () => {
    const res = await fetch(`${baseUrl}/api/scan-groups`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('GET /metrics returns prometheus text', async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(typeof text).toBe('string');
  });
});
