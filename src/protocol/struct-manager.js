// @ts-check
// StructManager — first-class structured DB access across native, REST, and WebSocket
//
// Bridges DBStruct definitions with the S7Proxy connection pool, WASM bridge,
// and DAQ engine to provide named-field read/write/subscribe with automatic
// encode/decode.

import { EventEmitter } from 'eventemitter3';
import { DBStruct } from './db-struct.js';
import { S7AreaDB, S7WLByte } from './constants.js';

/** @import { ConnectionPool } from '../client/connection-pool.js' */
/** @import { WasmBridge } from '../wasm/bridge.js' */
/** @import { DaqEngine } from '../daq/daq-engine.js' */
/** @import { S7StructDef, S7Value } from './db-struct.js' */
/** @import pino from 'pino' */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} StructSubscription
 * @property {string}   subId       - DAQ subscription ID
 * @property {string}   structName  - Struct name
 * @property {string}   targetId    - PLC target ID
 * @property {number}   intervalMs  - Scan interval
 * @property {string}   tagName     - Internal tag name
 */



// ─── StructManager ───────────────────────────────────────────────────────────

export class StructManager extends EventEmitter {
  /** @type {Map<string, DBStruct>} */
  #structs = new Map();

  /** @type {Map<string, StructSubscription>} */
  #structSubs = new Map();

  /** @type {Map<string, string>} tag name → struct name mapping for decode */
  #tagToStruct = new Map();

  /** @type {Map<string, Record<string, S7Value>>} struct name → latest decoded values */
  #valueCache = new Map();

  /** @type {ConnectionPool | null} */
  #pool;
  /** @type {WasmBridge | null} */
  #bridge;
  /** @type {DaqEngine | null} */
  #daq;
  /** @type {string} */
  #defaultTargetId;
  /** @type {pino.Logger | null} */
  #logger;

  /**
   * @param {{
   *   pool?: ConnectionPool | null,
   *   bridge?: WasmBridge | null,
   *   daq?: DaqEngine | null,
   *   targetId?: string,
   *   logger?: pino.Logger | null
   * }} [opts]
   */
  constructor(opts = {}) {
    super();
    this.#pool = opts.pool ?? null;
    this.#bridge = opts.bridge ?? null;
    this.#daq = opts.daq ?? null;
    this.#defaultTargetId = opts.targetId ?? 'plc1';
    this.#logger = opts.logger ?? null;

    // Wire up DAQ struct decoding
    if (this.#daq) {
      this.#bindDaq(this.#daq);
    }
  }

  /**
   * Bind runtime dependencies (pool, bridge, daq) after construction.
   * Called by ProxyServer once infrastructure is ready.
   * @param {{
   *   pool?: ConnectionPool | null,
   *   bridge?: WasmBridge | null,
   *   daq?: DaqEngine | null,
   *   targetId?: string,
   *   logger?: pino.Logger | null
   * }} opts
   */
  bind(opts) {
    if (opts.pool) this.#pool = opts.pool;
    if (opts.bridge) this.#bridge = opts.bridge;
    if (opts.daq && this.#daq !== opts.daq) {
      this.#daq = opts.daq;
      this.#bindDaq(this.#daq);
    }
    if (opts.targetId) this.#defaultTargetId = opts.targetId;
    if (opts.logger) this.#logger = opts.logger;
  }

  /**
   * @param {DaqEngine} daq
   */
  #bindDaq(daq) {
    daq.on('subscription:data', (/** @type {string} */ subId, /** @type {any} */ data) => {
      this.#onSubscriptionData(subId, data);
    });
  }

  // ─── Registry ────────────────────────────────────────────────────────────

  /**
   * Register a struct definition.
   * @param {S7StructDef} def
   * @returns {DBStruct}
   */
  register(def) {
    const struct = new DBStruct(def);
    this.#structs.set(struct.name, struct);
    this.#logger?.info({ struct: struct.name, db: struct.db, size: struct.size }, 'Struct registered');
    this.emit('registered', struct.name, struct);
    return struct;
  }

  /**
   * Register multiple struct definitions at once.
   * @param {S7StructDef[]} defs
   * @returns {DBStruct[]}
   */
  registerMany(defs) {
    return defs.map((d) => this.register(d));
  }

  /**
   * Unregister a struct.
   * @param {string} name
   */
  unregister(name) {
    this.#structs.delete(name);
    this.#valueCache.delete(name);
    this.emit('unregistered', name);
  }

  /**
   * Get a registered struct by name.
   * @param {string} name
   * @returns {DBStruct | undefined}
   */
  get(name) {
    return this.#structs.get(name);
  }

  /**
   * Check if a struct is registered.
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this.#structs.has(name);
  }

  /** @returns {string[]} */
  list() {
    return [...this.#structs.keys()];
  }

  /**
   * Get struct info for all registered structs.
   * @returns {Array<{ name: string, db: number, offset: number, size: number, fields: string[] }>}
   */
  listInfo() {
    return [...this.#structs.values()].map((s) => ({
      name: s.name,
      db: s.db,
      offset: s.offset,
      size: s.size,
      fields: s.items.map((i) => i.name),
    }));
  }

  // ─── Direct PLC read / write ─────────────────────────────────────────────

  /**
   * Read a struct from the PLC and return decoded field values.
   * @param {string} name
   * @param {string[]} [keys]  - Optional field filter — only return these keys
   * @param {string} [targetId]
   * @returns {Promise<Record<string, S7Value>>}
   */
  async read(name, keys, targetId) {
    const struct = this.#requireStruct(name);
    const { pool, bridge } = this.#requireConnection();

    const conn = pool.acquire();
    if (!conn) throw new Error('No PLC connection available');

    // Build S7 read request: read `struct.size` bytes from DB
    const frame = bridge.buildReadRequest(
      S7AreaDB, struct.db, struct.offset, struct.size, S7WLByte,
    );
    const pduRef = frame.readUInt16BE(11);
    const response = await conn.sendRequest(frame, pduRef);

    // Parse S7 response: TPKT(4) + COTP(3) + S7 header(12) + param(2) = offset 21
    const dataItemStart = 21;
    const returnCode = response[dataItemStart];
    if (returnCode !== 0xFF) {
      throw new Error(`S7 read error, return code: 0x${returnCode.toString(16)}`);
    }
    const data = response.subarray(dataItemStart + 4, dataItemStart + 4 + struct.size);

    const values = struct.decodeToMap(data);
    this.#valueCache.set(name, values);

    // Filter by keys if provided
    if (keys && keys.length > 0) {
      /** @type {Record<string, S7Value>} */
      const filtered = {};
      for (const k of keys) {
        if (k in values) filtered[k] = values[k];
      }
      return filtered;
    }
    return values;
  }

  /**
   * Write field values to a struct on the PLC.
   * Supports partial writes — merges with cached/current values to produce a
   * complete struct buffer before writing.
   * @param {string} name
   * @param {Record<string, S7Value>} values
   * @param {string} [targetId]
   * @returns {Promise<void>}
   */
  async write(name, values, targetId) {
    const struct = this.#requireStruct(name);
    const { pool, bridge } = this.#requireConnection();

    // Merge with cached values for safe partial writes
    let base = this.#valueCache.get(name);
    if (!base) {
      // No cache — read current state from PLC first
      base = await this.read(name, undefined, targetId);
    }
    const merged = { ...base, ...values };

    const conn = pool.acquire();
    if (!conn) throw new Error('No PLC connection available');

    // Encode merged values into full struct buffer
    const buf = struct.encodeValues(merged);

    // Build S7 write request
    const frame = bridge.buildWriteRequest(
      S7AreaDB, struct.db, struct.offset, struct.size, S7WLByte, buf,
    );
    const pduRef = frame.readUInt16BE(11);
    const response = await conn.sendRequest(frame, pduRef);

    // Check write response: offset 21, return code 0xFF = success
    const dataItemStart = 21;
    const returnCode = response[dataItemStart];
    if (returnCode !== 0xFF) {
      throw new Error(`S7 write error, return code: 0x${returnCode.toString(16)}`);
    }

    // Update local cache with merged values
    this.#valueCache.set(name, merged);
  }

  // ─── DAQ subscriptions ──────────────────────────────────────────────────

  /**
   * Subscribe to a struct via DAQ — scans the PLC at the given interval
   * and emits decoded values on each cycle.
   * @param {string} name
   * @param {string} targetId
   * @param {number} intervalMs
   * @returns {string} subscription ID
   */
  subscribe(name, targetId, intervalMs) {
    const struct = this.#requireStruct(name);
    const daq = this.#requireDaq();

    const tagName = `struct:${name}`;

    // Create a single tag covering the entire struct byte range
    const subId = daq.subscribe({
      targetId,
      tags: [{
        name: tagName,
        area: S7AreaDB,
        start: struct.offset,
        dbNum: struct.db,
        amount: struct.size,
        wordLen: S7WLByte,
      }],
      intervalMs,
    });

    /** @type {StructSubscription} */
    const sub = { subId, structName: name, targetId, intervalMs, tagName };
    this.#structSubs.set(subId, sub);
    this.#tagToStruct.set(tagName, name);

    return subId;
  }

  /**
   * Unsubscribe a struct subscription.
   * @param {string} subId
   */
  unsubscribe(subId) {
    const sub = this.#structSubs.get(subId);
    if (!sub) return;

    this.#requireDaq().unsubscribe(subId);
    this.#tagToStruct.delete(sub.tagName);
    this.#structSubs.delete(subId);
  }

  /** @returns {StructSubscription[]} */
  getStructSubscriptions() {
    return [...this.#structSubs.values()];
  }

  /**
   * Get the latest cached decoded values for a struct.
   * @param {string} name
   * @returns {Record<string, S7Value> | undefined}
   */
  getCachedValues(name) {
    return this.#valueCache.get(name);
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  /**
   * Handle DAQ subscription:data events and decode struct tags.
   * @param {string} subId
   * @param {any} data
   */
  #onSubscriptionData(subId, data) {
    const sub = this.#structSubs.get(subId);
    if (!sub) return;

    const struct = this.#structs.get(sub.structName);
    if (!struct) return;

    // Find the struct tag in the data
    const tag = data.tags?.find((/** @type {any} */ t) => t.name === sub.tagName);
    if (!tag || !tag.value) return;

    const buf = Buffer.from(tag.value, 'hex');
    const values = struct.decodeToMap(buf);
    this.#valueCache.set(sub.structName, values);

    // Emit per-struct event
    this.emit(`struct:data:${sub.structName}`, values);

    // Emit general event
    this.emit('struct:data', {
      structName: sub.structName,
      subscriptionId: subId,
      targetId: sub.targetId,
      values,
      timestamp: Date.now(),
    });
  }

  /**
   * @param {string} name
   * @returns {DBStruct}
   */
  #requireStruct(name) {
    const struct = this.#structs.get(name);
    if (!struct) throw new Error(`Struct "${name}" not registered`);
    return struct;
  }

  #requireConnection() {
    if (!this.#pool || !this.#bridge) {
      throw new Error('StructManager requires a ConnectionPool and WasmBridge');
    }
    return { pool: this.#pool, bridge: this.#bridge };
  }

  #requireDaq() {
    if (!this.#daq) {
      throw new Error('StructManager requires a DaqEngine for subscriptions');
    }
    return this.#daq;
  }

  shutdown() {
    for (const subId of this.#structSubs.keys()) {
      this.unsubscribe(subId);
    }
    this.#structs.clear();
    this.#valueCache.clear();
    this.#tagToStruct.clear();
    this.removeAllListeners();
  }
}
