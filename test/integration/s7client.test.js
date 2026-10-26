// @ts-check
// Integration tests for S7Client (snap7-compatible drop-in)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:net';
import { startIntegrationDemoServer as startDemoServer } from '../helpers.js';
import { S7Client } from '../../src/compat/s7client.js';

/** @type {import('../demo-server.js').DemoServer} */
let demo;

function createClient() {
  const instance = new S7Client();
  instance.SetParam(S7Client.RemotePort, 11102);
  return instance;
}

describe('S7Client (snap7-compatible)', () => {
  beforeAll(async () => {
    demo = await startDemoServer({ silent: true, port: 11102 });
  }, 10000);

  afterAll(() => {
    demo?.stop();
  });

  // ─── Connection ───

  it('should expose snap7 static constants', () => {
    expect(S7Client.S7AreaDB).toBe(0x84);
    expect(S7Client.S7AreaMK).toBe(0x83);
    expect(S7Client.S7AreaPE).toBe(0x81);
    expect(S7Client.S7AreaPA).toBe(0x82);
    expect(S7Client.S7WLByte).toBe(0x02);
    expect(S7Client.S7WLWord).toBe(0x04);
    expect(S7Client.S7WLReal).toBe(0x08);
    expect(S7Client.CONNTYPE_PG).toBe(0x01);
    expect(S7Client.Block_DB).toBe(0x41);
  });

  it('should connect via ConnectTo with callback', async () => {
    const client = createClient();
    const err = await new Promise((resolve) => {
      client.ConnectTo('127.0.0.1', 0, 1, (e) => resolve(e));
    });
    expect(err).toBe(0);
    expect(client.Connected()).toBe(true);
    client.Disconnect();
  });

  it('should connect via SetConnectionParams + Connect', async () => {
    const client = createClient();
    const srcTsap = (0x01 << 8) | 0; // PG, rack=0, slot=0
    const dstTsap = (0x01 << 8) | 1; // PG, rack=0, slot=1
    client.SetConnectionParams('127.0.0.1', srcTsap, dstTsap);

    const err = await new Promise((resolve) => {
      client.Connect((e) => resolve(e));
    });
    expect(err).toBe(0);
    expect(client.Connected()).toBe(true);
    client.Disconnect();
  });

  it('should report disconnected after Disconnect', async () => {
    const client = createClient();
    await new Promise((resolve) => client.ConnectTo('127.0.0.1', 0, 1, resolve));
    client.Disconnect();
    expect(client.Connected()).toBe(false);
  });

  it('reports refusal through the callback without an error listener and can reconnect', async () => {
    const server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    await new Promise((resolve) => server.close(resolve));
    const client = createClient();
    client.SetParam(S7Client.RemotePort, address.port);
    let calls = 0;
    const err = await new Promise((resolve) => client.ConnectTo('127.0.0.1', 0, 1, (code) => {
      calls++;
      resolve(code);
    }));
    expect(err).not.toBe(0);
    expect(client.LastError()).not.toBe(0);
    expect(client.Connected()).toBe(false);
    expect(calls).toBe(1);
    client.SetParam(S7Client.RemotePort, 11102);
    try {
      const recovered = await new Promise((resolve) => client.ConnectTo('127.0.0.1', 0, 1, resolve));
      expect(recovered).toBe(0);
      expect(client.Connected()).toBe(true);
    } finally {
      client.Disconnect();
    }
  });

  it('does not resurrect a connection when disconnected during initialization', async () => {
    const client = createClient();
    const pending = new Promise((resolve) => client.ConnectTo('127.0.0.1', 0, 1, resolve));
    client.Disconnect();
    expect(await pending).not.toBe(0);
    expect(client.Connected()).toBe(false);
  });

  it('settles the callback when disconnected during a stalled handshake', async () => {
    /** @type {(() => void) | undefined} */
    let accepted;
    const connected = new Promise((resolve) => { accepted = () => resolve(undefined); });
    const server = createServer((socket) => {
      socket.on('data', () => {});
      accepted?.();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const client = createClient();
    client.SetParam(S7Client.RemotePort, address.port);
    const pending = new Promise((resolve) => client.ConnectTo('127.0.0.1', 0, 1, resolve));
    try {
      await connected;
      client.Disconnect();
      expect(await pending).not.toBe(0);
      expect(client.Connected()).toBe(false);
    } finally {
      client.Disconnect();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // ─── Parameters ───

  it('should set and get params', () => {
    const client = createClient();
    client.SetParam(S7Client.RecvTimeout, 5000);
    expect(client.GetParam(S7Client.RecvTimeout)).toBe(5000);
  });

  // ─── DB Read/Write ───

  it('should read DB1 via DBRead', async () => {
    const client = createClient();
    await new Promise((resolve) => client.ConnectTo('127.0.0.1', 0, 1, resolve));

    const data = await new Promise((resolve, reject) => {
      client.DBRead(1, 0, 2, (err, buf) => {
        if (err) reject(new Error(`DBRead err: ${err}`));
        else resolve(buf);
      });
    });

    expect(data).toBeInstanceOf(Buffer);
    expect(/** @type {Buffer} */ (data)[0]).toBe(0xAB);
    expect(/** @type {Buffer} */ (data)[1]).toBe(0xCD);
    client.Disconnect();
  });

  it('should read DB1 word via ReadArea', async () => {
    const client = createClient();
    await new Promise((resolve) => client.ConnectTo('127.0.0.1', 0, 1, resolve));

    const data = await new Promise((resolve, reject) => {
      client.ReadArea(S7Client.S7AreaDB, 1, 2, 1, S7Client.S7WLWord, (err, buf) => {
        if (err) reject(new Error(`ReadArea err: ${err}`));
        else resolve(buf);
      });
    });

    expect(/** @type {Buffer} */ (data).readUInt16BE(0)).toBe(0x1234);
    client.Disconnect();
  });

  it('should write and read back DB2', async () => {
    const client = createClient();
    await new Promise((resolve) => client.ConnectTo('127.0.0.1', 0, 1, resolve));

    const writeBuf = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]);
    await new Promise((resolve, reject) => {
      client.DBWrite(2, 0, 4, writeBuf, (err) => {
        if (err) reject(new Error(`DBWrite err: ${err}`));
        else resolve(undefined);
      });
    });

    const readBuf = await new Promise((resolve, reject) => {
      client.DBRead(2, 0, 4, (err, buf) => {
        if (err) reject(new Error(`DBRead err: ${err}`));
        else resolve(buf);
      });
    });

    expect(Buffer.compare(/** @type {Buffer} */ (readBuf), writeBuf)).toBe(0);
    client.Disconnect();
  });

  // ─── MK Read ───

  it('should read MK via MBRead', async () => {
    const client = createClient();
    await new Promise((resolve) => client.ConnectTo('127.0.0.1', 0, 1, resolve));

    const data = await new Promise((resolve, reject) => {
      client.MBRead(0, 4, (err, buf) => {
        if (err) reject(new Error(`MBRead err: ${err}`));
        else resolve(buf);
      });
    });

    expect(/** @type {Buffer} */ (data).length).toBe(4);
    // Demo server fills MK with 0xFF
    for (let i = 0; i < 4; i++) {
      expect(/** @type {Buffer} */ (data)[i]).toBe(0xFF);
    }
    client.Disconnect();
  });

  // ─── Multi Var ───

  it('should read multiple vars via ReadMultiVars', async () => {
    const client = createClient();
    await new Promise((resolve) => client.ConnectTo('127.0.0.1', 0, 1, resolve));

    /** @type {import('../../src/compat/s7client.js').MultiVarRead[]} */
    const items = [
      { Area: S7Client.S7AreaDB, WordLen: S7Client.S7WLByte, DBNumber: 1, Start: 0, Amount: 2 },
      { Area: S7Client.S7AreaDB, WordLen: S7Client.S7WLByte, DBNumber: 1, Start: 2, Amount: 2 },
    ];

    const results = await new Promise((resolve, reject) => {
      client.ReadMultiVars(items, (err, data) => {
        if (err) reject(new Error(`ReadMultiVars err: ${err}`));
        else resolve(data);
      });
    });

    expect(/** @type {any[]} */ (results)).toHaveLength(2);
    expect(/** @type {any[]} */ (results)[0].Result).toBe(0);
    expect(/** @type {any[]} */ (results)[0].Data[0]).toBe(0xAB);
    expect(/** @type {any[]} */ (results)[1].Result).toBe(0);
    expect(/** @type {any[]} */ (results)[1].Data.readUInt16BE(0)).toBe(0x1234);
    client.Disconnect();
  });

  // ─── Info functions ───

  it('should return PduLength and ExecTime after read', async () => {
    const client = createClient();
    await new Promise((resolve) => client.ConnectTo('127.0.0.1', 0, 1, resolve));

    await new Promise((resolve) => client.DBRead(1, 0, 1, resolve));

    expect(client.PduLength()).toBeGreaterThan(0);
    // ExecTime returns number or false (if 0ms)
    const execTime = client.ExecTime();
    expect(execTime === false || execTime >= 0).toBe(true);
    expect(client.LastError()).toBe(0);
    client.Disconnect();
  });

  it('should return ErrorText for known codes', () => {
    const client = createClient();
    expect(client.ErrorText(0)).toBe('OK');
    expect(client.ErrorText(0x0001)).toContain('TCP');
    expect(client.ErrorText(0x0007)).toContain('not connected');
  });

  it('should explicitly reject unimplemented GetCpuInfo', () => {
    const client = createClient();
    const info = client.GetCpuInfo();
    expect(info).toBe(false);
    expect(client.ErrorText(client.LastError())).toContain('not implemented');
  });

  it('should error on read when not connected', () => {
    const client = createClient();
    const result = client.DBRead(1, 0, 1);
    expect(result).toBe(false);
    expect(client.LastError()).toBe(0x0007);
  });
});
