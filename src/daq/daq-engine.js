// @ts-check
// DAQ engine — manages subscriptions, scan groups, and priority queue integration

import { EventEmitter } from 'eventemitter3';
import { PriorityQueue } from './priority-queue.js';
import { TagRegistry } from './tag-registry.js';
import { DataCache } from './data-cache.js';
import { ScanGroup } from './scan-group.js';
import { ReadCoalescer } from './read-coalescer.js';

/** @import { ConnectionPool } from '../client/connection-pool.js' */
/** @import { WasmBridge } from '../wasm/bridge.js' */
/** @import { DaqSubscription, DaqConfig, TagDefinition, CachedValue } from '../protocol/types.js' */
/** @import { Metrics } from '../metrics/metrics.js' */
/** @import { CoalescedRead } from './read-coalescer.js' */
/** @import pino from 'pino' */

export class DaqEngine extends EventEmitter {
  /** @type {ConnectionPool} */
  #pool;
  /** @type {WasmBridge} */
  #bridge;
  /** @type {DaqConfig} */
  #config;
  /** @type {pino.Logger} */
  #logger;
  /** @type {Metrics} */
  #metrics;

  /** @readonly @type {PriorityQueue} */
  priorityQueue;
  /** @readonly @type {TagRegistry} */
  tagRegistry;
  /** @readonly @type {DataCache} */
  dataCache;
  /** @type {ReadCoalescer} */
  #coalescer;

  /** @type {Map<string, ScanGroup>} */
  #scanGroups = new Map();
  /** @type {Map<string, DaqSubscription>} */
  #subscriptions = new Map();
  #subscriptionCounter = 0;

  /**
   * @param {ConnectionPool} pool
   * @param {WasmBridge} bridge
   * @param {DaqConfig} config
   * @param {pino.Logger} logger
   * @param {Metrics} metrics
   */
  constructor(pool, bridge, config, logger, metrics) {
    super();
    this.#pool = pool;
    this.#bridge = bridge;
    this.#config = config;
    this.#logger = logger.child({ component: 'daq' });
    this.#metrics = metrics;

    this.priorityQueue = new PriorityQueue();
    this.tagRegistry = new TagRegistry();
    this.dataCache = new DataCache(config.cacheTtlMs ?? 5000);
    this.#coalescer = new ReadCoalescer(config.maxGapBytes ?? 4, 400);
  }

  /**
   * Create a new DAQ subscription.
   * @param {{ targetId: string; tags: TagDefinition[]; intervalMs: number; clientId?: string }} opts
   * @returns {string}
   */
  subscribe(opts) {
    const subId = `sub-${++this.#subscriptionCounter}`;

    for (const tag of opts.tags) {
      if (!this.tagRegistry.getTag(tag.name)) {
        this.tagRegistry.registerTag(tag);
      }
    }

    /** @type {DaqSubscription} */
    const subscription = {
      id: subId,
      targetId: opts.targetId,
      tags: opts.tags.map((t) => t.name),
      intervalMs: opts.intervalMs,
      createdAt: Date.now(),
      active: true,
      clientId: opts.clientId,
    };
    this.#subscriptions.set(subId, subscription);

    const groupKey = `${opts.targetId}:${opts.intervalMs}`;
    let group = this.#scanGroups.get(groupKey);

    if (!group) {
      group = new ScanGroup(groupKey, opts.intervalMs, [], this.#coalescer);

      group.on('tick', (/** @type {CoalescedRead[]} */ reads) => {
        this.#executeScan(opts.targetId, groupKey, reads);
      });

      this.#scanGroups.set(groupKey, group);
    }

    for (const tag of opts.tags) {
      group.addTag(tag);
    }
    group.start();

    this.#metrics.daqActiveSubscriptions.set(this.#subscriptions.size);
    this.emit('subscription:created', subId);
    this.#logger.info({ subId, target: opts.targetId, tags: opts.tags.length, interval: opts.intervalMs }, 'Subscription created');

    return subId;
  }

  /**
   * Remove a subscription.
   * @param {string} subId
   */
  unsubscribe(subId) {
    const sub = this.#subscriptions.get(subId);
    if (!sub) return;

    this.#subscriptions.delete(subId);

    const groupKey = `${sub.targetId}:${sub.intervalMs}`;
    const group = this.#scanGroups.get(groupKey);

    if (group) {
      for (const tagName of sub.tags) {
        const stillUsed = [...this.#subscriptions.values()].some(
          (s) => s.targetId === sub.targetId && s.tags.includes(tagName),
        );
        if (!stillUsed) {
          group.removeTag(tagName);
        }
      }

      if (group.tags.length === 0) {
        group.stop();
        this.#scanGroups.delete(groupKey);
      }
    }

    this.#metrics.daqActiveSubscriptions.set(this.#subscriptions.size);
    this.emit('subscription:removed', subId);
    this.#logger.info({ subId }, 'Subscription removed');
  }

  /**
   * Read cached tag value.
   * @param {string} tagName
   * @returns {CachedValue | undefined}
   */
  getCachedValue(tagName) {
    return this.dataCache.get(tagName);
  }

  /** @returns {DaqSubscription[]} */
  getSubscriptions() {
    return [...this.#subscriptions.values()];
  }

  /**
   * Get scan group stats.
   * @returns {Array<{ id: string; intervalMs: number; tagCount: number; running: boolean }>}
   */
  getScanGroupStats() {
    return [...this.#scanGroups.values()].map((g) => ({
      id: g.id,
      intervalMs: g.intervalMs,
      tagCount: g.tags.length,
      running: g.running,
    }));
  }

  shutdown() {
    for (const group of this.#scanGroups.values()) {
      group.stop();
    }
    this.#scanGroups.clear();
    this.#subscriptions.clear();
    this.dataCache.clear();
    this.priorityQueue.clear();
  }

  /**
   * @param {string} targetId
   * @param {string} groupId
   * @param {CoalescedRead[]} reads
   */
  async #executeScan(targetId, groupId, reads) {
    const start = Date.now();

    for (const read of reads) {
      try {
        const conn = this.#pool.acquire();
        if (!conn) {
          this.#logger.warn({ targetId, groupId }, 'No connection available for scan');
          continue;
        }

        const frame = this.#bridge.buildReadRequest(read.area, read.dbNum, read.start, read.amount, read.wordLen);
        // Extract pduRef from the built frame: TPKT(4) + COTP DT(3) + S7 header offset 4-5
        const pduRef = frame.readUInt16BE(11);
        const response = await conn.sendRequest(frame, pduRef);

        // Update cache for each tag in this coalesced read
        for (const tag of read.tags) {
          const offset = tag.start - read.start;
          const value = response.subarray(offset, offset + tag.amount);
          this.dataCache.set(tag.name, Buffer.from(value), 192);
        }
      } catch (err) {
        this.#logger.error({ err, targetId, groupId }, 'Scan read failed');
        for (const tag of read.tags) {
          this.dataCache.set(tag.name, Buffer.alloc(0), 0);
        }
      }
    }

    const durationMs = Date.now() - start;
    this.#metrics.daqScanDuration.observe({ target: targetId, group: groupId }, durationMs);
    this.#metrics.daqScanTotal.inc({ target: targetId, group: groupId });

    // Notify subscriptions
    for (const [subId, sub] of this.#subscriptions) {
      if (sub.targetId === targetId) {
        this.emit('subscription:data', subId, {
          targetId,
          groupId,
          durationMs,
        });
      }
    }
  }
}
