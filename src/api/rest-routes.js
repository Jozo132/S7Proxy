// @ts-check
// REST API route registration

/** @import { FastifyInstance } from 'fastify' */
/** @import { ConnectionPool } from '../client/connection-pool.js' */
/** @import { DaqEngine } from '../daq/daq-engine.js' */
/** @import { Metrics } from '../metrics/metrics.js' */
/** @import { StructManager } from '../protocol/struct-manager.js' */

/**
 * @param {FastifyInstance} app
 * @param {ConnectionPool} pool
 * @param {DaqEngine} daq
 * @param {Metrics} metrics
 * @param {StructManager} [structs]
 */
export function registerRoutes(app, pool, daq, metrics, structs) {
  // Health check
  app.get('/api/health', async () => {
    return { status: 'ok', timestamp: Date.now() };
  });

  // --- Connection endpoints ---

  app.get('/api/targets', async () => {
    return {
      targetId: pool.targetId,
      connections: pool.connections.map((c) => c.info),
      failover: pool.failoverManager.state,
      endpointHealth: pool.failoverManager.getEndpointHealth(),
    };
  });

  // Force failover/failback
  app.post('/api/targets/failover', async (_req, reply) => {
    try {
      await pool.failoverManager.forceFailover();
      return { status: 'failover_triggered' };
    } catch (err) {
      reply.code(400);
      return { error: /** @type {Error} */ (err).message };
    }
  });

  app.post('/api/targets/failback', async (_req, reply) => {
    try {
      await pool.failoverManager.forceFailback();
      return { status: 'failback_triggered' };
    } catch (err) {
      reply.code(400);
      return { error: /** @type {Error} */ (err).message };
    }
  });

  // --- DAQ Read ---

  app.get('/api/read', async (req, reply) => {
    const tagName = /** @type {string | undefined} */ (/** @type {any} */ (req.query).tag);

    if (!tagName) {
      reply.code(400);
      return { error: 'tag query parameter required' };
    }

    metrics.restRequestsTotal.inc({ method: 'read' });

    const cached = daq.getCachedValue(tagName);
    if (cached) {
      metrics.restCacheHits.inc();
      return {
        tag: tagName,
        value: cached.value.toString('hex'),
        timestamp: cached.timestamp,
        quality: cached.quality,
        source: 'cache',
      };
    }

    reply.code(404);
    return { error: 'Tag not cached. Subscribe via DAQ first.' };
  });

  // --- DAQ Subscription management ---

  app.get('/api/subscriptions', async () => {
    return daq.getSubscriptions();
  });

  app.post('/api/subscriptions', async (req, reply) => {
    const body = /** @type {any} */ (req.body) ?? {};
    const { targetId, tags, intervalMs } = body;

    if (!targetId || !tags || !intervalMs) {
      reply.code(400);
      return { error: 'targetId, tags, and intervalMs required' };
    }

    const tagDefs = tags.map((/** @type {any} */ t) => ({
      name: t.name,
      area: t.area,
      start: t.start ?? t.offset ?? 0,
      dbNum: t.dbNum ?? 0,
      amount: t.amount ?? 1,
      wordLen: t.wordLen ?? 0x02,
      target: targetId,
      scanIntervalMs: intervalMs,
    }));

    const subId = daq.subscribe({ targetId, tags: tagDefs, intervalMs });
    reply.code(201);
    return { id: subId, targetId, tags: tags.length, intervalMs };
  });

  app.delete('/api/subscriptions/:subId', async (req, _reply) => {
    const { subId } = /** @type {{ subId: string }} */ (/** @type {any} */ (req.params));
    daq.unsubscribe(subId);
    return { status: 'removed' };
  });

  // --- Scan groups ---

  app.get('/api/scan-groups', async () => {
    return daq.getScanGroupStats();
  });

  // --- Metrics ---

  app.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', metrics.registry.contentType);
    return metrics.registry.metrics();
  });

  // --- Structs ---

  if (structs) {
    // List all registered structs
    app.get('/api/structs', async () => {
      return structs.listInfo();
    });

    // Register a new struct definition
    app.post('/api/structs', async (req, reply) => {
      const body = /** @type {any} */ (req.body) ?? {};
      const { name, db, offset, items } = body;
      if (!name || db === undefined || !items) {
        reply.code(400);
        return { error: 'name, db, and items are required' };
      }
      if (structs.has(name)) {
        reply.code(409);
        return { error: `Struct "${name}" already registered` };
      }
      const struct = structs.register({ name, db, offset: offset ?? 0, items });
      reply.code(201);
      return { name: struct.name, db: struct.db, offset: struct.offset, size: struct.size, fields: struct.items.map((i) => i.name) };
    });

    // Get struct info by name
    app.get('/api/structs/:name', async (req, reply) => {
      const { name } = /** @type {{ name: string }} */ (/** @type {any} */ (req.params));
      const struct = structs.get(name);
      if (!struct) { reply.code(404); return { error: `Struct "${name}" not found` }; }
      return {
        name: struct.name, db: struct.db, offset: struct.offset, size: struct.size,
        fields: struct.items.map((i) => ({ name: i.name, type: i.type, size: i.size, strlen: i.strlen, offset: i.offset })),
        cached: structs.getCachedValues(name),
      };
    });

    // Delete a struct
    app.delete('/api/structs/:name', async (req, reply) => {
      const { name } = /** @type {{ name: string }} */ (/** @type {any} */ (req.params));
      if (!structs.has(name)) { reply.code(404); return { error: `Struct "${name}" not found` }; }
      structs.unregister(name);
      return { status: 'removed' };
    });

    // Read struct from PLC → decoded values
    app.get('/api/structs/:name/read', async (req, reply) => {
      const { name } = /** @type {{ name: string }} */ (/** @type {any} */ (req.params));
      const query = /** @type {any} */ (req.query) ?? {};
      const keys = query.keys ? String(query.keys).split(',').map((/** @type {string} */ k) => k.trim()) : undefined;
      try {
        const values = await structs.read(name, keys);
        return { struct: name, values, timestamp: Date.now() };
      } catch (err) {
        reply.code(500);
        return { error: /** @type {Error} */ (err).message };
      }
    });

    // Write values to struct on PLC
    app.post('/api/structs/:name/write', async (req, reply) => {
      const { name } = /** @type {{ name: string }} */ (/** @type {any} */ (req.params));
      const body = /** @type {any} */ (req.body) ?? {};
      const { values } = body;
      if (!values || typeof values !== 'object') {
        reply.code(400);
        return { error: 'values object required' };
      }
      try {
        await structs.write(name, values);
        return { struct: name, status: 'written', timestamp: Date.now() };
      } catch (err) {
        reply.code(500);
        return { error: /** @type {Error} */ (err).message };
      }
    });

    // Subscribe to struct via DAQ
    app.post('/api/structs/:name/subscribe', async (req, reply) => {
      const { name } = /** @type {{ name: string }} */ (/** @type {any} */ (req.params));
      const body = /** @type {any} */ (req.body) ?? {};
      const { targetId, intervalMs } = body;
      if (!targetId || !intervalMs) {
        reply.code(400);
        return { error: 'targetId and intervalMs required' };
      }
      try {
        const subId = structs.subscribe(name, targetId, intervalMs);
        reply.code(201);
        return { struct: name, subscriptionId: subId, targetId, intervalMs };
      } catch (err) {
        reply.code(500);
        return { error: /** @type {Error} */ (err).message };
      }
    });

    // Get cached struct values (no PLC hit)
    app.get('/api/structs/:name/cached', async (req, reply) => {
      const { name } = /** @type {{ name: string }} */ (/** @type {any} */ (req.params));
      const values = structs.getCachedValues(name);
      if (!values) { reply.code(404); return { error: `No cached values for struct "${name}"` }; }
      return { struct: name, values, timestamp: Date.now() };
    });
  }
}
