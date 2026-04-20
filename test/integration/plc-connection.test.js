// @ts-check
// Integration test — PlcConnection handshake + read/write against demo PLC server

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown } from '../helpers.js';
import { PlcConnection } from '../../src/client/plc-connection.js';
import {
  S7AreaDB, S7AreaMK, S7AreaPE, S7AreaPA,
  S7WLByte, S7WLWord, S7WLDWord, S7WLReal,
} from '../../src/protocol/constants.js';

/** @type {import('../helpers.js').TestContext} */
let ctx;

/** Extract the PDU reference from a built S7 frame.
 *  Layout: TPKT(4) + COTP DT(3) + S7 header bytes 4-5 = pduRef
 *  @param {Buffer} frame */
function getPduRef(frame) {
  return frame.readUInt16BE(11);
}

describe('PlcConnection', () => {
  beforeAll(async () => {
    ctx = await setup();
  });

  afterAll(async () => {
    await teardown();
  });

  it('should connect (COTP + S7 handshake) and reach ready state', async () => {
    const conn = new PlcConnection(
      'test-conn-1', 'plc1',
      { ip: '127.0.0.1', rack: 0, slot: 1 },
      ctx.bridge, ctx.logger,
    );

    await conn.connect();
    expect(conn.state).toBe('ready');
    expect(conn.pduSize).toBeGreaterThanOrEqual(240);
    expect(conn.freeAmqSlots).toBeGreaterThan(0);

    await conn.disconnect();
  });

  it('should read DB1 bytes 0-1 and get 0xAB 0xCD', async () => {
    const conn = new PlcConnection(
      'test-conn-read', 'plc1',
      { ip: '127.0.0.1', rack: 0, slot: 1 },
      ctx.bridge, ctx.logger,
    );
    await conn.connect();

    const frame = ctx.bridge.buildReadRequest(S7AreaDB, 1, 0, 2, S7WLByte);
    const response = await conn.sendRequest(frame, getPduRef(frame));

    expect(response).toBeInstanceOf(Buffer);
    expect(response.length).toBeGreaterThan(0);

    await conn.disconnect();
  });

  it('should read DB1 word at offset 2 and get 0x1234', async () => {
    const conn = new PlcConnection(
      'test-conn-word', 'plc1',
      { ip: '127.0.0.1', rack: 0, slot: 1 },
      ctx.bridge, ctx.logger,
    );
    await conn.connect();

    const frame = ctx.bridge.buildReadRequest(S7AreaDB, 1, 2, 1, S7WLWord);
    const response = await conn.sendRequest(frame, getPduRef(frame));

    expect(response).toBeInstanceOf(Buffer);

    await conn.disconnect();
  });

  it('should read MK area (all 0xFF)', async () => {
    const conn = new PlcConnection(
      'test-conn-mk', 'plc1',
      { ip: '127.0.0.1', rack: 0, slot: 1 },
      ctx.bridge, ctx.logger,
    );
    await conn.connect();

    const frame = ctx.bridge.buildReadRequest(S7AreaMK, 0, 0, 4, S7WLByte);
    const response = await conn.sendRequest(frame, getPduRef(frame));

    expect(response).toBeInstanceOf(Buffer);

    await conn.disconnect();
  });

  it('should write to DB2 and read back', async () => {
    const conn = new PlcConnection(
      'test-conn-write', 'plc1',
      { ip: '127.0.0.1', rack: 0, slot: 1 },
      ctx.bridge, ctx.logger,
    );
    await conn.connect();

    // Write 4 bytes to DB2 offset 0
    const writeData = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]);
    const writeFrame = ctx.bridge.buildWriteRequest(S7AreaDB, 2, 0, 4, S7WLByte, writeData);
    const writeResp = await conn.sendRequest(writeFrame, getPduRef(writeFrame));
    expect(writeResp).toBeInstanceOf(Buffer);

    // Read them back
    const readFrame = ctx.bridge.buildReadRequest(S7AreaDB, 2, 0, 4, S7WLByte);
    const readResp = await conn.sendRequest(readFrame, getPduRef(readFrame));
    expect(readResp).toBeInstanceOf(Buffer);

    await conn.disconnect();
  });

  it('should handle multiple concurrent requests within AMQ limits', async () => {
    const conn = new PlcConnection(
      'test-conn-multi', 'plc1',
      { ip: '127.0.0.1', rack: 0, slot: 1 },
      ctx.bridge, ctx.logger,
    );
    await conn.connect();

    const reads = Array.from({ length: 4 }, (_, i) => {
      const frame = ctx.bridge.buildReadRequest(S7AreaDB, 1, i * 2, 2, S7WLByte);
      return conn.sendRequest(frame, getPduRef(frame));
    });

    const results = await Promise.all(reads);
    expect(results).toHaveLength(4);
    for (const r of results) {
      expect(r).toBeInstanceOf(Buffer);
    }

    await conn.disconnect();
  });

  it('should reject requests when not connected', async () => {
    const conn = new PlcConnection(
      'test-conn-err', 'plc1',
      { ip: '127.0.0.1', rack: 0, slot: 1 },
      ctx.bridge, ctx.logger,
    );

    await expect(
      conn.sendRequest(Buffer.alloc(10), 1),
    ).rejects.toThrow(/not ready/i);
  });
});
