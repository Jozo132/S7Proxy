// @ts-check
// Integration test — WASM bridge frame-building and parsing

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown } from '../helpers.js';
import {
  COTP_CR, COTP_CC, COTP_DT,
  S7AreaDB, S7WLByte, S7WLWord,
} from '../../src/protocol/constants.js';

/** @type {import('../helpers.js').TestContext} */
let ctx;

describe('WasmBridge', () => {
  beforeAll(async () => {
    ctx = await setup();
  });

  afterAll(async () => {
    await teardown();
  });

  it('should build COTP Connection Request', () => {
    const frame = ctx.bridge.buildCotpCR(0, 1);
    expect(frame).toBeInstanceOf(Buffer);
    expect(frame.length).toBeGreaterThan(0);
    // TPKT header: version 3, reserved 0
    expect(frame[0]).toBe(3);
    expect(frame[1]).toBe(0);
  });

  it('should build COTP Connection Confirm', () => {
    const frame = ctx.bridge.buildCotpCC();
    expect(frame).toBeInstanceOf(Buffer);
    expect(frame.length).toBeGreaterThan(0);
  });

  it('should build S7 Setup Communication', () => {
    const frame = ctx.bridge.buildSetupComm();
    expect(frame).toBeInstanceOf(Buffer);
    expect(frame.length).toBeGreaterThan(0);
  });

  it('should build a read request for DB1', () => {
    const frame = ctx.bridge.buildReadRequest(S7AreaDB, 1, 0, 10, S7WLByte);
    expect(frame).toBeInstanceOf(Buffer);
    expect(frame.length).toBeGreaterThan(0);
  });

  it('should build a read request for DB1 words', () => {
    const frame = ctx.bridge.buildReadRequest(S7AreaDB, 1, 0, 5, S7WLWord);
    expect(frame).toBeInstanceOf(Buffer);
    expect(frame.length).toBeGreaterThan(0);
  });

  it('should build a write request for DB2', () => {
    const data = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const frame = ctx.bridge.buildWriteRequest(S7AreaDB, 2, 0, 4, S7WLByte, data);
    expect(frame).toBeInstanceOf(Buffer);
    expect(frame.length).toBeGreaterThan(0);
  });

  it('should build COTP Disconnect Request', () => {
    const frame = ctx.bridge.buildCotpDR();
    expect(frame).toBeInstanceOf(Buffer);
    expect(frame.length).toBeGreaterThan(0);
  });

  it('should parse a raw frame', () => {
    // Build a read request, then parse it back
    const frame = ctx.bridge.buildReadRequest(S7AreaDB, 1, 0, 10, S7WLByte);
    const parsed = ctx.bridge.parseFrame(frame);
    expect(parsed).toBeDefined();
    expect(parsed.cotpType).toBe(COTP_DT);
    expect(parsed.pdu).toBeDefined();
    expect(parsed.pdu?.functionCode).toBeDefined();
  });
});
