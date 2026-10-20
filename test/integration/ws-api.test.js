// @ts-check
// Integration test — WebSocket subscriptions against the demo PLC server

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown } from '../helpers.js';
import { ConnectionPool } from '../../src/client/connection-pool.js';
import { DaqEngine } from '../../src/daq/daq-engine.js';
import { RestServer } from '../../src/api/rest-server.js';
import { WsServer } from '../../src/api/ws-server.js';
import { Metrics } from '../../src/metrics/metrics.js';
import { S7AreaDB, S7WLByte } from '../../src/protocol/constants.js';
import WebSocket from 'ws';

/** @type {import('../helpers.js').TestContext} */
let ctx;
/** @type {ConnectionPool} */
let pool;
/** @type {DaqEngine} */
let daq;
/** @type {RestServer} */
let rest;
/** @type {WsServer} */
let wsSrv;
/** @type {string} */
let wsUrl;

/** @type {import('../../src/protocol/types.js').FailoverConfig} */
const failoverConfig = {
  healthCheckIntervalMs: 5000,
  healthCheckTimeoutMs: 2000,
  failoverThreshold: 3,
  failbackMode: 'auto',
  failbackDelayMs: 10000,
  failbackThreshold: 2,
};

describe('WebSocket API', () => {
  beforeAll(async () => {
    ctx = await setup({ port: 11102 });

    /** @type {import('../../src/protocol/types.js').PlcTarget} */
    const target = {
      id: 'plc-ws',
      primary: { ip: '127.0.0.1', rack: 0, slot: 1, port: 11102 },
      maxConnections: 2,
    };

    pool = new ConnectionPool(target, ctx.bridge, failoverConfig, ctx.logger, 1);
    await pool.start();

    const metrics = new Metrics();
    /** @type {import('../../src/protocol/types.js').DaqConfig} */
    const daqConfig = {
      minScanIntervalMs: 20,
      maxScanGroupsPerTarget: 16,
      maxTagsPerSubscription: 500,
      maxGapBytes: 4,
      cacheEnabled: true,
      cacheTtlMs: 5000,
      priorityQueue: { fairnessWindow: 10, agingThresholdMs: 2000 },
      slowClient: { maxSendBufferBytes: 65536, maxDroppedFrames: 100, dropWindowMs: 10000 },
    };
    daq = new DaqEngine(pool, ctx.bridge, daqConfig, ctx.logger, metrics);

    rest = new RestServer(pool, daq, metrics, { enabled: true, port: 0, host: '127.0.0.1' }, ctx.logger);
    await rest.start();

    wsSrv = new WsServer(daq, daqConfig, metrics, ctx.logger);
    wsSrv.attach(rest.server.server);

    const addr = rest.server.server.address();
    const port = typeof addr === 'object' ? addr?.port : addr;
    wsUrl = `ws://127.0.0.1:${port}/ws`;
  }, 15000);

  afterAll(async () => {
    wsSrv.stop();
    await rest.stop();
    daq.shutdown();
    await pool.stop();
    await teardown();
  });

  /**
   * Open a WS connection and wait for it to be ready.
   * @returns {Promise<WebSocket>}
   */
  function openWs() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  }

  it('should connect via WebSocket', async () => {
    const ws = await openWs();
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('should subscribe and receive subscribed ack', async () => {
    const ws = await openWs();

    const ack = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No ack received')), 5000);
      ws.on('message', (raw) => {
        const msg = JSON.parse(/** @type {string} */ (raw.toString()));
        if (msg.type === 'subscribed') {
          clearTimeout(timer);
          resolve(msg);
        }
      });

      ws.send(JSON.stringify({
        type: 'subscribe',
        targetId: 'plc-ws',
        tags: [{ name: 'DB1.DBB0', area: S7AreaDB, dbNumber: 1, start: 0, amount: 4, wordLen: S7WLByte }],
        intervalMs: 200,
      }));
    });

    expect(ack).toHaveProperty('subscriptionId');
    expect(ack).toHaveProperty('tags');
    ws.close();
  });

  it('should receive data messages after subscribing', async () => {
    const ws = await openWs();

    // Subscribe
    ws.send(JSON.stringify({
      type: 'subscribe',
      targetId: 'plc-ws',
      tags: [{ name: 'DB1.DBB12', area: S7AreaDB, dbNumber: 1, start: 12, amount: 8, wordLen: S7WLByte }],
      intervalMs: 200,
    }));

    const dataMsg = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No data msg within 10s')), 10000);
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'data') {
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });

    expect(dataMsg).toHaveProperty('subscriptionId');
    ws.close();
  });

  it('should unsubscribe and receive ack', async () => {
    const ws = await openWs();

    // Subscribe first
    const ack = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No ack')), 5000);
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'subscribed') { clearTimeout(timer); resolve(msg); }
      });
      ws.send(JSON.stringify({
        type: 'subscribe',
        targetId: 'plc-ws',
        tags: [{ name: 'DB1.DBB50', area: S7AreaDB, dbNumber: 1, start: 50, amount: 2, wordLen: S7WLByte }],
        intervalMs: 1000,
      }));
    });

    // Unsubscribe
    const unsub = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No unsub ack')), 5000);
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'unsubscribed') { clearTimeout(timer); resolve(msg); }
      });
      ws.send(JSON.stringify({
        type: 'unsubscribe',
        subscriptionId: /** @type {any} */ (ack).subscriptionId,
      }));
    });

    expect(unsub).toHaveProperty('subscriptionId');
    ws.close();
  });
});
