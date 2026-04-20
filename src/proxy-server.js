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

/** @import { S7ProxyConfig } from './protocol/types.js' */
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

  /** @param {S7ProxyConfig} config */
  constructor(config) {
    this.#config = config;
    this.#logger = createLogger(config.logging);
    this.#metrics = new Metrics();
  }

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
      );
      await this.#restServer.start();

      this.#wsServer = new WsServer(this.#daq, this.#config.daq, this.#metrics, this.#logger);
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
