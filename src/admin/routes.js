// @ts-check
// Admin REST API routes — configuration, struct management, and state overview

/** @import { HttpApp } from '../http/app.js' */
/** @import { AdminStore } from './store.js' */
/** @import { StructManager } from '../protocol/struct-manager.js' */
/** @import { ConnectionPool } from '../client/connection-pool.js' */
/** @import { DaqEngine } from '../daq/daq-engine.js' */
/** @import { Metrics } from '../metrics/metrics.js' */
/** @import { AdminAuth } from './auth.js' */

/**
 * @param {HttpApp} app
 * @param {{
 *   store: AdminStore,
 *   structs: StructManager,
 *   getPool: () => ConnectionPool | null,
 *   getDaq: () => DaqEngine | null,
 *   metrics: Metrics,
 *   config: import('../protocol/types.js').S7ProxyConfig,
 *   uptime: () => number,
 *   upsertTarget?: (target: import('../protocol/types.js').PlcTarget) => Promise<any>,
 *   removeTarget?: (targetId: string) => Promise<any>,
 * }} ctx
 * @param {AdminAuth} [auth]
 * @returns {{ getAllTargets: () => any[] }}
 */
export function registerAdminRoutes(app, ctx, auth) {
  const { store, structs, metrics, config } = ctx;

  /**
   * @param {string | string[] | undefined} header
   * @returns {string | null}
   */
  function getBearerToken(header) {
    const value = Array.isArray(header) ? header[0] : header;
    return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : null;
  }

  /** @returns {Set<string>} */
  function getDisabledTargetIds() {
    return new Set(store.getDisabledTargets());
  }

  /**
   * Merge config-file targets with persisted admin targets.
   * Config targets are shown as source:'config', persisted entries override them.
   */
  function getAllTargets() {
    const disabledTargetIds = getDisabledTargetIds();
    const persisted = store.loadTargets().filter((t) => !disabledTargetIds.has(t.id));
    const persistedIds = new Set(persisted.map((t) => t.id));

    /** @type {Array<any>} */
    const merged = persisted.map((t) => ({ ...t, source: 'persisted' }));
    for (const t of config.targets) {
      if (!persistedIds.has(t.id) && !disabledTargetIds.has(t.id)) {
        merged.push({
          id: t.id,
          primary: t.primary,
          backups: t.backups,
          maxConnections: t.maxConnections,
          requestTimeoutMs: t.requestTimeoutMs,
          keepAliveIntervalMs: t.keepAliveIntervalMs,
          reconnectBackoffMs: t.reconnectBackoffMs,
          source: 'config',
        });
      }
    }
    return merged;
  }

  // ─── Auth middleware ──────────────────────────────────────────────────

  if (auth) {
    app.addHook('onRequest', async (request, reply) => {
      if (!request.url.startsWith('/admin/api/')) return;
      if (request.url.startsWith('/admin/api/auth/')) return;

      const token = getBearerToken(request.headers.authorization);
      if (!auth.validate(token)) {
        reply.code(401).send({ error: 'Unauthorized' });
      }
    });

    app.post('/admin/api/auth/login', async (req, reply) => {
      const { password } = /** @type {any} */ (req.body) ?? {};
      if (!password) { reply.code(400); return { error: 'Password required' }; }
      const token = auth.login(password);
      if (!token) { reply.code(401); return { error: 'Invalid password' }; }
      return { token };
    });

    app.post('/admin/api/auth/logout', async (req) => {
      const token = getBearerToken(req.headers.authorization);
      if (token) auth.logout(token);
      return { status: 'ok' };
    });

    app.get('/admin/api/auth/check', async (req) => {
      const token = getBearerToken(req.headers.authorization);
      return { valid: auth.validate(token) };
    });

    app.post('/admin/api/auth/change-password', async (req, reply) => {
      const { currentPassword, newPassword } = /** @type {any} */ (req.body) ?? {};
      if (!currentPassword || !newPassword) { reply.code(400); return { error: 'currentPassword and newPassword required' }; }
      if (newPassword.length < 4) { reply.code(400); return { error: 'Password must be at least 4 characters' }; }
      const ok = auth.changePassword(currentPassword, newPassword);
      if (!ok) { reply.code(401); return { error: 'Current password is incorrect' }; }
      return { status: 'changed' };
    });
  }

  // ─── Dashboard state ─────────────────────────────────────────────────

  app.get('/admin/api/state', async () => {
    const pool = ctx.getPool();
    const connections = pool?.connections.map((c) => c.info) ?? [];
    const failover = pool?.failoverManager?.state ?? null;
    const activeTargetId = pool?.targetId ?? null;
    const structList = structs.listInfo();
    const subscriptions = structs.getStructSubscriptions();
    const settings = store.getAllSettings();

    return {
      uptime: ctx.uptime(),
      timestamp: Date.now(),
      connections,
      failover,
      structs: structList.map((s) => ({
        ...s,
        activeTarget: s.targetId ? s.targetId === activeTargetId : null,
        cached: structs.getCachedValues(s.name),
        subscription: subscriptions.find((sub) => sub.structName === s.name) ?? null,
      })),
      targets: getAllTargets().map((t) => ({ ...t, active: t.id === activeTargetId })),
      settings,
      config: {
        listen: config.listen,
        webApi: { host: config.webApi.host, port: config.webApi.port, enabled: config.webApi.enabled },
        daq: { minScanIntervalMs: config.daq.minScanIntervalMs, cacheEnabled: config.daq.cacheEnabled },
      },
    };
  });

  // ─── Struct CRUD (persisted) ─────────────────────────────────────────

  app.get('/admin/api/structs', async () => {
    return store.loadStructs().map((def) => {
      const live = structs.get(def.name);
      return {
        ...def,
        size: live?.size ?? null,
        registered: !!live,
        cached: live ? structs.getCachedValues(def.name) : undefined,
      };
    });
  });

  app.post('/admin/api/structs', async (req, reply) => {
    const body = /** @type {any} */ (req.body) ?? {};
    const {
      name, db, offset, items, targetId, description,
      subscribeMode, subscribeItems, subscribeIntervalMs,
    } = body;
    if (!name || db === undefined || !items || !Array.isArray(items)) {
      reply.code(400);
      return { error: 'name, db, and items[] are required' };
    }
    if (subscribeMode === 'items' && (!Array.isArray(subscribeItems) || subscribeItems.length === 0)) {
      reply.code(400);
      return { error: 'subscribeItems[] required when subscribeMode is "items"' };
    }

    /** @type {import('../protocol/db-struct.js').S7StructDef} */
    const def = {
      name,
      db,
      offset: offset ?? 0,
      items,
      targetId,
      description,
      subscribeMode,
      subscribeItems,
      subscribeIntervalMs,
      subscribeTargetId: targetId,
    };

    // Persist to DB
    store.saveStruct(def, {
      targetId,
      description,
      subscribeMode,
      subscribeItems,
      subscribeIntervalMs,
      subscribeTargetId: targetId,
    });

    // Register in runtime
    if (structs.has(name)) structs.unregister(name);
    const struct = structs.register(def);

    // Auto-subscribe if configured
    const daq = ctx.getDaq();
    if (subscribeMode !== 'none' && subscribeIntervalMs && targetId && daq) {
      try {
        structs.subscribe(name, targetId, subscribeIntervalMs, subscribeMode === 'items' ? subscribeItems : undefined);
      } catch { /* ignore if DAQ not ready */ }
    }

    reply.code(201);
    return {
      name: struct.name,
      db: struct.db,
      offset: struct.offset,
      size: struct.size,
      targetId,
      fields: struct.items.map((i) => i.name),
    };
  });

  app.put('/admin/api/structs/:name', async (req, reply) => {
    const { name } = /** @type {{ name: string }} */ (/** @type {any} */ (req.params));
    const body = /** @type {any} */ (req.body) ?? {};
    const {
      db, offset, items, targetId, description,
      subscribeMode, subscribeItems, subscribeIntervalMs,
    } = body;
    if (db === undefined || !items || !Array.isArray(items)) {
      reply.code(400);
      return { error: 'db and items[] are required' };
    }
    if (subscribeMode === 'items' && (!Array.isArray(subscribeItems) || subscribeItems.length === 0)) {
      reply.code(400);
      return { error: 'subscribeItems[] required when subscribeMode is "items"' };
    }

    /** @type {import('../protocol/db-struct.js').S7StructDef} */
    const def = {
      name,
      db,
      offset: offset ?? 0,
      items,
      targetId,
      description,
      subscribeMode,
      subscribeItems,
      subscribeIntervalMs,
      subscribeTargetId: targetId,
    };

    store.saveStruct(def, {
      targetId,
      description,
      subscribeMode,
      subscribeItems,
      subscribeIntervalMs,
      subscribeTargetId: targetId,
    });

    if (structs.has(name)) structs.unregister(name);
    const struct = structs.register(def);

    const daq = ctx.getDaq();
    if (subscribeMode !== 'none' && subscribeIntervalMs && targetId && daq) {
      try {
        structs.subscribe(name, targetId, subscribeIntervalMs, subscribeMode === 'items' ? subscribeItems : undefined);
      } catch { /* ignore */ }
    }

    return {
      name: struct.name,
      db: struct.db,
      offset: struct.offset,
      size: struct.size,
      targetId,
      fields: struct.items.map((i) => i.name),
    };
  });

  app.delete('/admin/api/structs/:name', async (req, reply) => {
    const { name } = /** @type {{ name: string }} */ (/** @type {any} */ (req.params));
    const deleted = store.deleteStruct(name);
    if (structs.has(name)) structs.unregister(name);
    if (!deleted) { reply.code(404); return { error: 'Not found' }; }
    return { status: 'deleted' };
  });

  // ─── Targets (persisted) ─────────────────────────────────────────────

  app.get('/admin/api/targets', async () => {
    return getAllTargets();
  });

  app.post('/admin/api/targets', async (req, reply) => {
    const body = /** @type {any} */ (req.body) ?? {};
    const {
      id, primary, backups, maxConnections,
      requestTimeoutMs, keepAliveIntervalMs, reconnectBackoffMs,
    } = body;
    if (!id || !primary?.ip) {
      reply.code(400);
      return { error: 'id and primary.ip are required' };
    }
    const target = {
      id,
      primary,
      backups,
      maxConnections: maxConnections ?? 2,
      requestTimeoutMs,
      keepAliveIntervalMs,
      reconnectBackoffMs,
    };
    store.saveTarget(target);
    store.setTargetDisabled(id, false);
    const runtime = await ctx.upsertTarget?.(target);
    reply.code(201);
    return { status: 'saved', id, runtime };
  });

  app.put('/admin/api/targets/:id', async (req, reply) => {
    const { id } = /** @type {{ id: string }} */ (/** @type {any} */ (req.params));
    const body = /** @type {any} */ (req.body) ?? {};
    const {
      primary, backups, maxConnections,
      requestTimeoutMs, keepAliveIntervalMs, reconnectBackoffMs,
    } = body;
    if (!primary?.ip) {
      reply.code(400);
      return { error: 'primary.ip is required' };
    }

    const target = {
      id,
      primary,
      backups,
      maxConnections: maxConnections ?? 2,
      requestTimeoutMs,
      keepAliveIntervalMs,
      reconnectBackoffMs,
    };
    store.saveTarget(target);
    store.setTargetDisabled(id, false);
    const runtime = await ctx.upsertTarget?.(target);
    return { status: 'updated', id, runtime };
  });

  app.delete('/admin/api/targets/:id', async (req, reply) => {
    const { id } = /** @type {{ id: string }} */ (/** @type {any} */ (req.params));
    const deleted = store.deleteTarget(id);
    const hasConfigTarget = config.targets.some((target) => target.id === id);
    if (hasConfigTarget) {
      store.setTargetDisabled(id, true);
    }
    if (!deleted && !hasConfigTarget) { reply.code(404); return { error: 'Not found' }; }
    const runtime = await ctx.removeTarget?.(id);
    return { status: 'deleted', runtime };
  });

  // ─── Settings ────────────────────────────────────────────────────────

  app.get('/admin/api/settings', async () => {
    return store.getAllSettings();
  });

  app.put('/admin/api/settings', async (req) => {
    const body = /** @type {Record<string, string>} */ (/** @type {any} */ (req.body)) ?? {};
    for (const [key, value] of Object.entries(body)) {
      store.setSetting(key, String(value));
    }
    return { status: 'saved' };
  });

  // ─── Audit log ───────────────────────────────────────────────────────

  app.get('/admin/api/audit', async (req) => {
    const query = /** @type {any} */ (req.query) ?? {};
    const limit = parseInt(query.limit, 10) || 100;
    return store.getAuditLog(limit);
  });

  // ─── Live struct write ───────────────────────────────────────────────

  app.post('/admin/api/structs/:name/write', async (req, reply) => {
    const { name } = /** @type {{ name: string }} */ (/** @type {any} */ (req.params));
    const { values } = /** @type {any} */ (req.body) ?? {};
    if (!values || typeof values !== 'object') {
      reply.code(400);
      return { error: 'values object is required' };
    }
    if (!structs.has(name)) {
      reply.code(404);
      return { error: `Struct "${name}" not found` };
    }
    try {
      await structs.write(name, values);
      return { status: 'written', struct: name, timestamp: Date.now() };
    } catch (err) {
      reply.code(500);
      return { error: /** @type {Error} */ (err).message };
    }
  });

  app.post('/admin/api/structs/:name/read', async (req, reply) => {
    const { name } = /** @type {{ name: string }} */ (/** @type {any} */ (req.params));
    const { keys } = /** @type {any} */ (req.body) ?? {};
    if (!structs.has(name)) {
      reply.code(404);
      return { error: `Struct "${name}" not found` };
    }
    try {
      const values = await structs.read(name, keys);
      return { struct: name, values, timestamp: Date.now() };
    } catch (err) {
      reply.code(500);
      return { error: /** @type {Error} */ (err).message };
    }
  });

  return { getAllTargets };
}
