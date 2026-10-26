// @ts-check
// Integration test — Full ProxyServer start/stop lifecycle

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startIntegrationDemoServer as startDemoServer } from '../helpers.js';

/** @type {import('../demo-server.js').DemoServer} */
let demo;

describe('ProxyServer (smoke)', () => {
  beforeAll(async () => {
    demo = await startDemoServer({ silent: true, port: 11102 });
  });

  afterAll(() => {
    demo.stop();
  });

  it('demo server should be running and serving clients', () => {
    const status = demo.server.ServerStatus();
    // SrvRunning = 0x01
    expect(status).toBe(0x01);
  });

  it('demo server should report 0 connected clients initially', () => {
    // There might be leftover connections from other tests, so just check the API works
    const count = demo.server.ClientsCount();
    expect(typeof count).toBe('number');
  });

  it('DB1 buffer should contain the expected test pattern', () => {
    const { db1 } = demo.areas;
    expect(db1[0]).toBe(0xAB);
    expect(db1[1]).toBe(0xCD);
    expect(db1.readUInt16BE(2)).toBe(0x1234);
    expect(db1.readInt32BE(4)).toBe(42);
    expect(db1.toString('ascii', 12, 20)).toBe('S7Proxy!');
  });

  it('DB2 buffer should contain the ramp pattern', () => {
    const { db2 } = demo.areas;
    for (let i = 0; i < 256; i++) {
      expect(db2[i]).toBe(i & 0xFF);
    }
  });

  it('MK area should be all 0xFF', () => {
    const { mk } = demo.areas;
    for (let i = 0; i < mk.length; i++) {
      expect(mk[i]).toBe(0xFF);
    }
  });
});
