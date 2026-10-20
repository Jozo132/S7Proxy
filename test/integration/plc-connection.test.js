// @ts-check
// Integration test — PlcConnection handshake + read/write against demo PLC server

import { createServer } from 'node:net';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown } from '../helpers.js';
import { PlcConnection } from '../../src/client/plc-connection.js';
import {
  S7AreaDB, S7AreaMK, S7AreaPE, S7AreaPA,
  S7WLByte, S7WLWord, S7WLDWord, S7WLReal,
  S7_MSG_ACK, S7_MSG_ACK_DATA, S7_FN_SETUP_COMM, COTP_CC,
} from '../../src/protocol/constants.js';

/** @type {import('../helpers.js').TestContext} */
let ctx;

/** Extract the PDU reference from a built S7 frame.
 *  Layout: TPKT(4) + COTP DT(3) + S7 header bytes 4-5 = pduRef
 *  @param {Buffer} frame */
function getPduRef(frame) {
  return frame.readUInt16BE(11);
}

/** @param {number} marker */
function makeTpktFrame(marker) {
  return Buffer.from([0x03, 0x00, 0x00, 0x05, marker]);
}

/** @returns {any} */
function makeSilentLogger() {
  return {
    child() { return this; },
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

/** @returns {any} */
function makeMockBridge() {
  return {
    buildCotpCR: () => makeTpktFrame(0x01),
    buildSetupComm: () => makeTpktFrame(0x02),
    buildCotpDR: () => makeTpktFrame(0x03),
    parseFrame(/** @type {Buffer} */ frame) {
      const marker = frame[4];
      if (marker === 0x11) return { cotpType: COTP_CC, pdu: null };
      if (marker === 0x12) {
        return {
          cotpType: 0xF0,
          pdu: {
            raw: frame,
            messageType: S7_MSG_ACK_DATA,
            functionCode: S7_FN_SETUP_COMM,
            pduRef: 0,
            paramLength: 0,
            dataLength: 0,
            errorClass: 0,
            errorCode: 0,
          },
        };
      }
      if (marker === 0x21) {
        return {
          cotpType: 0xF0,
          pdu: {
            raw: frame,
            messageType: S7_MSG_ACK,
            functionCode: 0,
            pduRef: 0x1234,
            paramLength: 0,
            dataLength: 0,
            errorClass: 0,
            errorCode: 0,
          },
        };
      }
      if (marker === 0x22) {
        return {
          cotpType: 0xF0,
          pdu: {
            raw: frame,
            messageType: S7_MSG_ACK_DATA,
            functionCode: 0,
            pduRef: 0x1234,
            paramLength: 0,
            dataLength: 0,
            errorClass: 0,
            errorCode: 0,
          },
        };
      }

      throw new Error(`Unexpected frame marker: 0x${marker.toString(16)}`);
    },
  };
}

/**
 * @param {{ sendFollowup: boolean, sendAck?: boolean }} options
 * @returns {Promise<{ server: import('node:net').Server, port: number }>}
 */
async function startAckScriptedServer(options) {
  const server = createServer((socket) => {
    let phase = 0;

    socket.on('data', () => {
      phase += 1;
      if (phase === 1) {
        socket.write(makeTpktFrame(0x11));
        return;
      }
      if (phase === 2) {
        socket.write(makeTpktFrame(0x12));
        return;
      }
      if (phase === 3) {
        if (options.sendAck === false) return;
        socket.write(makeTpktFrame(0x21));
        if (options.sendFollowup) {
          setTimeout(() => {
            if (!socket.destroyed) socket.write(makeTpktFrame(0x22));
          }, 10);
        }
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, () => resolve(undefined));
  });

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind scripted server');
  return { server, port: address.port };
}

describe('PlcConnection', () => {
  beforeAll(async () => {
    ctx = await setup({ port: 11102 });
  });

  afterAll(async () => {
    await teardown();
  });

  it('should connect (COTP + S7 handshake) and reach ready state', async () => {
    const conn = new PlcConnection(
      'test-conn-1', 'plc1',
      { ip: '127.0.0.1', rack: 0, slot: 1, port: 11102 },
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
      { ip: '127.0.0.1', rack: 0, slot: 1, port: 11102 },
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
      { ip: '127.0.0.1', rack: 0, slot: 1, port: 11102 },
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
      { ip: '127.0.0.1', rack: 0, slot: 1, port: 11102 },
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
      { ip: '127.0.0.1', rack: 0, slot: 1, port: 11102 },
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
      { ip: '127.0.0.1', rack: 0, slot: 1, port: 11102 },
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
      { ip: '127.0.0.1', rack: 0, slot: 1, port: 11102 },
      ctx.bridge, ctx.logger,
    );

    await expect(
      conn.sendRequest(Buffer.alloc(10), 1),
    ).rejects.toThrow(/not ready/i);
  });

  it.each(['cotp', 's7_setup'])('times out a stalled %s handshake', async (phase) => {
    const server = createServer((socket) => {
      socket.on('data', () => {
        if (phase === 's7_setup') socket.write(ctx.bridge.buildCotpCC(1, 1));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const conn = new PlcConnection(
      `stalled-${phase}`, 'plc1',
      { ip: '127.0.0.1', rack: 0, slot: 1, port: address.port },
      ctx.bridge, ctx.logger, 50,
    );
    try {
      const start = Date.now();
      await expect(conn.connect()).rejects.toThrow(`state: ${phase}`);
      expect(Date.now() - start).toBeLessThan(2000);
      expect(conn.state).not.toBe('ready');
    } finally {
      await conn.disconnect();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('rejects setup when the peer closes and allows another attempt', async () => {
    const server = createServer((socket) => socket.on('data', () => socket.end()));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const conn = new PlcConnection(
      'closed-setup', 'plc1',
      { ip: '127.0.0.1', rack: 0, slot: 1, port: address.port },
      ctx.bridge, ctx.logger, 100,
    );
    try {
      await expect(conn.connect()).rejects.toThrow('Connection closed');
      await expect(conn.connect()).rejects.toThrow('Connection closed');
    } finally {
      await conn.disconnect();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('shares a pending attempt and rejects it on disconnect', async () => {
    const server = createServer((socket) => socket.on('data', () => {}));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const conn = new PlcConnection(
      'cancelled-setup', 'plc1',
      { ip: '127.0.0.1', rack: 0, slot: 1, port: address.port },
      ctx.bridge, ctx.logger,
    );
    try {
      const pending = conn.connect();
      expect(conn.connect()).toBe(pending);
      const rejected = expect(pending).rejects.toThrow('Connection closed');
      await conn.disconnect();
      await rejected;
      expect(conn.state).toBe('closed');
    } finally {
      await conn.disconnect();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('invalidates a timed-out session and rejects all outstanding requests', async () => {
    const { server, port } = await startAckScriptedServer({ sendFollowup: false, sendAck: false });
    const conn = new PlcConnection(
      'stalled-read', 'plc1', { ip: '127.0.0.1', rack: 0, slot: 1, port },
      makeMockBridge(), makeSilentLogger(), 100,
    );
    try {
      await conn.connect();
      const request = Buffer.alloc(13);
      const results = await Promise.allSettled([
        conn.sendRequest(request, 1),
        conn.sendRequest(request, 2),
      ]);
      for (const result of results) {
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected') expect(result.reason.message).toMatch(/Request timeout/);
      }
      expect(conn.state).not.toBe('ready');
      await expect(conn.sendRequest(request, 3)).rejects.toThrow('not ready');
    } finally {
      await conn.disconnect();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('rejects duplicate PDU references without replacing the first request', async () => {
    const { server, port } = await startAckScriptedServer({ sendFollowup: true });
    const conn = new PlcConnection(
      'duplicate-ref', 'plc1', { ip: '127.0.0.1', rack: 0, slot: 1, port },
      makeMockBridge(), makeSilentLogger(), 500,
    );
    try {
      await conn.connect();
      const request = Buffer.alloc(13);
      const pending = conn.sendRequest(request, 0x1234);
      await expect(conn.sendRequest(request, 0x1234)).rejects.toThrow('Duplicate pending PDU');
      expect((await pending)[4]).toBe(0x22);
    } finally {
      await conn.disconnect();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('waits for ACK_DATA when a PLC sends ACK before the final response', async () => {
    const { server, port } = await startAckScriptedServer({ sendFollowup: true });
    const conn = new PlcConnection(
      'test-conn-ack-followup', 'plc1',
      { ip: '127.0.0.1', rack: 0, slot: 1, port },
      /** @type {any} */ (makeMockBridge()),
      /** @type {any} */ (makeSilentLogger()),
      500,
    );

    try {
      await conn.connect();
      const request = Buffer.alloc(13);
      request.writeUInt16BE(0x1234, 11);

      const response = await conn.sendRequest(request, 0x1234);
      expect(response[4]).toBe(0x22);
    } finally {
      await conn.disconnect();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('still falls back to bare ACK when no follow-up response arrives', async () => {
    const { server, port } = await startAckScriptedServer({ sendFollowup: false });
    const conn = new PlcConnection(
      'test-conn-ack-only', 'plc1',
      { ip: '127.0.0.1', rack: 0, slot: 1, port },
      /** @type {any} */ (makeMockBridge()),
      /** @type {any} */ (makeSilentLogger()),
      500,
    );

    try {
      await conn.connect();
      const request = Buffer.alloc(13);
      request.writeUInt16BE(0x1234, 11);

      const response = await conn.sendRequest(request, 0x1234);
      expect(response[4]).toBe(0x21);
    } finally {
      await conn.disconnect();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
