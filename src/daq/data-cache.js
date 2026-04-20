// @ts-check
// Data cache — stores latest values for DAQ tags with TTL

/** @import { CachedValue } from '../protocol/types.js' */

export class DataCache {
  /** @type {Map<string, CachedValue>} tagName → cached value */
  #cache = new Map();
  /** @type {number} Default TTL in milliseconds */
  #defaultTtlMs;

  /** @param {number} [defaultTtlMs=5000] */
  constructor(defaultTtlMs = 5000) {
    this.#defaultTtlMs = defaultTtlMs;
  }

  /**
   * @param {string} tagName
   * @param {Buffer} value
   * @param {number} [quality=192]
   */
  set(tagName, value, quality = 192) {
    this.#cache.set(tagName, {
      tagName,
      value,
      quality,
      timestamp: Date.now(),
    });
  }

  /**
   * @param {string} tagName
   * @returns {CachedValue | undefined}
   */
  get(tagName) {
    const entry = this.#cache.get(tagName);
    if (!entry) return undefined;

    if (Date.now() - entry.timestamp > this.#defaultTtlMs) {
      this.#cache.delete(tagName);
      return undefined;
    }
    return entry;
  }

  /**
   * @param {string} tagName
   * @returns {boolean}
   */
  has(tagName) {
    return this.get(tagName) !== undefined;
  }

  /** @param {string} tagName */
  delete(tagName) {
    this.#cache.delete(tagName);
  }

  clear() {
    this.#cache.clear();
  }

  get size() {
    return this.#cache.size;
  }

  /** @returns {CachedValue[]} */
  getAll() {
    const now = Date.now();
    /** @type {CachedValue[]} */
    const values = [];
    for (const [key, entry] of this.#cache) {
      if (now - entry.timestamp > this.#defaultTtlMs) {
        this.#cache.delete(key);
      } else {
        values.push(entry);
      }
    }
    return values;
  }
}
