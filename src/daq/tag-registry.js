// @ts-check
// Tag registry — stores all DAQ tag definitions and subscriptions

/** @import { TagDefinition, DaqSubscription, PriorityLevel } from '../protocol/types.js' */

export class TagRegistry {
  /** @type {Map<string, TagDefinition>} tagName → definition */
  #tags = new Map();
  /** @type {Map<string, DaqSubscription>} subscriptionId → sub */
  #subscriptions = new Map();
  /** @type {Map<string, Set<string>>} tagName → set of subscription IDs */
  #tagSubscribers = new Map();

  /**
   * Register a tag definition.
   * @param {TagDefinition} tag
   */
  registerTag(tag) {
    this.#tags.set(tag.name, tag);
    if (!this.#tagSubscribers.has(tag.name)) {
      this.#tagSubscribers.set(tag.name, new Set());
    }
  }

  /**
   * @param {string} name
   * @returns {TagDefinition | undefined}
   */
  getTag(name) {
    return this.#tags.get(name);
  }

  /** @returns {TagDefinition[]} */
  getAllTags() {
    return [...this.#tags.values()];
  }

  /**
   * Add a subscription.
   * @param {DaqSubscription} sub
   */
  addSubscription(sub) {
    this.#subscriptions.set(sub.id, sub);
    for (const tagName of sub.tags) {
      const subs = this.#tagSubscribers.get(tagName);
      if (subs) subs.add(sub.id);
    }
  }

  /**
   * Remove a subscription.
   * @param {string} subId
   */
  removeSubscription(subId) {
    const sub = this.#subscriptions.get(subId);
    if (!sub) return;
    for (const tagName of sub.tags) {
      const subs = this.#tagSubscribers.get(tagName);
      if (subs) subs.delete(subId);
    }
    this.#subscriptions.delete(subId);
  }

  /**
   * @param {string} subId
   * @returns {DaqSubscription | undefined}
   */
  getSubscription(subId) {
    return this.#subscriptions.get(subId);
  }

  /** @returns {DaqSubscription[]} */
  getAllSubscriptions() {
    return [...this.#subscriptions.values()];
  }

  /**
   * Get all subscription IDs for a tag.
   * @param {string} tagName
   * @returns {string[]}
   */
  getSubscribers(tagName) {
    return [...(this.#tagSubscribers.get(tagName) ?? [])];
  }

  /**
   * Group tags by scan interval for scan group creation.
   * @returns {Map<number, TagDefinition[]>}
   */
  groupByInterval() {
    /** @type {Map<number, TagDefinition[]>} */
    const groups = new Map();
    for (const tag of this.#tags.values()) {
      const interval = tag.scanIntervalMs ?? 1000;
      const list = groups.get(interval);
      if (list) list.push(tag);
      else groups.set(interval, [tag]);
    }
    return groups;
  }
}
