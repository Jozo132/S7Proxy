// @ts-check
// Unit test — PriorityQueue, TagRegistry, DataCache, ReadCoalescer

import { describe, it, expect, beforeEach } from 'vitest';
import { PriorityQueue } from '../../src/daq/priority-queue.js';
import { TagRegistry } from '../../src/daq/tag-registry.js';
import { DataCache } from '../../src/daq/data-cache.js';
import { ReadCoalescer } from '../../src/daq/read-coalescer.js';

describe('PriorityQueue', () => {
  /** @type {PriorityQueue} */
  let q;

  beforeEach(() => { q = new PriorityQueue(); });

  it('should enqueue and dequeue in priority order', () => {
    q.enqueue({ id: 'a', priority: 'low', enqueuedAt: Date.now(), payload: {} });
    q.enqueue({ id: 'b', priority: 'critical', enqueuedAt: Date.now(), payload: {} });
    q.enqueue({ id: 'c', priority: 'normal', enqueuedAt: Date.now(), payload: {} });

    expect(q.size).toBe(3);
    const first = q.dequeue();
    expect(first?.id).toBe('b');     // critical first
    const second = q.dequeue();
    expect(second?.id).toBe('c');    // then normal
    const third = q.dequeue();
    expect(third?.id).toBe('a');     // then low
  });

  it('should dequeue same-priority items FIFO', () => {
    const t0 = Date.now();
    q.enqueue({ id: 'x', priority: 'normal', enqueuedAt: t0, payload: {} });
    q.enqueue({ id: 'y', priority: 'normal', enqueuedAt: t0 + 1, payload: {} });

    expect(q.dequeue()?.id).toBe('x');
    expect(q.dequeue()?.id).toBe('y');
  });

  it('isEmpty and clear', () => {
    expect(q.isEmpty).toBe(true);
    q.enqueue({ id: 'z', priority: 'high', enqueuedAt: Date.now(), payload: {} });
    expect(q.isEmpty).toBe(false);
    q.clear();
    expect(q.isEmpty).toBe(true);
  });

  it('peek returns head without removing', () => {
    q.enqueue({ id: 'p', priority: 'high', enqueuedAt: Date.now(), payload: {} });
    expect(q.peek()?.id).toBe('p');
    expect(q.size).toBe(1);
  });
});

describe('TagRegistry', () => {
  /** @type {TagRegistry} */
  let reg;

  beforeEach(() => { reg = new TagRegistry(); });

  it('should register and retrieve tags', () => {
    const tag = { name: 'DB1.DBW0', area: 0x84, dbNumber: 1, start: 0, amount: 1, wordLen: 0x02 };
    reg.registerTag(tag);
    expect(reg.getTag('DB1.DBW0')).toEqual(tag);
    expect(reg.getAllTags()).toHaveLength(1);
  });

  it('should manage subscriptions', () => {
    const sub = { id: 'sub1', targetId: 'plc1', tags: [], intervalMs: 1000 };
    reg.addSubscription(sub);
    expect(reg.getSubscription('sub1')).toBeDefined();
    expect(reg.getAllSubscriptions()).toHaveLength(1);

    reg.removeSubscription('sub1');
    expect(reg.getSubscription('sub1')).toBeUndefined();
  });
});

describe('DataCache', () => {
  it('should set, get, and expire entries', async () => {
    const cache = new DataCache(100); // 100ms TTL

    cache.set('tag1', Buffer.from([1, 2, 3]), 192);
    const val = cache.get('tag1');
    expect(val).toBeDefined();
    expect(val?.value).toEqual(Buffer.from([1, 2, 3]));
    expect(val?.quality).toBe(192);

    // Wait for TTL to expire
    await new Promise(r => setTimeout(r, 150));
    expect(cache.get('tag1')).toBeUndefined();
  });

  it('should delete and clear', () => {
    const cache = new DataCache(5000);
    cache.set('a', Buffer.from([0]));
    cache.set('b', Buffer.from([1]));
    expect(cache.size).toBe(2);

    cache.delete('a');
    expect(cache.has('a')).toBe(false);

    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe('ReadCoalescer', () => {
  it('should be constructible', () => {
    const rc = new ReadCoalescer();
    expect(rc).toBeDefined();
  });
});
