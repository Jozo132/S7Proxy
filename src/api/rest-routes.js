// @ts-check
// REST API route registration

/** @import { FastifyInstance } from 'fastify' */
/** @import { ConnectionPool } from '../client/connection-pool.js' */
/** @import { DaqEngine } from '../daq/daq-engine.js' */
/** @import { Metrics } from '../metrics/metrics.js' */

/**
 * @param {FastifyInstance} app
 * @param {ConnectionPool} pool
 * @param {DaqEngine} daq
 * @param {Metrics} metrics
 */
export function registerRoutes(app, pool, daq, metrics) {
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
}
