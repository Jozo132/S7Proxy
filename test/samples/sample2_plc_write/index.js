// @ts-check
// -----------------------------------------------------------------------------
// Sample 2 - Write and verify DB1.INT0 on an explicitly supplied S7-1200 PLC
//
// Demonstrates five approaches, executed 5 seconds apart:
//   1. node-snap7 native client
//   2. S7Proxy compatibility layer  (S7Client)
//   3. S7Proxy native mode          (PlcConnection + WasmBridge)
//   4. S7Proxy child process + Admin HTTP      (admin REST write/read)
//   5. S7Proxy child process + Admin WebSocket (admin WS write/read)
//
// Each approach:
//   - reads the current INT value
//   - writes a changed value
//   - reads it back and verifies the change
//   - restores the original value and verifies the restore
//
// This is intentionally verbose and debug-oriented so it can be used to isolate
// whether write failures happen in the PLC, protocol layer, or admin path.
// -----------------------------------------------------------------------------

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { isIP } from 'node:net';
import { S7Client } from '../../../src/compat/s7client.js';
import { PlcConnection } from '../../../src/client/plc-connection.js';
import { WasmBridge } from '../../../src/wasm/bridge.js';
import { loadWasmEngine } from '../../../src/wasm/loader.js';
import { createWasmImports } from '../../../src/wasm/imports.js';
import { createLogger } from '../../../src/logging/logger.js';
import {
  S7AreaDB,
  S7WLWord,
  S7_MSG_ACK,
  S7_MSG_ACK_DATA,
  S7_MSG_USERDATA,
} from '../../../src/protocol/constants.js';

// ---- PLC parameters ---------------------------------------------------------
const PLC_IP = process.argv[2];
if (!PLC_IP || !isIP(PLC_IP)) throw new Error('Usage: node test/samples/sample2_plc_write/index.js <plc-ip>');
const snap7 = (await import('node-snap7')).default;
const PLC_RACK = 0;
const PLC_SLOT = 1;

const DB_NUMBER = 1;
const BYTE_OFFSET = 0;
const READ_BYTES = 2;
const WORD_AMOUNT = 1;

const DELAY_MS = 5000;

// S7Proxy web/admin API settings
const WEB_PORT = 18081;
const BASE_URL = `http://localhost:${WEB_PORT}`;
const ADMIN_API_BASE = `${BASE_URL}/admin/api`;
const ADMIN_WS_URL = `ws://localhost:${WEB_PORT}/admin/ws`;
const ADMIN_PASSWORD = '1234';

const STRUCT_NAME = 'WriteProbe';
const STRUCT_FIELD = 'value';

const TPKT_COTP_HEADER_SIZE = 7;

// ---- Helpers ----------------------------------------------------------------

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {number} value */
function encodeInt(value) {
  const buf = Buffer.alloc(READ_BYTES);
  buf.writeInt16BE(value, 0);
  return buf;
}

/** @param {Buffer} buf */
function decodeInt(buf) {
  return buf.readInt16BE(0);
}

/** @param {number} value */
function chooseWriteValue(value) {
  if (value >= 32767) return value - 1;
  if (value <= -32768) return value + 1;
  return value + 1;
}

/** @param {string} label @param {number} value */
function printValue(label, value) {
  console.log(`  ${label}: DB${DB_NUMBER}.INT${BYTE_OFFSET} = ${value}  (raw: ${encodeInt(value).toString('hex')})`);
}

/** @param {Buffer} buffer */
function hex(buffer) {
  return buffer.toString('hex');
}

/** @param {number} messageType */
function getS7HeaderSize(messageType) {
  return messageType === S7_MSG_ACK_DATA || messageType === S7_MSG_USERDATA ? 12 : 10;
}

/**
 * @param {WasmBridge} bridge
 * @param {Buffer} frame
 */
function parseS7Frame(bridge, frame) {
  const parsed = bridge.parseFrame(frame);
  if (!parsed.pdu) throw new Error(`Expected S7 PDU, got COTP type 0x${parsed.cotpType.toString(16)}`);
  const dataItemOffset = TPKT_COTP_HEADER_SIZE + getS7HeaderSize(parsed.pdu.messageType) + parsed.pdu.paramLength;
  return { pdu: parsed.pdu, dataItemOffset };
}

/**
 * @param {string} label
 * @param {{ messageType: number, functionCode: number, pduRef: number, paramLength: number, dataLength: number, errorClass: number, errorCode: number }} pdu
 */
function logPdu(label, pdu) {
  console.log(
    `  [debug] ${label}: msgType=0x${pdu.messageType.toString(16)} fn=0x${pdu.functionCode.toString(16)} pduRef=0x${pdu.pduRef.toString(16)} paramLen=${pdu.paramLength} dataLen=${pdu.dataLength} err=${pdu.errorClass}/${pdu.errorCode}`,
  );
}

/**
 * @param {Buffer} response
 * @param {WasmBridge} bridge
 */
function extractNativeReadValue(response, bridge) {
  const { pdu, dataItemOffset } = parseS7Frame(bridge, response);
  logPdu('native read response PDU', pdu);

  if (pdu.messageType !== S7_MSG_ACK_DATA) {
    throw new Error(`Unexpected native read message type: 0x${pdu.messageType.toString(16)}`);
  }

  const returnCode = response[dataItemOffset];
  if (returnCode !== 0xFF) {
    throw new Error(`Native read failed with return code 0x${(returnCode ?? 0).toString(16)}`);
  }

  const bitLength = response.readUInt16BE(dataItemOffset + 2);
  const byteLength = Math.ceil(bitLength / 8);
  const data = response.subarray(dataItemOffset + 4, dataItemOffset + 4 + byteLength);
  return decodeInt(data);
}

/**
 * @param {Buffer} response
 * @param {WasmBridge} bridge
 */
function logNativeWriteStatus(response, bridge) {
  const { pdu, dataItemOffset } = parseS7Frame(bridge, response);
  logPdu('native write response PDU', pdu);

  if (pdu.messageType === S7_MSG_ACK) {
    console.log('  [debug] native write response is bare ACK');
    return;
  }

  const returnCode = response[dataItemOffset];
  console.log(`  [debug] native write return code: 0x${(returnCode ?? 0).toString(16)}`);
  if (returnCode !== 0xFF) {
    throw new Error(`Native write failed with return code 0x${(returnCode ?? 0).toString(16)}`);
  }
}

/**
 * @param {string} label
 * @param {() => Promise<number>} readValue
 * @param {(value: number) => Promise<void>} writeValue
 */
async function runWriteCycle(label, readValue, writeValue) {
  console.log(`\n=== ${label} ===`);
  const before = await readValue();
  printValue('Before', before);

  const nextValue = chooseWriteValue(before);
  printValue('Writing', nextValue);
  await writeValue(nextValue);

  const after = await readValue();
  printValue('After', after);
  if (after !== nextValue) {
    throw new Error(`Write verification failed: expected ${nextValue}, got ${after}`);
  }
  console.log('  Verification OK');

  printValue('Restoring', before);
  await writeValue(before);

  const restored = await readValue();
  printValue('Restored', restored);
  if (restored !== before) {
    throw new Error(`Restore verification failed: expected ${before}, got ${restored}`);
  }
  console.log('  Restore OK');
}

// ---- 1. node-snap7 ---------------------------------------------------------

async function writeWithSnap7() {
  /** @type {*} */
  const client = new snap7.S7Client();

  await new Promise((resolve, reject) => {
    client.ConnectTo(PLC_IP, PLC_RACK, PLC_SLOT, (/** @type {number} */ err) => {
      if (err) return reject(new Error(`snap7 ConnectTo failed: ${err}`));
      resolve(undefined);
    });
  });
  console.log('  Connected via snap7');

  try {
    await runWriteCycle(
      '1/5  node-snap7 (native write/read-back)',
      async () => {
        const buf = await new Promise((resolve, reject) => {
          client.DBRead(DB_NUMBER, BYTE_OFFSET, READ_BYTES, (/** @type {number} */ err, /** @type {Buffer} */ data) => {
            if (err) return reject(new Error(`snap7 DBRead failed: ${err}`));
            resolve(data);
          });
        });
        return decodeInt(/** @type {Buffer} */ (buf));
      },
      async (value) => {
        const payload = encodeInt(value);
        console.log(`  [debug] snap7 write payload: ${hex(payload)}`);
        await new Promise((resolve, reject) => {
          client.DBWrite(DB_NUMBER, BYTE_OFFSET, READ_BYTES, payload, (/** @type {number} */ err) => {
            if (err) return reject(new Error(`snap7 DBWrite failed: ${err}`));
            resolve(undefined);
          });
        });
      },
    );
  } finally {
    client.Disconnect();
    console.log('  Disconnected');
  }
}

// ---- 2. S7Proxy compatibility layer ---------------------------------------

async function writeWithCompat() {
  const client = new S7Client();

  const connectErr = await new Promise((resolve) => {
    client.ConnectTo(PLC_IP, PLC_RACK, PLC_SLOT, (/** @type {number} */ err) => resolve(err));
  });
  if (connectErr !== 0) {
    throw new Error(`S7Client ConnectTo failed: ${client.ErrorText(/** @type {number} */ (connectErr))}`);
  }
  console.log(`  Connected via S7Client  (PDU ${client.PduLength()})`);

  try {
    await runWriteCycle(
      '2/5  S7Proxy compat (S7Client write/read-back)',
      async () => {
        const buf = await new Promise((resolve, reject) => {
          client.DBRead(DB_NUMBER, BYTE_OFFSET, READ_BYTES, (/** @type {number} */ err, data) => {
            if (err) return reject(new Error(`S7Client DBRead failed: ${client.ErrorText(err)}`));
            if (!data) return reject(new Error('S7Client DBRead returned no data'));
            resolve(data);
          });
        });
        console.log(`  [debug] compat read execTime=${client.ExecTime()}ms`);
        return decodeInt(/** @type {Buffer} */ (buf));
      },
      async (value) => {
        const payload = encodeInt(value);
        console.log(`  [debug] compat write payload: ${hex(payload)}`);
        await new Promise((resolve, reject) => {
          client.DBWrite(DB_NUMBER, BYTE_OFFSET, READ_BYTES, payload, (/** @type {number} */ err) => {
            if (err) return reject(new Error(`S7Client DBWrite failed: ${client.ErrorText(err)}`));
            resolve(undefined);
          });
        });
        console.log(`  [debug] compat write execTime=${client.ExecTime()}ms lastError=${client.LastError()}`);
      },
    );
  } finally {
    client.Disconnect();
    console.log('  Disconnected');
  }
}

// ---- 3. S7Proxy native mode -----------------------------------------------

async function writeWithNative() {
  const logger = createLogger({ level: 'silent' });
  const imports = createWasmImports(logger);
  const engine = await loadWasmEngine(imports);
  const bridge = new WasmBridge(engine);

  const conn = new PlcConnection(
    'sample2-native', 'plc1',
    { ip: PLC_IP, rack: PLC_RACK, slot: PLC_SLOT },
    bridge, logger,
  );

  await conn.connect();
  console.log('  Connected via PlcConnection');

  try {
    await runWriteCycle(
      '3/5  S7Proxy native (PlcConnection + WasmBridge)',
      async () => {
        const frame = bridge.buildReadRequest(S7AreaDB, DB_NUMBER, BYTE_OFFSET, WORD_AMOUNT, S7WLWord);
        console.log(`  [debug] native read request: ${hex(frame)}`);
        const pduRef = frame.readUInt16BE(11);
        const response = await conn.sendRequest(frame, pduRef);
        console.log(`  [debug] native read response: ${hex(response)}`);
        return extractNativeReadValue(response, bridge);
      },
      async (value) => {
        const payload = encodeInt(value);
        const frame = bridge.buildWriteRequest(S7AreaDB, DB_NUMBER, BYTE_OFFSET, WORD_AMOUNT, S7WLWord, payload);
        console.log(`  [debug] native write payload: ${hex(payload)}`);
        console.log(`  [debug] native write request: ${hex(frame)}`);
        const pduRef = frame.readUInt16BE(11);
        const response = await conn.sendRequest(frame, pduRef);
        console.log(`  [debug] native write response: ${hex(response)}`);
        logNativeWriteStatus(response, bridge);
      },
    );
  } finally {
    await conn.disconnect();
    console.log('  Disconnected');
  }
}

// ---- 4/5. S7Proxy child-process helpers -----------------------------------

/**
 * @typedef {Object} ProxyRuntime
 * @property {import('node:child_process').ChildProcess} child
 * @property {string} tmpDir
 * @property {string} dbPath
 * @property {string | undefined} token
 */

/** @type {Promise<typeof import('node:fs')> | null} */
let fsPromise = null;

async function getFs() {
  if (!fsPromise) fsPromise = import('node:fs');
  return fsPromise;
}

/** @returns {Promise<ProxyRuntime>} */
async function startS7Proxy() {
  const fs = await getFs();
  const os = await import('node:os');
  const path = await import('node:path');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 's7proxy-sample2-'));
  const cfgPath = path.join(tmpDir, 'config.json');
  const dbPath = path.join(tmpDir, 'sample2.db');

  const config = {
    listen: { ip: '0.0.0.0', port: 10103 },
    targets: [{
      id: 'plc1',
      primary: { ip: PLC_IP, rack: PLC_RACK, slot: PLC_SLOT },
      maxConnections: 2,
      requestTimeoutMs: 3000,
    }],
    webApi: { enabled: true, host: '0.0.0.0', port: WEB_PORT, cors: { origin: '*' } },
    daq: { minScanIntervalMs: 20, cacheEnabled: true, cacheTtlMs: 5000 },
    logging: { level: 'debug', pretty: true },
    metrics: { enabled: false },
  };
  fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf-8');

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const projectRoot = resolve(__dirname, '..', '..', '..');
  const entryPoint = resolve(projectRoot, 'src', 'index.js');

  console.log('  Spawning S7Proxy child process ...');
  const child = fork(entryPoint, [cfgPath], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    cwd: projectRoot,
    env: {
      ...process.env,
      S7PROXY_DB_PATH: dbPath,
    },
  });

  child.stdout?.on('data', (/** @type {Buffer} */ data) => {
    const line = data.toString().trim();
    if (line) console.log(`  [proxy stdout] ${line}`);
  });

  child.stderr?.on('data', (/** @type {Buffer} */ data) => {
    const line = data.toString().trim();
    if (line) console.error(`  [proxy stderr] ${line}`);
  });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) {
        console.log('  S7Proxy is ready');
        return { child, tmpDir, dbPath, token: undefined };
      }
    } catch {
      // wait for startup
    }
    await sleep(300);
  }

  child.kill();
  throw new Error('S7Proxy did not become ready within 15 s');
}

/** @param {ProxyRuntime} runtime */
async function stopS7Proxy(runtime) {
  const fs = await getFs();

  if (runtime.child.exitCode === null) {
    runtime.child.kill('SIGTERM');
    await new Promise((resolve) => runtime.child.once('exit', resolve));
  }

  fs.rmSync(runtime.tmpDir, { recursive: true, force: true });
  console.log('  S7Proxy child process stopped');
}

/** @param {ProxyRuntime} runtime @returns {Promise<string>} */
async function loginAdmin(runtime) {
  if (runtime.token) return runtime.token;

  const res = await fetch(`${ADMIN_API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  const body = /** @type {any} */ (await res.json());
  const token = String(body.token ?? '');
  if (!res.ok || !token) throw new Error(`Admin login failed: ${JSON.stringify(body)}`);

  runtime.token = token;
  return runtime.token;
}

/** @param {ProxyRuntime} runtime */
async function ensureWriteStruct(runtime) {
  const token = await loginAdmin(runtime);
  const payload = {
    name: STRUCT_NAME,
    targetId: 'plc1',
    db: DB_NUMBER,
    offset: BYTE_OFFSET,
    subscribeMode: 'none',
    items: [{ name: STRUCT_FIELD, type: 'INT' }],
  };

  const res = await fetch(`${ADMIN_API_BASE}/structs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  const body = /** @type {any} */ (await res.json());
  if (!res.ok) throw new Error(`Admin struct create failed: ${JSON.stringify(body)}`);
  console.log(`  [debug] admin struct ensured: ${JSON.stringify(body)}`);
}

/**
 * @param {ProxyRuntime} runtime
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function adminFetch(runtime, path, init) {
  const token = await loginAdmin(runtime);
  const res = await fetch(`${ADMIN_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  const body = /** @type {any} */ (await res.json());
  return { res, body };
}

/** @param {ProxyRuntime} runtime */
async function readWithAdminRest(runtime) {
  await ensureWriteStruct(runtime);

  await runWriteCycle(
    '4/5  S7Proxy child process + Admin HTTP',
    async () => {
      console.log(`  [debug] POST ${ADMIN_API_BASE}/structs/${STRUCT_NAME}/read`);
      const { res, body } = await adminFetch(runtime, `/structs/${encodeURIComponent(STRUCT_NAME)}/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: [STRUCT_FIELD] }),
      });
      console.log(`  [debug] admin read response: ${JSON.stringify(body)}`);
      if (!res.ok) throw new Error(`Admin read failed: ${JSON.stringify(body)}`);
      return Number(body.values?.[STRUCT_FIELD]);
    },
    async (value) => {
      const payload = { values: { [STRUCT_FIELD]: value } };
      console.log(`  [debug] POST ${ADMIN_API_BASE}/structs/${STRUCT_NAME}/write ${JSON.stringify(payload)}`);
      const { res, body } = await adminFetch(runtime, `/structs/${encodeURIComponent(STRUCT_NAME)}/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      console.log(`  [debug] admin write response: ${JSON.stringify(body)}`);
      if (!res.ok) throw new Error(`Admin write failed: ${JSON.stringify(body)}`);
    },
  );
}

/**
 * @typedef {Object} AdminWsClient
 * @property {WebSocket} ws
 * @property {(payload: any, predicate: (msg: any) => boolean, timeoutMs?: number) => Promise<any>} request
 * @property {() => Promise<void>} close
 */

/** @param {ProxyRuntime} runtime @returns {Promise<AdminWsClient>} */
async function connectAdminWs(runtime) {
  const token = await loginAdmin(runtime);
  const ws = new WebSocket(`${ADMIN_WS_URL}?token=${encodeURIComponent(token)}`);

  /** @type {any[]} */
  const queue = [];
  /** @type {{ predicate: (msg: any) => boolean, resolve: (value: any) => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout> } | null} */
  let waiter = null;

  function settleFromQueue() {
    if (!waiter) return;
    const matchIndex = queue.findIndex(waiter.predicate);
    if (matchIndex === -1) return;
    const [msg] = queue.splice(matchIndex, 1);
    clearTimeout(waiter.timer);
    const resolve = waiter.resolve;
    waiter = null;
    resolve(msg);
  }

  ws.on('message', (/** @type {Buffer} */ raw) => {
    const msg = JSON.parse(raw.toString());
    console.log(`  [debug] admin-ws <= ${JSON.stringify(msg)}`);

    if (msg.type === 'error') {
      const err = new Error(msg.error || 'Unknown admin WS error');
      if (waiter) {
        clearTimeout(waiter.timer);
        const reject = waiter.reject;
        waiter = null;
        reject(err);
        return;
      }
      queue.push({ type: 'error', error: err.message });
      return;
    }

    queue.push(msg);
    settleFromQueue();
  });

  await new Promise((resolve, reject) => {
    ws.once('open', () => resolve(undefined));
    ws.once('error', reject);
  });

  return {
    ws,
    request(payload, predicate, timeoutMs = 5000) {
      console.log(`  [debug] admin-ws => ${JSON.stringify(payload)}`);
      return new Promise((resolve, reject) => {
        waiter = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiter = null;
            reject(new Error(`Timed out waiting for admin WS response to ${payload.type}`));
          }, timeoutMs),
        };
        settleFromQueue();
        ws.send(JSON.stringify(payload));
      });
    },
    close() {
      return new Promise((resolve) => {
        ws.once('close', () => resolve());
        ws.close();
      });
    },
  };
}

/** @param {ProxyRuntime} runtime */
async function writeWithAdminWs(runtime) {
  await ensureWriteStruct(runtime);
  const adminWs = await connectAdminWs(runtime);
  console.log('  Admin WebSocket connected');

  try {
    await runWriteCycle(
      '5/5  S7Proxy child process + Admin WebSocket',
      async () => {
        const msg = await adminWs.request(
          { type: 'read-struct', name: STRUCT_NAME, keys: [STRUCT_FIELD] },
          (candidate) => candidate.type === 'struct-data' && candidate.struct === STRUCT_NAME,
        );
        return Number(msg.values?.[STRUCT_FIELD]);
      },
      async (value) => {
        await adminWs.request(
          { type: 'write-struct', name: STRUCT_NAME, values: { [STRUCT_FIELD]: value } },
          (candidate) => candidate.type === 'write-ok' && candidate.struct === STRUCT_NAME,
        );
      },
    );
  } finally {
    await adminWs.close();
    console.log('  Admin WebSocket closed');
  }
}

// ---- Main ------------------------------------------------------------------

async function main() {
  console.log(`Target PLC: ${PLC_IP}  (rack ${PLC_RACK}, slot ${PLC_SLOT})`);
  console.log(`Writing:    DB${DB_NUMBER}.INT${BYTE_OFFSET}  (${READ_BYTES} bytes)`);
  console.log(`Delay between tests: ${DELAY_MS / 1000}s`);

  try {
    await writeWithSnap7();
  } catch (err) {
    console.error('  x snap7 failed:', /** @type {Error} */ (err).message);
  }

  console.log(`\n  waiting ${DELAY_MS / 1000}s ...`);
  await sleep(DELAY_MS);

  try {
    await writeWithCompat();
  } catch (err) {
    console.error('  x S7Client compat failed:', /** @type {Error} */ (err).message);
  }

  console.log(`\n  waiting ${DELAY_MS / 1000}s ...`);
  await sleep(DELAY_MS);

  try {
    await writeWithNative();
  } catch (err) {
    console.error('  x Native PlcConnection failed:', /** @type {Error} */ (err).message);
  }

  console.log(`\n  waiting ${DELAY_MS / 1000}s ...`);
  await sleep(DELAY_MS);

  /** @type {ProxyRuntime | undefined} */
  let runtime;
  try {
    runtime = await startS7Proxy();

    try {
      await readWithAdminRest(runtime);
    } catch (err) {
      console.error('  x Admin HTTP failed:', /** @type {Error} */ (err).message);
    }

    console.log(`\n  waiting ${DELAY_MS / 1000}s ...`);
    await sleep(DELAY_MS);

    try {
      await writeWithAdminWs(runtime);
    } catch (err) {
      console.error('  x Admin WebSocket failed:', /** @type {Error} */ (err).message);
    }
  } catch (err) {
    console.error('  x S7Proxy child process failed:', /** @type {Error} */ (err).message);
  } finally {
    if (runtime) await stopS7Proxy(runtime);
  }

  console.log('\nDone');
}

main().catch((err) => {
  console.error('Fatal sample error:', /** @type {Error} */ (err).message);
  process.exitCode = 1;
});