// @ts-check
// Connection pool for a single PLC target

import { EventEmitter } from 'node:events';
import { PlcConnection } from './plc-connection.js';
import { FailoverManager } from './failover-manager.js';

/** @import { PlcTarget, PlcEndpoint, FailoverConfig } from '../protocol/types.js' */
/** @import { WasmBridge } from '../wasm/bridge.js' */
/** @import { Logger } from '../logging/logger.js' */

export class ConnectionPool extends EventEmitter {
  /** @type {string} */
  #targetId;
  /** @type {PlcTarget} */
  #target;
  /** @type {WasmBridge} */
  #bridge;
  /** @type {Logger} */
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
  #running = false;
  #generation = 0;
  /** @type {Promise<void> | null} */
  #startPromise = null;
  /** @type {Map<number, ReturnType<typeof setTimeout>>} */
  #reconnectTimers = new Map();
  /** @type {Map<number, number>} */
  #reconnectAttempts = new Map();

  /**
   * @param {PlcTarget} target
   * @param {WasmBridge} bridge
   * @param {FailoverConfig} failoverConfig
   * @param {Logger} logger
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
    const handleFailover = (/** @type {PlcEndpoint} */ from, /** @type {PlcEndpoint} */ to) => {
      this.#handleFailover(from, to).catch((err) => this.#logger.error({ err }, 'Pool failover failed'));
    };
    this.#failoverManager.on('failover', handleFailover);
    this.#failoverManager.on('failback', handleFailover);
  }

  get failoverManager() { return this.#failoverManager; }
  get targetId() { return this.#targetId; }
  get connections() { return [...this.#connections]; }

  async start() {
    if (this.#running) return this.#startPromise;
    this.#running = true;
    const generation = ++this.#generation;
    this.#failoverManager.start();
    this.#startPromise = this.#createConnections(this.#failoverManager.activeEndpoint, generation);
    await this.#startPromise;
  }

  async stop() {
    this.#running = false;
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
   * @param {number} generation
   * @returns {Promise<void>}
   */
  async #createConnections(endpoint, generation) {
    /** @type {Promise<void>[]} */
    const tasks = [];

    for (let i = 0; i < this.#poolSize; i++) {
      tasks.push(this.#connectSlot(i, endpoint, generation));
    }
    await Promise.all(tasks);
  }

  async #destroyConnections() {
    this.#generation++;
    for (const timer of this.#reconnectTimers.values()) clearTimeout(timer);
    this.#reconnectTimers.clear();
    this.#reconnectAttempts.clear();
    const connections = this.#connections;
    this.#connections = [];
    this.#roundRobinIdx = 0;
    await Promise.all(connections.map((c) => c.disconnect()));
  }

  /**
   * @param {number} index
   * @param {PlcEndpoint} endpoint
   * @param {number} generation
   */
  async #connectSlot(index, endpoint, generation) {
    if (!this.#running || generation !== this.#generation) return;
    const connId = `${this.#targetId}-${index}`;
    const conn = new PlcConnection(connId, this.#targetId, endpoint, this.#bridge, this.#logger, this.#requestTimeoutMs);

    conn.on('close', () => this.#scheduleReconnect(conn, index, endpoint, generation));
    conn.on('error', (err) => {
      this.#logger.error({ connId, err }, 'Reconnection error');
    });

    this.#connections[index] = conn;

    try {
      await conn.connect();
      if (generation !== this.#generation || this.#connections[index] !== conn) return;
      this.#reconnectAttempts.delete(index);
      this.#logger.info({ connId }, 'Connection ready');
    } catch (err) {
      this.#logger.error({ connId, err }, 'Connection attempt failed');
      this.#scheduleReconnect(conn, index, endpoint, generation);
    }
  }

  /**
   * @param {PlcConnection} conn
   * @param {number} index
   * @param {PlcEndpoint} endpoint
   * @param {number} generation
   */
  #scheduleReconnect(conn, index, endpoint, generation) {
    if (!this.#running || generation !== this.#generation || this.#connections[index] !== conn) return;
    if (this.#reconnectTimers.has(index)) return;
    const attempt = this.#reconnectAttempts.get(index) ?? 0;
    const delay = Math.min(250 * 2 ** Math.min(attempt, 5), 5000);
    this.#reconnectAttempts.set(index, attempt + 1);
    this.#logger.warn({ connId: conn.id, delay }, 'Scheduling reconnect');
    this.#reconnectTimers.set(index, setTimeout(() => {
      this.#reconnectTimers.delete(index);
      this.#connectSlot(index, endpoint, generation).catch((err) => {
        this.#logger.error({ connId: conn.id, err }, 'Reconnect failed');
      });
    }, delay));
  }

  /**
   * @param {PlcEndpoint} _from
   * @param {PlcEndpoint} to
   */
  async #handleFailover(_from, to) {
    this.#logger.warn({ to: to.ip }, 'Failing over connections');
    const stopping = this.#destroyConnections();
    const generation = this.#generation;
    await stopping;
    if (!this.#running || generation !== this.#generation) return;
    await this.#createConnections(to, generation);
    if (generation === this.#generation) this.emit('failover', to);
  }
}
