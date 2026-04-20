// @ts-check
// Min-heap priority queue for DAQ scheduling

/** @import { PriorityRequest, PriorityLevel } from '../protocol/types.js' */

/** @type {Record<PriorityLevel, number>} */
const PRIORITY_VALUES = { critical: 0, high: 1, normal: 2, low: 3, background: 4 };

export class PriorityQueue {
  /** @type {PriorityRequest[]} */
  #heap = [];

  get size() { return this.#heap.length; }
  get isEmpty() { return this.#heap.length === 0; }

  /**
   * @param {PriorityRequest} item
   */
  enqueue(item) {
    this.#heap.push(item);
    this.#bubbleUp(this.#heap.length - 1);
  }

  /** @returns {PriorityRequest | undefined} */
  dequeue() {
    if (this.#heap.length === 0) return undefined;
    const top = this.#heap[0];
    const bottom = this.#heap.pop();
    if (this.#heap.length > 0 && bottom) {
      this.#heap[0] = bottom;
      this.#sinkDown(0);
    }
    return top;
  }

  /** @returns {PriorityRequest | undefined} */
  peek() {
    return this.#heap[0];
  }

  clear() {
    this.#heap = [];
  }

  /** @param {number} idx */
  #bubbleUp(idx) {
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (this.#compare(this.#heap[idx], this.#heap[parent]) < 0) {
        [this.#heap[idx], this.#heap[parent]] = [this.#heap[parent], this.#heap[idx]];
        idx = parent;
      } else {
        break;
      }
    }
  }

  /** @param {number} idx */
  #sinkDown(idx) {
    const len = this.#heap.length;
    while (true) {
      let smallest = idx;
      const left = 2 * idx + 1;
      const right = 2 * idx + 2;

      if (left < len && this.#compare(this.#heap[left], this.#heap[smallest]) < 0) smallest = left;
      if (right < len && this.#compare(this.#heap[right], this.#heap[smallest]) < 0) smallest = right;

      if (smallest !== idx) {
        [this.#heap[idx], this.#heap[smallest]] = [this.#heap[smallest], this.#heap[idx]];
        idx = smallest;
      } else {
        break;
      }
    }
  }

  /**
   * @param {PriorityRequest} a
   * @param {PriorityRequest} b
   * @returns {number}
   */
  #compare(a, b) {
    const pa = PRIORITY_VALUES[a.priority] ?? 2;
    const pb = PRIORITY_VALUES[b.priority] ?? 2;
    if (pa !== pb) return pa - pb;
    return a.enqueuedAt - b.enqueuedAt;
  }
}
