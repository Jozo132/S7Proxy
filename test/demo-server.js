// @ts-check
// Demo PLC server powered by node-snap7
// Registers DB1 (100 bytes), DB2 (256 bytes), MK (64 bytes), PE (32 bytes), PA (32 bytes)
// with pre-filled test patterns so integration tests can read known values.

import { S7Server } from '../src/compat/s7server.js';

const DEFAULT_IP = '127.0.0.1';

/**
 * @typedef {Object} DemoServerOptions
 * @property {string}  [ip='127.0.0.1']
 * @property {boolean} [silent=false]
 * @property {number} [port=102]
 * @property {'native'|'compat'} [backend='native']
 */

/**
 * @typedef {Object} DemoServer
 * @property {*} server
 * @property {{ db1: Buffer, db2: Buffer, mk: Buffer, pe: Buffer, pa: Buffer }} areas
 * @property {() => void} stop
 */

/**
 * Fill DB1 with a recognisable test pattern:
 *   Byte  0     : 0xAB
 *   Byte  1     : 0xCD
 *   Word  2-3   : 0x1234  (big-endian)
 *   DInt  4-7   : 42      (big-endian signed 32-bit)
 *   Real  8-11  : 3.14    (big-endian IEEE 754)
 *   Bytes 12-19 : ASCII "S7Proxy!"
 *   Bytes 20-99 : sequential 0x00..0x4F
 * @param {Buffer} buf
 */
function fillDb1(buf) {
  buf.fill(0);
  buf[0] = 0xAB;
  buf[1] = 0xCD;
  buf.writeUInt16BE(0x1234, 2);
  buf.writeInt32BE(42, 4);
  buf.writeFloatBE(3.14, 8);
  buf.write('S7Proxy!', 12, 'ascii');
  for (let i = 20; i < buf.length; i++) {
    buf[i] = (i - 20) & 0xFF;
  }
}

/**
 * Fill DB2 with a ramp (byte index = byte value mod 256).
 * @param {Buffer} buf
 */
function fillDb2(buf) {
  for (let i = 0; i < buf.length; i++) {
    buf[i] = i & 0xFF;
  }
}

/**
 * Start the demo PLC server.
 * @param {DemoServerOptions} [opts]
 * @returns {Promise<DemoServer>}
 */
export async function startDemoServer(opts = {}) {
  const ip = opts.ip ?? DEFAULT_IP;
  const silent = opts.silent ?? false;
  const port = opts.port ?? 102;

  const backend = opts.backend ?? 'native';
  if (!['native', 'compat'].includes(backend)) throw new Error('Unknown demo server backend');
  const Server = backend === 'compat' ? S7Server : (await import('node-snap7')).default.S7Server;
  const server = new Server();
  if (!server.SetParam(1, port)) throw new Error('Failed to set demo server port');

  // Memory areas
  const db1 = Buffer.alloc(100);
  const db2 = Buffer.alloc(256);
  const mk  = Buffer.alloc(64);
  const pe  = Buffer.alloc(32);
  const pa  = Buffer.alloc(32);

  fillDb1(db1);
  fillDb2(db2);
  mk.fill(0xFF);       // all merkers ON
  pe.fill(0x55);       // alternating bits
  pa.fill(0x00);       // outputs zeroed

  // Register areas
  server.RegisterArea(server.srvAreaDB, 1, db1);
  server.RegisterArea(server.srvAreaDB, 2, db2);
  server.RegisterArea(server.srvAreaMK, mk);
  server.RegisterArea(server.srvAreaPE, pe);
  server.RegisterArea(server.srvAreaPA, pa);

  if (!silent) {
    server.on('event', (/** @type {any} */ event) => {
      console.log('[snap7-server]', server.EventText(event));
    });
  }

  return new Promise((resolve, reject) => {
    server.StartTo(ip, (/** @type {any} */ err) => {
      if (err) {
        reject(new Error(`snap7 StartTo failed: ${err} – ${server.ErrorText(err)}`));
        return;
      }

      if (!silent) {
        console.log(`[snap7-server] Listening on ${ip}:${port}`);
      }

      resolve({
        server,
        areas: { db1, db2, mk, pe, pa },
        stop() {
          server.Stop();
          server.UnregisterArea(server.srvAreaDB, 1);
          server.UnregisterArea(server.srvAreaDB, 2);
          server.UnregisterArea(server.srvAreaMK);
          server.UnregisterArea(server.srvAreaPE);
          server.UnregisterArea(server.srvAreaPA);
          if (!silent) console.log('[snap7-server] Stopped');
        },
      });
    });
  });
}

// Allow running standalone: node test/demo-server.js
const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('test/demo-server.js');
if (isMain) {
  const srv = await startDemoServer();
  process.on('SIGINT', () => { srv.stop(); process.exit(0); });
  process.on('SIGTERM', () => { srv.stop(); process.exit(0); });
}
