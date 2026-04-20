// @ts-check
// ProxyServer — main orchestrator that wires everything together

import { loadWasmEngine } from './wasm/loader.js';
import { WasmBridge } from './wasm/bridge.js';
import { createWasmImports } from './wasm/imports.js';
import { ConnectionPool } from './client/connection-pool.js';
import { TcpListener } from './server/tcp-listener.js';
import { ClientSession } from './server/client-session.js';
import { ProxyRouter } from './router/router.js';
import { DaqEngine } from './daq/daq-engine.js';
import { RestServer } from './api/rest-server.js';
import { WsServer } from './api/ws-server.js';
import { Metrics } from './metrics/metrics.js';
import { createLogger } from './logging/logger.js';
import { StructManager } from './protocol/struct-manager.js';
import { registerAdminRoutes } from './admin/routes.js';
import { AdminAuth } from './admin/auth.js';
import { AdminWsServer } from './admin/admin-ws.js';

/** @import { S7ProxyConfig, PlcTarget } from './protocol/types.js' */
/** @import { S7StructDef, S7Value } from './protocol/db-struct.js' */
/** @import { AdminStore } from './admin/store.js' */
/** @import pino from 'pino' */

export class ProxyServer {
  /** @type {S7ProxyConfig} */
  #config;
  /** @type {pino.Logger} */
  #logger;
  /** @type {Metrics} */
  #metrics;
  /** @type {WasmBridge | null} */
  #bridge = null;
  /** @type {ConnectionPool | null} */
  #pool = null;
  /** @type {TcpListener | null} */
  #tcpListener = null;
  /** @type {ProxyRouter | null} */
  #router = null;
  /** @type {DaqEngine | null} */
  #daq = null;
  /** @type {RestServer | null} */
  #restServer = null;
  /** @type {WsServer | null} */
  #wsServer = null;
  /** @type {AdminWsServer | null} */
  #adminWs = null;
  /** @type {AdminAuth | null} */
  #adminAuth = null;
  /** @type {StructManager} */
  #structs;
  /** @type {AdminStore | null} */
  #adminStore;
  /** @type {number} */
  #startedAt = 0;
  /** @type {boolean} */
  #routerConnectionHandlerInstalled = false;
  /** @type {Promise<void> | null} */
  #stopPromise = null;
  /** @type {boolean} */
  #signalHandlersInstalled = false;
  /** @type {number} */
  #shutdownSignalCount = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  #forceExitTimer = null;
  /** @type {(() => void) | null} */
  #sigintHandler = null;
  /** @type {(() => void) | null} */
  #sigtermHandler = null;

  /**
   * @param {S7ProxyConfig} config
   * @param {AdminStore} [adminStore]
   */
  constructor(config, adminStore) {
    this.#config = config;
    this.#logger = createLogger(config.logging);
    this.#metrics = new Metrics();
    this.#structs = new StructManager({ logger: this.#logger });
    this.#adminStore = adminStore ?? null;
  }

  /** @returns {StructManager} */
  get structs() { return this.#structs; }

  // ─── Struct delegate methods ─────────────────────────────────────────────

  /**
   * Register a struct definition. Can be called before or after start().
   * @param {S7StructDef} def
   */
  registerStruct(def) { return this.#structs.register(def); }

  /**
   * Register multiple struct definitions at once.
   * @param {S7StructDef[]} defs
   */
  registerStructs(defs) { return this.#structs.registerMany(defs); }

  /**
   * Unregister a struct by name.
   * @param {string} name
   */
  unregisterStruct(name) { this.#structs.unregister(name); }

  /**
   * Read a struct from the PLC → decoded object.
   * @param {string} name
   * @param {string[]} [keys]  - Optional field filter
   * @param {string} [targetId]
   * @returns {Promise<Record<string, S7Value>>}
   */
  readStruct(name, keys, targetId) { return this.#structs.read(name, keys, targetId); }

  /**
   * Write an object to a struct on the PLC. Supports partial writes.
   * @param {string} name
   * @param {Record<string, S7Value>} values
   * @param {string} [targetId]
   * @returns {Promise<void>}
   */
  writeStruct(name, values, targetId) { return this.#structs.write(name, values, targetId); }

  /**
   * Subscribe to a struct via DAQ for periodic decoded updates.
   * @param {string} name
    * @param {string | undefined} targetId
   * @param {number} intervalMs
    * @param {string[]} [keys]
   * @returns {string} subscription ID
   */
    subscribeStruct(name, targetId, intervalMs, keys) { return this.#structs.subscribe(name, targetId, intervalMs, keys); }

  /**
   * Unsubscribe a struct subscription.
   * @param {string} subId
   */
  unsubscribeStruct(subId) { this.#structs.unsubscribe(subId); }

  /**
   * Get cached decoded values (no PLC hit).
   * @param {string} name
   * @returns {Record<string, S7Value> | undefined}
   */
  getCachedStruct(name) { return this.#structs.getCachedValues(name); }

  /**
   * Add or update a target in the live runtime config.
   * If there is no active target yet, the new one is activated immediately.
   * If the updated target is currently active, its runtime is rebuilt.
   * @param {PlcTarget} target
   */
  async upsertTarget(target) {
    const idx = this.#config.targets.findIndex((t) => t.id === target.id);
    if (idx === -1) this.#config.targets.push(target);
    else this.#config.targets[idx] = { ...this.#config.targets[idx], ...target };

    if (!this.#bridge || !this.#tcpListener) {
      this.#adminWs?.broadcastState();
      return { active: false, requiresRestart: false };
    }

    const activeTargetId = this.#pool?.targetId ?? null;
    if (!activeTargetId) {
      await this.#activateTargetRuntime(target);
      this.#adminWs?.broadcastState();
      return { active: true, targetId: target.id };
    }

    if (activeTargetId === target.id) {
      await this.#deactivateTargetRuntime();
      await this.#activateTargetRuntime(target);
      this.#adminWs?.broadcastState();
      return { active: true, targetId: target.id, reconfigured: true };
    }

    this.#adminWs?.broadcastState();
    return { active: false, requiresRestart: true, activeTargetId };
  }

  /**
   * Remove a target from the live runtime config.
   * If the removed target is currently active, the runtime is stopped and the
   * next configured target is activated if available.
   * @param {string} targetId
   */
  async removeTarget(targetId) {
    const idx = this.#config.targets.findIndex((t) => t.id === targetId);
    if (idx !== -1) this.#config.targets.splice(idx, 1);

    const wasActive = this.#pool?.targetId === targetId;
    if (!wasActive) {
      this.#adminWs?.broadcastState();
      return { active: false, targetId };
    }

    await this.#deactivateTargetRuntime();

    const nextTarget = this.#config.targets[0];
    if (nextTarget) {
      await this.#activateTargetRuntime(nextTarget);
      this.#adminWs?.broadcastState();
      return { active: true, targetId: nextTarget.id, switchedFrom: targetId };
    }

    this.#adminWs?.broadcastState();
    return { active: false, targetId };
  }

  /**
   * @param {PlcTarget} target
   */
  async #activateTargetRuntime(target) {
    if (!this.#bridge) throw new Error('WASM engine not loaded');

    this.#pool = new ConnectionPool(
      target,
      this.#bridge,
      target.failover ?? this.#config.failover,
      this.#logger,
      target.maxConnections,
      target.requestTimeoutMs,
    );
    await this.#pool.start();

    this.#daq = new DaqEngine(
      this.#pool,
      this.#bridge,
      this.#config.daq,
      this.#logger,
      this.#metrics,
    );

    this.#structs.bind({
      pool: this.#pool,
      bridge: this.#bridge,
      daq: this.#daq,
      targetId: target.id,
    });

    this.#router = new ProxyRouter(this.#pool, this.#config, this.#logger, this.#metrics);
    this.#ensureRouterConnectionHandler();
    this.#restServer?.bindRuntime(this.#pool, this.#daq);
    this.#restorePersistedStructSubscriptions();

    if (!this.#wsServer && this.#restServer && this.#config.webApi?.enabled) {
      this.#wsServer = new WsServer(this.#daq, this.#config.daq, this.#metrics, this.#logger, this.#structs);
      const httpServer = this.#restServer.server.server;
      this.#wsServer.attach(httpServer);
    }

    this.#logger.info({ targetId: target.id }, 'Runtime target activated');
  }

  async #deactivateTargetRuntime() {
    for (const sub of this.#structs.getStructSubscriptions()) {
      this.#structs.unsubscribe(sub.subId);
    }

    this.#wsServer?.stop();
    this.#wsServer = null;
    this.#router = null;
    this.#daq?.shutdown();
    this.#daq = null;
    await this.#pool?.stop();
    this.#pool = null;
    this.#restServer?.bindRuntime(null, null);
  }

  #restorePersistedStructSubscriptions() {
    if (!this.#adminStore || !this.#daq) return;

    const existing = new Set(
      this.#structs.getStructSubscriptions().map((sub) => `${sub.structName}:${sub.targetId}:${sub.intervalMs}:${(sub.keys ?? []).join(',')}`),
    );

    for (const def of this.#adminStore.loadStructs()) {
      const subscribeTargetId = def.subscribeTargetId ?? def.targetId;
      if (!def.subscribeIntervalMs || !subscribeTargetId || def.subscribeMode === 'none') continue;
      const subscribeItems = def.subscribeMode === 'items' ? def.subscribeItems : undefined;
      const key = `${def.name}:${subscribeTargetId}:${def.subscribeIntervalMs}:${(subscribeItems ?? []).join(',')}`;
      if (existing.has(key)) continue;
      try {
        this.#structs.subscribe(def.name, subscribeTargetId, def.subscribeIntervalMs, subscribeItems);
      } catch {
        // Ignore if runtime is not yet ready for struct subscriptions.
      }
    }
  }

  #ensureRouterConnectionHandler() {
    if (!this.#tcpListener || this.#routerConnectionHandlerInstalled) return;

    this.#tcpListener.on('connection', (socket) => {
      if (!this.#bridge || !this.#router) {
        socket.destroy();
        return;
      }

      const session = new ClientSession(socket, this.#bridge, this.#logger);
      this.#router.handleSession(session);
    });

    this.#routerConnectionHandlerInstalled = true;
  }

  async start() {
    this.#startedAt = Date.now();
    this.#logger.info('Starting S7Proxy...');

    // 0. Load persisted structs from admin store (before PLC connection)
    if (this.#adminStore) {
      const persisted = this.#adminStore.loadStructs();
      if (persisted.length > 0) {
        this.#structs.registerMany(persisted);
        this.#logger.info({ count: persisted.length }, 'Loaded persisted struct definitions');
      }
    }

    // 1. Load WASM engine
    const wasmImports = createWasmImports(this.#logger);
    const engine = await loadWasmEngine(wasmImports);
    this.#bridge = new WasmBridge(engine);
    this.#logger.info('WASM engine loaded');

    // 2. Connection pool (first target only for now)
    const target = this.#config.targets[0];
    if (target) await this.#activateTargetRuntime(target);

    // 4. TCP listener + router
    this.#tcpListener = new TcpListener(this.#config.listen.port, this.#config.listen.ip, this.#logger);
    this.#ensureRouterConnectionHandler();

    await this.#tcpListener.start();

    // 5. REST + WebSocket API
    if (this.#config.webApi?.enabled) {
      const hasPool = !!this.#pool && !!this.#daq;

      if (hasPool) {
        this.#restServer = new RestServer(
          this.#pool, this.#daq, this.#metrics, this.#config.webApi, this.#logger,
          this.#structs,
        );
      } else {
        // Admin-only mode: create a minimal HTTP app instance
        this.#restServer = new RestServer(
          /** @type {any} */ (null), /** @type {any} */ (null),
          this.#metrics, this.#config.webApi, this.#logger,
        );
      }

      // 5b. Register admin routes and static file serving
      if (this.#adminStore) {
        const app = this.#restServer.server;

        const { resolve, dirname } = await import('node:path');
        const { fileURLToPath } = await import('node:url');
        const __dirname = dirname(fileURLToPath(import.meta.url));
        app.serveStatic('/admin/', resolve(__dirname, '..', 'public'));
        // Redirect /admin to /admin/
        app.get('/admin', (_, reply) => reply.redirect('/admin/'));

        this.#adminAuth = new AdminAuth(this.#adminStore);

        const adminCtx = {
          store: this.#adminStore,
          structs: this.#structs,
          getPool: () => this.#pool,
          getDaq: () => this.#daq,
          metrics: this.#metrics,
          config: this.#config,
          uptime: () => Date.now() - this.#startedAt,
          upsertTarget: (/** @type {any} */ targetDef) => this.upsertTarget(targetDef),
          removeTarget: (/** @type {string} */ targetId) => this.removeTarget(targetId),
        };

        const { getAllTargets } = registerAdminRoutes(app, adminCtx, this.#adminAuth);

        // Build getState function for admin WS
        const getAdminState = () => {
          const pool = adminCtx.getPool();
          const connections = pool?.connections.map((c) => c.info) ?? [];
          const failover = pool?.failoverManager?.state ?? null;
          const activeTargetId = pool?.targetId ?? null;
          const structList = this.#structs.listInfo();
          const subscriptions = this.#structs.getStructSubscriptions();
          return {
            uptime: adminCtx.uptime(),
            timestamp: Date.now(),
            connections,
            failover,
            structs: structList.map((s) => ({
              ...s,
              activeTarget: s.targetId ? s.targetId === activeTargetId : null,
              cached: this.#structs.getCachedValues(s.name),
              subscription: subscriptions.find((sub) => sub.structName === s.name) ?? null,
            })),
            targets: getAllTargets().map((t) => ({ ...t, active: t.id === activeTargetId })),
            config: {
              listen: this.#config.listen,
              webApi: { host: this.#config.webApi.host, port: this.#config.webApi.port, enabled: this.#config.webApi.enabled },
              daq: { minScanIntervalMs: this.#config.daq.minScanIntervalMs, cacheEnabled: this.#config.daq.cacheEnabled },
            },
          };
        };

        this.#adminWs = new AdminWsServer({
          structs: this.#structs,
          auth: this.#adminAuth,
          getState: getAdminState,
          logger: this.#logger,
        });
      }

      await this.#restServer.start();

      if (hasPool) {
        this.#wsServer = new WsServer(
          /** @type {DaqEngine} */ (this.#daq), this.#config.daq, this.#metrics, this.#logger,
          this.#structs,
        );
        const httpServer = this.#restServer.server.server;
        this.#wsServer.attach(httpServer);
      }

      // Attach admin WS (always, even without pool)
      if (this.#adminWs) {
        const httpServer = this.#restServer.server.server;
        this.#adminWs.attach(httpServer);
      }

      if (this.#adminStore) {
        const host = this.#config.webApi.host === '0.0.0.0' ? 'localhost' : this.#config.webApi.host;
        const port = this.#config.webApi.port ?? 8080;
        this.#logger.info(`Admin UI: http://${host}:${port}/admin/`);
      }
    }

    this.#logger.info('S7Proxy started');
    this.#installSignalHandlers();
  }

  async stop() {
    if (this.#stopPromise) return this.#stopPromise;

    this.#stopPromise = (async () => {
      this.#logger.info('Shutting down S7Proxy...');

      this.#adminWs?.stop();
      this.#adminWs = null;
      this.#wsServer?.stop();
      this.#wsServer = null;
      await this.#restServer?.stop();
      this.#restServer = null;
      await this.#tcpListener?.stop();
      this.#tcpListener = null;
      this.#structs.shutdown();
      this.#daq?.shutdown();
      this.#daq = null;
      await this.#pool?.stop();
      this.#pool = null;
      this.#adminStore?.close();

      if (this.#sigintHandler) {
        process.off('SIGINT', this.#sigintHandler);
        this.#sigintHandler = null;
      }
      if (this.#sigtermHandler) {
        process.off('SIGTERM', this.#sigtermHandler);
        this.#sigtermHandler = null;
      }
      this.#signalHandlersInstalled = false;

      this.#logger.info('S7Proxy stopped');
    })();

    return this.#stopPromise;
  }

  #installSignalHandlers() {
    if (this.#signalHandlersInstalled) return;
    this.#signalHandlersInstalled = true;

    /** @param {string} signal */
    const onSignal = (signal) => {
      this.#shutdownSignalCount += 1;

      if (this.#shutdownSignalCount > 1) {
        this.#logger.warn({ signal }, 'Received additional signal, forcing exit');
        process.exit(130);
        return;
      }

      this.#logger.info({ signal }, 'Received signal, shutting down');
      this.#forceExitTimer = setTimeout(() => {
        this.#logger.error('Graceful shutdown timed out, forcing exit');
        process.exit(1);
      }, 10000);
      this.#forceExitTimer.unref?.();

      void this.stop()
        .then(() => {
          if (this.#forceExitTimer) {
            clearTimeout(this.#forceExitTimer);
            this.#forceExitTimer = null;
          }
          process.exit(0);
        })
        .catch((err) => {
          if (this.#forceExitTimer) {
            clearTimeout(this.#forceExitTimer);
            this.#forceExitTimer = null;
          }
          this.#logger.error({ err }, 'Shutdown failed');
          process.exit(1);
        });
    };

    this.#sigintHandler = () => onSignal('SIGINT');
    this.#sigtermHandler = () => onSignal('SIGTERM');

    process.on('SIGINT', this.#sigintHandler);
    process.on('SIGTERM', this.#sigtermHandler);
  }
}
