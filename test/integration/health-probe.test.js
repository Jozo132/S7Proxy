// @ts-check
// Integration test — HealthProbe against the demo PLC server

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown } from '../helpers.js';
import { HealthProbe } from '../../src/client/health-probe.js';

/** @type {import('../helpers.js').TestContext} */
let ctx;

describe('HealthProbe', () => {
  beforeAll(async () => {
    ctx = await setup({ port: 11102 });
  });

  afterAll(async () => {
    await teardown();
  });

  it('should probe the configured port and report healthy', async () => {
    const probe = new HealthProbe(
      { ip: '127.0.0.1', rack: 0, slot: 1, port: 11102 },
      2000, // intervalMs
      1000, // timeoutMs
      3,    // failThreshold
      3,    // recoverThreshold
    );

    const ok = await probe.probeOnce();
    expect(ok).toBe(true);
    expect(probe.healthy).toBe(true);
    expect(probe.lastLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('should report unhealthy for unreachable host', async () => {
    const probe = new HealthProbe(
      { ip: '192.0.2.1', rack: 0, slot: 1 },   // TEST-NET — won't respond
      2000,
      500,   // short timeout
      1,     // fail after 1
      3,
    );

    const ok = await probe.probeOnce();
    expect(ok).toBe(false);
  });

  it('should emit threshold:recovered after enough successes', async () => {
    const probe = new HealthProbe(
      { ip: '127.0.0.1', rack: 0, slot: 1, port: 11102 },
      100,   // fast interval
      1000,
      3,
      2,     // recover after 2 successes
    );

    const recovered = new Promise((resolve) => {
      probe.on('threshold:recovered', () => resolve(true));
    });

    probe.start();
    const result = await Promise.race([
      recovered,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000)),
    ]);
    probe.stop();

    expect(result).toBe(true);
  });
});
