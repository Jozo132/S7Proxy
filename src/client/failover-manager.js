// @ts-check
// Failover manager — per-target health monitoring + state machine

import { EventEmitter } from 'eventemitter3';
import { HealthProbe } from './health-probe.js';

/** @import { PlcTarget, PlcEndpoint, FailoverState, FailoverConfig, EndpointHealth } from '../protocol/types.js' */
/** @import pino from 'pino' */

export class FailoverManager extends EventEmitter {
  /** @type {PlcTarget} */
  #target;
  /** @type {FailoverConfig} */
  #config;
  /** @type {pino.Logger} */
  #logger;

  /** @type {FailoverState} */
  #state = 'PRIMARY_ACTIVE';
  /** @type {number} 0 = primary, 1+ = backups[n-1] */
  #activeEndpointIndex = 0;
  /** @type {Map<string, HealthProbe>} */
  #probes = new Map();
  /** @type {ReturnType<typeof setTimeout> | null} */
  #failbackTimer = null;

  /**
   * @param {PlcTarget} target
   * @param {FailoverConfig} globalDefaults
   * @param {pino.Logger} logger
   */
  constructor(target, globalDefaults, logger) {
    super();
    this.#target = target;
    this.#config = { ...globalDefaults, ...target.failover };
    this.#logger = logger.child({ component: 'failover', target: target.id });
  }

  get state() { return this.#state; }
  get activeEndpointIndex() { return this.#activeEndpointIndex; }

  /** @returns {PlcEndpoint} */
  get activeEndpoint() {
    if (this.#activeEndpointIndex === 0) return this.#target.primary;
    return /** @type {PlcEndpoint[]} */ (this.#target.backups)[this.#activeEndpointIndex - 1];
  }

  /** @returns {PlcEndpoint[]} */
  get allEndpoints() {
    return [this.#target.primary, ...(this.#target.backups ?? [])];
  }

  /** @returns {EndpointHealth[]} */
  getEndpointHealth() {
    return this.allEndpoints.map((ep) => {
      const key = `${ep.ip}:${ep.rack}:${ep.slot}`;
      const probe = this.#probes.get(key);
      return {
        endpoint: ep,
        healthy: probe?.healthy ?? false,
        consecutiveFailures: probe?.consecutiveFailures ?? 0,
        consecutiveSuccesses: probe?.consecutiveSuccesses ?? 0,
        lastCheckAt: probe?.lastCheckAt ?? 0,
        latencyMs: probe?.lastLatencyMs ?? 0,
      };
    });
  }

  start() {
    if (!this.#target.backups?.length) return;

    for (const ep of this.allEndpoints) {
      const key = `${ep.ip}:${ep.rack}:${ep.slot}`;
      const probe = new HealthProbe(
        ep,
        this.#config.healthCheckIntervalMs,
        this.#config.healthCheckTimeoutMs,
        this.#config.failoverThreshold,
        this.#config.failbackThreshold,
      );

      probe.on('threshold:failed', () => {
        this.#logger.warn({ endpoint: ep.ip }, 'Endpoint failed threshold');
        this.emit('endpoint:unhealthy', ep, probe.consecutiveFailures);
        this.#handleEndpointFailed(ep);
      });

      probe.on('threshold:recovered', () => {
        this.#logger.info({ endpoint: ep.ip }, 'Endpoint recovered');
        this.emit('endpoint:recovered', ep);
        this.#handleEndpointRecovered(ep);
      });

      probe.start();
      this.#probes.set(key, probe);
    }
  }

  stop() {
    for (const probe of this.#probes.values()) {
      probe.stop();
    }
    this.#probes.clear();
    if (this.#failbackTimer) {
      clearTimeout(this.#failbackTimer);
      this.#failbackTimer = null;
    }
  }

  /** @returns {Promise<PlcEndpoint>} */
  async forceFailover() {
    const nextIdx = this.#getNextEndpointIndex();
    if (nextIdx === -1) throw new Error('No backup endpoints available');

    const from = this.activeEndpoint;
    this.#activeEndpointIndex = nextIdx;
    const to = this.activeEndpoint;

    this.#setState(nextIdx === 0 ? 'PRIMARY_ACTIVE' : 'BACKUP_ACTIVE');
    this.emit('failover', from, to);
    return to;
  }

  /** @returns {Promise<PlcEndpoint>} */
  async forceFailback() {
    if (this.#activeEndpointIndex === 0) throw new Error('Already on primary');

    const from = this.activeEndpoint;
    this.#activeEndpointIndex = 0;
    const to = this.#target.primary;

    this.#setState('PRIMARY_ACTIVE');
    this.emit('failback', from, to);
    return to;
  }

  /** @param {PlcEndpoint} ep */
  #handleEndpointFailed(ep) {
    const epIdx = this.allEndpoints.indexOf(ep);
    if (epIdx !== this.#activeEndpointIndex) return;

    const nextIdx = this.#getNextEndpointIndex();
    if (nextIdx === -1) {
      this.#logger.error('All endpoints failed - no more backups');
      return;
    }

    const from = this.activeEndpoint;
    this.#setState('FAILING_OVER');
    this.#activeEndpointIndex = nextIdx;
    const to = this.activeEndpoint;

    this.#logger.warn({ from: from.ip, to: to.ip }, 'Failing over');
    this.#setState(nextIdx === 0 ? 'PRIMARY_ACTIVE' : 'BACKUP_ACTIVE');
    this.emit('failover', from, to);
  }

  /** @param {PlcEndpoint} ep */
  #handleEndpointRecovered(ep) {
    if (this.#activeEndpointIndex === 0) return;
    if (ep !== this.#target.primary) return;

    if (this.#config.failbackMode === 'manual') {
      this.#logger.info('Primary recovered - manual failback required');
      return;
    }

    if (this.#failbackTimer) return;

    this.#logger.info(`Primary recovered - scheduling failback in ${this.#config.failbackDelayMs}ms`);
    this.#failbackTimer = setTimeout(() => {
      this.#failbackTimer = null;
      const from = this.activeEndpoint;
      this.#activeEndpointIndex = 0;
      const to = this.#target.primary;
      this.#setState('PRIMARY_ACTIVE');
      this.#logger.info({ from: from.ip, to: to.ip }, 'Failback to primary');
      this.emit('failback', from, to);
    }, this.#config.failbackDelayMs);
  }

  /** @returns {number} */
  #getNextEndpointIndex() {
    const total = this.allEndpoints.length;
    for (let i = 1; i < total; i++) {
      const idx = (this.#activeEndpointIndex + i) % total;
      const ep = this.allEndpoints[idx];
      const key = `${ep.ip}:${ep.rack}:${ep.slot}`;
      const probe = this.#probes.get(key);
      if (!probe || probe.healthy) return idx;
    }
    return -1;
  }

  /** @param {FailoverState} state */
  #setState(state) {
    if (this.#state !== state) {
      this.#state = state;
      this.emit('state:change', state);
    }
  }
}
