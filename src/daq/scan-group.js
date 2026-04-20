// @ts-check
// Scan group — periodic scan task for a set of tags with the same interval

import { EventEmitter } from 'node:events';
import { ReadCoalescer } from './read-coalescer.js';

/** @import { TagDefinition, PriorityLevel } from '../protocol/types.js' */
/** @import { CoalescedRead } from './read-coalescer.js' */

export class ScanGroup extends EventEmitter {
  /** @readonly @type {string} */
  id;
  /** @readonly @type {number} */
  intervalMs;
  /** @type {TagDefinition[]} */
  #tags;
  /** @type {ReadCoalescer} */
  #coalescer;
  /** @type {ReturnType<typeof setInterval> | null} */
  #timer = null;
  #running = false;

  /**
   * @param {string} id
   * @param {number} intervalMs
   * @param {TagDefinition[]} tags
   * @param {ReadCoalescer} coalescer
   */
  constructor(id, intervalMs, tags, coalescer) {
    super();
    this.id = id;
    this.intervalMs = intervalMs;
    this.#tags = tags;
    this.#coalescer = coalescer;
  }

  get tags() { return [...this.#tags]; }
  get running() { return this.#running; }

  /**
   * @param {TagDefinition} tag
   */
  addTag(tag) {
    this.#tags.push(tag);
  }

  /**
   * @param {string} tagName
   */
  removeTag(tagName) {
    this.#tags = this.#tags.filter((t) => t.name !== tagName);
  }

  /** @returns {CoalescedRead[]} */
  getCoalescedReads() {
    return this.#coalescer.coalesce(this.#tags);
  }

  start() {
    if (this.#timer) return;
    this.#running = true;
    this.#timer = setInterval(() => {
      this.emit('tick', this.getCoalescedReads());
    }, this.intervalMs);
    // Fire immediately
    this.emit('tick', this.getCoalescedReads());
  }

  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#running = false;
  }
}
