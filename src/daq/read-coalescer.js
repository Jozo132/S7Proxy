// @ts-check
// Read coalescer — merges overlapping S7 read requests

/** @import { TagDefinition } from '../protocol/types.js' */

/**
 * @typedef {Object} CoalescedRead
 * @property {number} area
 * @property {number} dbNum
 * @property {number} start
 * @property {number} amount
 * @property {number} wordLen
 * @property {TagDefinition[]} tags
 */

export class ReadCoalescer {
  /** @type {number} Maximum gap (bytes) between addresses to coalesce */
  #maxGap;
  /** @type {number} Maximum PDU data size to stay within */
  #maxReadSize;

  /**
   * @param {number} [maxGap=4]
   * @param {number} [maxReadSize=400]
   */
  constructor(maxGap = 4, maxReadSize = 400) {
    this.#maxGap = maxGap;
    this.#maxReadSize = maxReadSize;
  }

  /**
   * Coalesce tags into merged read operations.
   * @param {TagDefinition[]} tags
   * @returns {CoalescedRead[]}
   */
  coalesce(tags) {
    if (tags.length === 0) return [];

    // Group by area + dbNum + wordLen
    /** @type {Map<string, TagDefinition[]>} */
    const groups = new Map();
    for (const tag of tags) {
      const key = `${tag.area}:${tag.dbNum}:${tag.wordLen}`;
      const group = groups.get(key);
      if (group) group.push(tag);
      else groups.set(key, [tag]);
    }

    /** @type {CoalescedRead[]} */
    const result = [];

    for (const groupTags of groups.values()) {
      // Sort by start address
      groupTags.sort((a, b) => a.start - b.start);

      let current = this.#startRead(groupTags[0]);

      for (let i = 1; i < groupTags.length; i++) {
        const tag = groupTags[i];
        const currentEnd = current.start + current.amount;
        const tagEnd = tag.start + tag.amount;

        if (tag.start <= currentEnd + this.#maxGap && (tagEnd - current.start) <= this.#maxReadSize) {
          // Merge
          current.amount = Math.max(currentEnd, tagEnd) - current.start;
          current.tags.push(tag);
        } else {
          result.push(current);
          current = this.#startRead(tag);
        }
      }
      result.push(current);
    }

    return result;
  }

  /**
   * @param {TagDefinition} tag
   * @returns {CoalescedRead}
   */
  #startRead(tag) {
    return {
      area: tag.area,
      dbNum: tag.dbNum,
      start: tag.start,
      amount: tag.amount,
      wordLen: tag.wordLen,
      tags: [tag],
    };
  }
}
