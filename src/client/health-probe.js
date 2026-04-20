// @ts-check
// TCP liveness probe for PLC endpoint health checking

import { Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { S7_DEFAULT_PORT } from '../protocol/constants.js';

/** @import { PlcEndpoint } from '../protocol/types.js' */

export class HealthProbe extends EventEmitter {
  /** @type {PlcEndpoint} */
  #endpoint;
  /** @type {number} */
  #intervalMs;
  /** @type {number} */
  #timeoutMs;
  /** @type {number} */
  #failThreshold;
  /** @type {number} */
  #recoverThreshold;
  /** @type {ReturnType<typeof setInterval> | null} */
  #timer = null;

  #consecutiveFailures = 0;
  #consecutiveSuccesses = 0;
  #lastCheckAt = 0;
  #lastLatencyMs = 0;
  #healthy = false;

  /**
   * @param {PlcEndpoint} endpoint
   * @param {number} [intervalMs=2000]
   * @param {number} [timeoutMs=1000]
   * @param {number} [failThreshold=3]
   * @param {number} [recoverThreshold=3]
   */
  constructor(endpoint, intervalMs = 2000, timeoutMs = 1000, failThreshold = 3, recoverThreshold = 3) {
    super();
    this.#endpoint = endpoint;
    this.#intervalMs = intervalMs;
    this.#timeoutMs = timeoutMs;
    this.#failThreshold = failThreshold;
    this.#recoverThreshold = recoverThreshold;
  }

  get healthy() { return this.#healthy; }
  get consecutiveFailures() { return this.#consecutiveFailures; }
  get consecutiveSuccesses() { return this.#consecutiveSuccesses; }
  get lastCheckAt() { return this.#lastCheckAt; }
  get lastLatencyMs() { return this.#lastLatencyMs; }

  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.#probe(), this.#intervalMs);
    this.#probe();
  }

  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** @returns {Promise<boolean>} */
  async probeOnce() {
    return this.#probe();
  }

  /** @returns {Promise<boolean>} */
  async #probe() {
    const start = Date.now();
    this.#lastCheckAt = start;

    try {
      await this.#tcpConnect();
      this.#lastLatencyMs = Date.now() - start;
      this.#consecutiveFailures = 0;
      this.#consecutiveSuccesses++;
      this.#healthy = true;
      this.emit('healthy');

      if (this.#consecutiveSuccesses === this.#recoverThreshold) {
        this.emit('threshold:recovered');
      }
      return true;
    } catch {
      this.#lastLatencyMs = Date.now() - start;
      this.#consecutiveSuccesses = 0;
      this.#consecutiveFailures++;
      this.#healthy = false;
      this.emit('unhealthy');

      if (this.#consecutiveFailures === this.#failThreshold) {
        this.emit('threshold:failed');
      }
      return false;
    }
  }

  /** @returns {Promise<void>} */
  #tcpConnect() {
    return new Promise((resolve, reject) => {
      const socket = new Socket();

      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('Probe timeout'));
      }, this.#timeoutMs);

      socket.connect(S7_DEFAULT_PORT, this.#endpoint.ip, () => {
        clearTimeout(timer);
        socket.destroy();
        resolve();
      });

      socket.on('error', (err) => {
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      });
    });
  }
}
