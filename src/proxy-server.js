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

/** @import { S7ProxyConfig } from './protocol/types.js' */
/** @import { S7StructDef, S7Value } from './protocol/db-struct.js' */
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
  /** @type {StructManager} */
  #structs;

  /** @param {S7ProxyConfig} config */
  constructor(config) {
    this.#config = config;
    this.#logger = createLogger(config.logging);
    this.#metrics = new Metrics();
    this.#structs = new StructManager({ logger: this.#logger });
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
   * @param {string} targetId
   * @param {number} intervalMs
   * @returns {string} subscription ID
   */
  subscribeStruct(name, targetId, intervalMs) { return this.#structs.subscribe(name, targetId, intervalMs); }

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

  async start() {
    this.#logger.info('Starting S7Proxy...');

    // 1. Load WASM engine
    const wasmImports = createWasmImports(this.#logger);
    const engine = await loadWasmEngine(wasmImports);
    this.#bridge = new WasmBridge(engine);
    this.#logger.info('WASM engine loaded');

    // 2. Connection pool (first target only for now)
    const target = this.#config.targets[0];
    if (target) {
      this.#pool = new ConnectionPool(target, this.#bridge, this.#config.failover, this.#logger);
      await this.#pool.start();
    }

    // 3. DAQ engine
    if (this.#pool) {
      this.#daq = new DaqEngine(
        this.#pool, this.#bridge, this.#config.daq, this.#logger, this.#metrics,
      );
    }

    // 3b. Bind struct manager to runtime infrastructure
    if (this.#pool && this.#bridge) {
      this.#structs.bind({
        pool: this.#pool,
        bridge: this.#bridge,
        daq: this.#daq ?? undefined,
        targetId: target?.id,
      });
    }

    // 4. TCP listener + router
    this.#tcpListener = new TcpListener(this.#config.listen.port, this.#config.listen.ip, this.#logger);

    if (this.#pool && this.#daq) {
      this.#router = new ProxyRouter(this.#pool, this.#config, this.#logger, this.#metrics);

      this.#tcpListener.on('connection', (socket) => {
        const session = new ClientSession(socket, /** @type {WasmBridge} */ (this.#bridge), this.#logger);
        this.#router?.handleSession(session);
      });
    }

    await this.#tcpListener.start();

    // 5. REST + WebSocket API
    if (this.#config.webApi?.enabled && this.#pool && this.#daq) {
      this.#restServer = new RestServer(
        this.#pool, this.#daq, this.#metrics, this.#config.webApi, this.#logger,
        this.#structs,
      );
      await this.#restServer.start();

      this.#wsServer = new WsServer(
        this.#daq, this.#config.daq, this.#metrics, this.#logger,
        this.#structs,
      );
      const httpServer = this.#restServer.server.server;
      this.#wsServer.attach(httpServer);
    }

    this.#logger.info('S7Proxy started');
    this.#installSignalHandlers();
  }

  async stop() {
    this.#logger.info('Shutting down S7Proxy...');

    this.#wsServer?.stop();
    await this.#restServer?.stop();
    await this.#tcpListener?.stop();
    this.#structs.shutdown();
    this.#daq?.shutdown();
    await this.#pool?.stop();

    this.#logger.info('S7Proxy stopped');
  }

  #installSignalHandlers() {
    /** @param {string} signal */
    const onSignal = async (signal) => {
      this.#logger.info({ signal }, 'Received signal, shutting down');
      await this.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));
  }
}
