// @ts-check

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerAdminRoutes } from '../../src/admin/routes.js';
import { AdminStore } from '../../src/admin/store.js';
import { StructManager } from '../../src/protocol/struct-manager.js';
import { Metrics } from '../../src/metrics/metrics.js';

/** @type {import('fastify').FastifyInstance} */
let app;
/** @type {AdminStore} */
let store;
/** @type {string} */
let tmpDir;
/** @type {import('../../src/protocol/types.js').S7ProxyConfig} */
let config;
/** @type {any} */
let currentPool;

describe('Admin routes', () => {
  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 's7proxy-admin-routes-'));
    store = new AdminStore(join(tmpDir, 'admin.db'));
    app = Fastify({ logger: false });
    currentPool = null;

    config = {
      listen: { ip: '0.0.0.0', port: 102 },
      targets: [],
      routing: [],
      filters: [],
      failover: {
        healthCheckIntervalMs: 3000,
        healthCheckTimeoutMs: 1500,
        failoverThreshold: 3,
        failbackMode: 'auto',
        failbackDelayMs: 15000,
        failbackThreshold: 5,
        healthProbeMode: 'tcp',
      },
      webApi: { enabled: true, host: '127.0.0.1', port: 8080 },
      daq: {
        minScanIntervalMs: 20,
        maxScanGroupsPerTarget: 50,
        maxTagsPerSubscription: 500,
        maxGapBytes: 32,
        cacheEnabled: true,
        cacheTtlMs: 5000,
        priorityQueue: { fairnessWindow: 10, agingThresholdMs: 2000 },
        slowClient: { maxSendBufferBytes: 65536, maxDroppedFrames: 100, dropWindowMs: 10000 },
      },
      logging: { level: 'silent' },
      metrics: { enabled: false, port: 9090, path: '/metrics' },
    };

    registerAdminRoutes(app, {
      store,
      structs: new StructManager(),
      getPool: () => currentPool,
      getDaq: () => null,
      metrics: new Metrics(),
      config,
      uptime: () => 1234,
      upsertTarget: async (target) => {
        const idx = config.targets.findIndex((t) => t.id === target.id);
        if (idx === -1) config.targets.push(target);
        else config.targets[idx] = target;

        currentPool = {
          targetId: target.id,
          connections: [{ info: { id: `${target.id}-0`, targetId: target.id, state: 'connecting' } }],
          failoverManager: { state: 'PRIMARY_ACTIVE' },
        };

        return { active: true, targetId: target.id };
      },
      removeTarget: async (targetId) => {
        config.targets = config.targets.filter((t) => t.id !== targetId);
        if (currentPool?.targetId === targetId) currentPool = null;
        return { active: false, targetId };
      },
    });

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('activates a newly added target and exposes it in overview state', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/api/targets',
      payload: {
        id: 'plc-admin',
        primary: { ip: '192.168.0.10', rack: 0, slot: 1 },
        maxConnections: 2,
      },
    });

    expect(createRes.statusCode).toBe(201);
    expect(createRes.json().runtime).toMatchObject({ active: true, targetId: 'plc-admin' });

    const stateRes = await app.inject({ method: 'GET', url: '/admin/api/state' });
    expect(stateRes.statusCode).toBe(200);

    const state = stateRes.json();
    expect(state.connections).toHaveLength(1);
    expect(state.connections[0].targetId).toBe('plc-admin');
    expect(state.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'plc-admin', source: 'database', active: true }),
      ]),
    );
  });

  it('returns the new target from the targets endpoint immediately after add', async () => {
    await app.inject({
      method: 'POST',
      url: '/admin/api/targets',
      payload: {
        id: 'plc-list',
        primary: { ip: '10.0.0.5', rack: 0, slot: 1 },
        maxConnections: 1,
      },
    });

    const listRes = await app.inject({ method: 'GET', url: '/admin/api/targets' });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'plc-list', source: 'database' }),
      ]),
    );
  });

  it('updates an existing target through the admin API', async () => {
    await app.inject({
      method: 'POST',
      url: '/admin/api/targets',
      payload: {
        id: 'plc-edit',
        primary: { ip: '10.0.0.5', rack: 0, slot: 1 },
        maxConnections: 1,
      },
    });

    const updateRes = await app.inject({
      method: 'PUT',
      url: '/admin/api/targets/plc-edit',
      payload: {
        primary: { ip: '10.0.0.6', rack: 0, slot: 2 },
        maxConnections: 3,
        requestTimeoutMs: 4000,
      },
    });

    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.json().runtime).toMatchObject({ active: true, targetId: 'plc-edit' });

    const listRes = await app.inject({ method: 'GET', url: '/admin/api/targets' });
    expect(listRes.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'plc-edit',
          source: 'database',
          maxConnections: 3,
          requestTimeoutMs: 4000,
          primary: expect.objectContaining({ ip: '10.0.0.6', slot: 2 }),
        }),
      ]),
    );
  });

  it('disables a config target when deleting it from the admin API', async () => {
    config.targets.push({
      id: 'plc-config',
      primary: { ip: '192.168.10.10', rack: 0, slot: 1 },
      maxConnections: 2,
    });

    const deleteRes = await app.inject({ method: 'DELETE', url: '/admin/api/targets/plc-config' });
    expect(deleteRes.statusCode).toBe(200);
    expect(store.getDisabledTargets()).toEqual(['plc-config']);

    const listRes = await app.inject({ method: 'GET', url: '/admin/api/targets' });
    expect(listRes.json().find((target) => target.id === 'plc-config')).toBeUndefined();
  });

  it('stores PLC-linked struct metadata and exposes it in admin listings', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/api/structs',
      payload: {
        name: 'MotorStruct',
        targetId: 'plc-admin',
        db: 12,
        offset: 0,
        description: 'Motor helper',
        subscribeMode: 'items',
        subscribeItems: ['speed'],
        subscribeIntervalMs: 500,
        items: [
          { name: 'speed', type: 'REAL' },
          { name: 'running', type: 'BOOL' },
        ],
      },
    });

    expect(res.statusCode).toBe(201);

    const listRes = await app.inject({ method: 'GET', url: '/admin/api/structs' });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'MotorStruct',
          targetId: 'plc-admin',
          subscribeMode: 'items',
          subscribeItems: ['speed'],
          subscribeIntervalMs: 500,
        }),
      ]),
    );
  });
});