// @ts-check
// Integration tests for S7Server (snap7-compatible drop-in) with custom port support

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { S7Server } from '../../src/compat/s7server.js';
import { S7Client } from '../../src/compat/s7client.js';

/** @type {S7Server} */
let server;
/** @type {number} */
let serverPort;

describe('S7Server (snap7-compatible)', () => {
  beforeAll(async () => {
    server = new S7Server();

    // Register test areas
    const db1 = Buffer.alloc(100);
    db1[0] = 0xAB; db1[1] = 0xCD;
    db1.writeUInt16BE(0x1234, 2);

    const db2 = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) db2[i] = i & 0xFF;

    const mk = Buffer.alloc(64);
    mk.fill(0xFF);

    server.RegisterArea(S7Server.srvAreaDB, 1, db1);
    server.RegisterArea(S7Server.srvAreaDB, 2, db2);
    server.RegisterArea(S7Server.srvAreaMK, mk);

    // Use port 0 for random available port
    server.SetParam(S7Server.LocalPort, 0);

    await new Promise((resolve, reject) => {
      server.StartTo('127.0.0.1', (err) => {
        if (err) reject(new Error(`Server start failed: ${err}`));
        else resolve(undefined);
      });
    });

    serverPort = server.GetParam(S7Server.LocalPort);
  }, 10000);

  afterAll(async () => {
    await new Promise((resolve) => {
      server.Stop((err) => resolve(undefined));
    });
  });

  // ─── Server status ───

  it('should expose server area constants', () => {
    expect(S7Server.srvAreaDB).toBe(5);
    expect(S7Server.srvAreaMK).toBe(2);
    expect(S7Server.srvAreaPE).toBe(0);
    expect(S7Server.srvAreaPA).toBe(1);
    expect(S7Server.srvAreaCT).toBe(3);
    expect(S7Server.srvAreaTM).toBe(4);
  });

  it('should expose instance area constants', () => {
    expect(server.srvAreaDB).toBe(5);
    expect(server.srvAreaMK).toBe(2);
    expect(server.operationRead).toBe(0);
    expect(server.operationWrite).toBe(1);
  });

  it('should report running status', () => {
    expect(server.ServerStatus()).toBe(S7Server.SrvRunning);
  });

  it('should listen on a custom port', () => {
    expect(serverPort).toBeGreaterThan(0);
    expect(serverPort).not.toBe(102);
  });

  // ─── Area management ───

  it('should GetArea for registered DB', () => {
    const buf = server.GetArea(S7Server.srvAreaDB, 1);
    expect(buf[0]).toBe(0xAB);
    expect(buf[1]).toBe(0xCD);
  });

  it('should SetArea and read updated data', () => {
    const newBuf = Buffer.alloc(64);
    newBuf.fill(0xAA);
    server.SetArea(S7Server.srvAreaMK, newBuf);
    const result = server.GetArea(S7Server.srvAreaMK);
    expect(result[0]).toBe(0xAA);
    // Restore original
    const original = Buffer.alloc(64);
    original.fill(0xFF);
    server.SetArea(S7Server.srvAreaMK, original);
  });

  it('should UnregisterArea and return empty', () => {
    const tmpBuf = Buffer.alloc(32);
    tmpBuf.fill(0x55);
    server.RegisterArea(S7Server.srvAreaPE, tmpBuf);
    expect(server.GetArea(S7Server.srvAreaPE).length).toBe(32);
    server.UnregisterArea(S7Server.srvAreaPE);
    expect(server.GetArea(S7Server.srvAreaPE).length).toBe(0);
  });

  // ─── Client connecting to our S7Server ───

  it('should accept S7Client connection', async () => {
    const client = new S7Client();
    client.SetParam(S7Client.RemotePort, serverPort);
    client.SetConnectionParams('127.0.0.1', 0x0100, 0x0101);

    const err = await new Promise((resolve) => {
      client.Connect((e) => resolve(e));
    });
    expect(err).toBe(0);
    expect(client.Connected()).toBe(true);
    expect(server.ClientsCount()).toBeGreaterThanOrEqual(1);
    client.Disconnect();
  });

  it('should serve DBRead from S7Client', async () => {
    const client = new S7Client();
    client.SetParam(S7Client.RemotePort, serverPort);
    client.SetConnectionParams('127.0.0.1', 0x0100, 0x0101);
    await new Promise((resolve) => client.Connect(resolve));

    const data = await new Promise((resolve, reject) => {
      client.DBRead(1, 0, 4, (err, buf) => {
        if (err) reject(new Error(`DBRead err: ${err}`));
        else resolve(buf);
      });
    });

    expect(/** @type {Buffer} */ (data)[0]).toBe(0xAB);
    expect(/** @type {Buffer} */ (data)[1]).toBe(0xCD);
    expect(/** @type {Buffer} */ (data).readUInt16BE(2)).toBe(0x1234);
    client.Disconnect();
  });

  it('should serve DBWrite from S7Client', async () => {
    const client = new S7Client();
    client.SetParam(S7Client.RemotePort, serverPort);
    client.SetConnectionParams('127.0.0.1', 0x0100, 0x0101);
    await new Promise((resolve) => client.Connect(resolve));

    const writeBuf = Buffer.from([0xFE, 0xED]);
    await new Promise((resolve, reject) => {
      client.DBWrite(2, 10, 2, writeBuf, (err) => {
        if (err) reject(new Error(`DBWrite err: ${err}`));
        else resolve(undefined);
      });
    });

    // Verify via server area directly
    const db2 = server.GetArea(S7Server.srvAreaDB, 2);
    expect(db2[10]).toBe(0xFE);
    expect(db2[11]).toBe(0xED);
    client.Disconnect();
  });

  it('should serve MBRead from S7Client', async () => {
    const client = new S7Client();
    client.SetParam(S7Client.RemotePort, serverPort);
    client.SetConnectionParams('127.0.0.1', 0x0100, 0x0101);
    await new Promise((resolve) => client.Connect(resolve));

    const data = await new Promise((resolve, reject) => {
      client.MBRead(0, 2, (err, buf) => {
        if (err) reject(new Error(`MBRead err: ${err}`));
        else resolve(buf);
      });
    });

    expect(/** @type {Buffer} */ (data)[0]).toBe(0xFF);
    expect(/** @type {Buffer} */ (data)[1]).toBe(0xFF);
    client.Disconnect();
  });

  // ─── Events ───

  it('should emit events', async () => {
    /** @type {any[]} */
    const events = [];
    server.on('event', (evt) => events.push(evt));

    const client = new S7Client();
    client.SetParam(S7Client.RemotePort, serverPort);
    client.SetConnectionParams('127.0.0.1', 0x0100, 0x0101);
    await new Promise((resolve) => client.Connect(resolve));
    await new Promise((resolve) => client.DBRead(1, 0, 1, resolve));
    client.Disconnect();

    // Wait for socket close propagation
    await new Promise((r) => setTimeout(r, 200));

    server.removeAllListeners('event');

    expect(events.length).toBeGreaterThan(0);
    expect(events.some(e => e.EvtCode & S7Server.evcClientAdded)).toBe(true);
  });

  // ─── Event text and error text ───

  it('should produce EventText', () => {
    const evt = {
      EvtTime: new Date(),
      EvtSender: '127.0.0.1',
      EvtCode: S7Server.evcClientAdded,
      EvtRetCode: 0,
      EvtParam1: 0, EvtParam2: 0, EvtParam3: 0, EvtParam4: 0,
    };
    const text = server.EventText(evt);
    expect(text).toContain('Client added');
  });

  it('should return ErrorText', () => {
    expect(server.ErrorText(0)).toBe('OK');
  });

  // ─── Multiple servers on different ports ───

  it('should run two servers on different ports simultaneously', async () => {
    const server2 = new S7Server();
    const db = Buffer.alloc(10);
    db[0] = 0x42;
    server2.RegisterArea(S7Server.srvAreaDB, 1, db);
    server2.SetParam(S7Server.LocalPort, 0);

    await new Promise((resolve, reject) => {
      server2.StartTo('127.0.0.1', (err) => {
        if (err) reject(new Error(`Server2 start: ${err}`));
        else resolve(undefined);
      });
    });

    const port2 = server2.GetParam(S7Server.LocalPort);
    expect(port2).not.toBe(serverPort);
    expect(server2.ServerStatus()).toBe(S7Server.SrvRunning);

    // Connect a client to server2
    const client = new S7Client();
    client.SetParam(S7Client.RemotePort, port2);
    client.SetConnectionParams('127.0.0.1', 0x0100, 0x0101);
    await new Promise((resolve) => client.Connect(resolve));

    const data = await new Promise((resolve, reject) => {
      client.DBRead(1, 0, 1, (err, buf) => {
        if (err) reject(new Error(`err: ${err}`));
        else resolve(buf);
      });
    });

    expect(/** @type {Buffer} */ (data)[0]).toBe(0x42);
    client.Disconnect();

    await new Promise((resolve) => server2.Stop(resolve));
  });
});
