// @ts-check
// Connection pool for a single PLC target

import { EventEmitter } from 'eventemitter3';
import { PlcConnection } from './plc-connection.js';
import { FailoverManager } from './failover-manager.js';

/** @import { PlcTarget, PlcEndpoint, FailoverConfig } from '../protocol/types.js' */
/** @import { WasmBridge } from '../wasm/bridge.js' */
/** @import pino from 'pino' */

export class ConnectionPool extends EventEmitter {
  /** @type {string} */
  #targetId;
  /** @type {PlcTarget} */
  #target;
  /** @type {WasmBridge} */
  #bridge;
  /** @type {pino.Logger} */
  #logger;
  /** @type {number} */
  #poolSize;
  /** @type {number} */
  #requestTimeoutMs;

  /** @type {PlcConnection[]} */
  #connections = [];
  /** @type {FailoverManager} */
  #failoverManager;

  /** @type {number} */
  #roundRobinIdx = 0;

  /**
   * @param {PlcTarget} target
   * @param {WasmBridge} bridge
   * @param {FailoverConfig} failoverConfig
   * @param {pino.Logger} logger
   * @param {number} [poolSize=2]
   * @param {number} [requestTimeoutMs=3000]
   */
  constructor(target, bridge, failoverConfig, logger, poolSize = 2, requestTimeoutMs = 3000) {
    super();
    this.#targetId = target.id;
    this.#target = target;
    this.#bridge = bridge;
    this.#logger = logger.child({ component: 'pool', target: target.id });
    this.#poolSize = poolSize;
    this.#requestTimeoutMs = requestTimeoutMs;

    this.#failoverManager = new FailoverManager(target, failoverConfig, logger);
    this.#failoverManager.on('failover', (from, to) => this.#handleFailover(from, to));
    this.#failoverManager.on('failback', (from, to) => this.#handleFailover(from, to));
  }

  get failoverManager() { return this.#failoverManager; }
  get targetId() { return this.#targetId; }
  get connections() { return [...this.#connections]; }

  async start() {
    this.#failoverManager.start();
    await this.#createConnections(this.#failoverManager.activeEndpoint);
  }

  async stop() {
    this.#failoverManager.stop();
    await this.#destroyConnections();
  }

  /**
   * Pick a connection that has free AMQ slots (round-robin).
   * @returns {PlcConnection | null}
   */
  acquire() {
    const count = this.#connections.length;
    if (count === 0) return null;

    for (let i = 0; i < count; i++) {
      const idx = (this.#roundRobinIdx + i) % count;
      const conn = this.#connections[idx];
      if (conn.state === 'ready' && conn.freeAmqSlots > 0) {
        this.#roundRobinIdx = (idx + 1) % count;
        return conn;
      }
    }
    return null;
  }

  /**
   * @param {PlcEndpoint} endpoint
   * @returns {Promise<void>}
   */
  async #createConnections(endpoint) {
    /** @type {Promise<void>[]} */
    const tasks = [];

    for (let i = 0; i < this.#poolSize; i++) {
      const connId = `${this.#targetId}-${i}`;
      const conn = new PlcConnection(connId, this.#targetId, endpoint, this.#bridge, this.#logger, this.#requestTimeoutMs);

      conn.on('close', () => {
        this.#logger.warn({ connId }, 'Connection closed - reconnecting');
        this.#reconnect(conn, endpoint);
      });

      conn.on('error', (err) => {
        this.#logger.error({ connId, err }, 'Connection error');
      });

      this.#connections.push(conn);
      tasks.push(conn.connect());
    }

    const results = await Promise.allSettled(tasks);
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      this.#logger.warn(`${failed.length}/${this.#poolSize} connections failed to establish`);
    }
  }

  async #destroyConnections() {
    const tasks = this.#connections.map((c) => c.disconnect());
    await Promise.allSettled(tasks);
    this.#connections = [];
    this.#roundRobinIdx = 0;
  }

  /**
   * @param {PlcConnection} _old
   * @param {PlcEndpoint} endpoint
   */
  async #reconnect(_old, endpoint) {
    const idx = this.#connections.indexOf(_old);
    if (idx === -1) return;

    const connId = _old.id;
    const conn = new PlcConnection(connId, this.#targetId, endpoint, this.#bridge, this.#logger, this.#requestTimeoutMs);

    conn.on('close', () => this.#reconnect(conn, endpoint));
    conn.on('error', (err) => {
      this.#logger.error({ connId, err }, 'Reconnection error');
    });

    this.#connections[idx] = conn;

    try {
      await conn.connect();
      this.#logger.info({ connId }, 'Reconnected successfully');
    } catch (err) {
      this.#logger.error({ connId, err }, 'Reconnection failed - retrying in 5s');
      setTimeout(() => this.#reconnect(conn, endpoint), 5000);
    }
  }

  /**
   * @param {PlcEndpoint} _from
   * @param {PlcEndpoint} to
   */
  async #handleFailover(_from, to) {
    this.#logger.warn({ to: to.ip }, 'Failing over connections');
    await this.#destroyConnections();
    await this.#createConnections(to);
    this.emit('failover', to);
  }
}
