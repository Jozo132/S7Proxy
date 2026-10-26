// @ts-check
// ─────────────────────────────────────────────────────────────────────────────
// Sample 1 — Read DB1.INT0 from an explicitly supplied S7-1200 PLC
//
// Demonstrates five approaches, executed 5 seconds apart:
//   1. node-snap7 native client
//   2. S7Proxy compatibility layer  (S7Client — drop-in snap7 replacement)
//   3. S7Proxy native mode          (PlcConnection + WasmBridge)
//   4. S7Proxy child process + HTTP FETCH   (REST API)
//   5. S7Proxy child process + WebSocket    (real-time push)
//
// Approaches 4 & 5 share a single S7Proxy child process.
//
// PLC config (to be verified):
//   IP:   supplied as the first command-line argument
//   Rack: 0   Slot: 1
//   DB1, INT at byte offset 0  →  readInt16BE
// ─────────────────────────────────────────────────────────────────────────────

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
import { S7AreaDB, S7WLWord } from '../../../src/protocol/constants.js';

// ─── PLC parameters (update as needed) ──────────────────────────────────────
const PLC_IP = process.argv[2];
if (!PLC_IP || !isIP(PLC_IP)) throw new Error('Usage: node test/samples/sample1_plc/index.js <plc-ip>');
const snap7 = (await import('node-snap7')).default;
const PLC_RACK = 0;
const PLC_SLOT = 1;

const DB_NUMBER    = 1;
const BYTE_OFFSET  = 0;
const READ_BYTES   = 2;   // INT = 2 bytes

const DELAY_MS = 5000;

// S7Proxy web API (used by approaches 4 & 5)
const WEB_PORT = 18080;
const BASE_URL = `http://localhost:${WEB_PORT}`;
const WS_URL   = `ws://localhost:${WEB_PORT}/ws`;

// Tag definition used for subscription
const TAG_DEF = {
  name: `DB${DB_NUMBER}.INT${BYTE_OFFSET}`,
  area: S7AreaDB,
  start: BYTE_OFFSET,
  dbNum: DB_NUMBER,
  amount: 1,
  wordLen: 0x04,    // S7WLWord
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {Buffer} buf */
function printInt(buf) {
  const value = buf.readInt16BE(0);
  console.log(`  → DB${DB_NUMBER}.INT${BYTE_OFFSET} = ${value}  (raw: ${buf.toString('hex')})`);
}

// ─── 1. node-snap7 ──────────────────────────────────────────────────────────

async function readWithSnap7() {
  console.log('\n═══ 1/5  node-snap7 (native) ═══');

  /** @type {*} */
  const client = new snap7.S7Client();

  await new Promise((resolve, reject) => {
    client.ConnectTo(PLC_IP, PLC_RACK, PLC_SLOT, (/** @type {number} */ err) => {
      if (err) return reject(new Error(`snap7 ConnectTo failed: ${err}`));
      resolve(undefined);
    });
  });
  console.log('  Connected via snap7');

  const buf = await new Promise((resolve, reject) => {
    client.DBRead(DB_NUMBER, BYTE_OFFSET, READ_BYTES, (/** @type {number} */ err, /** @type {Buffer | undefined} */ data) => {
      if (err) return reject(new Error(`snap7 DBRead failed: ${err}`));
      resolve(data);
    });
  });

  printInt(/** @type {Buffer} */ (buf));
  client.Disconnect();
  console.log('  Disconnected');
}

// ─── 2. S7Proxy compatibility layer ─────────────────────────────────────────

async function readWithCompat() {
  console.log('\n═══ 2/5  S7Proxy compat (S7Client) ═══');

  const client = new S7Client();

  const connectErr = await new Promise((resolve) => {
    client.ConnectTo(PLC_IP, PLC_RACK, PLC_SLOT, (/** @type {number} */ err) => resolve(err));
  });
  if (connectErr !== 0) throw new Error(`S7Client ConnectTo failed: ${client.ErrorText(/** @type {number} */ (connectErr))}`);
  console.log(`  Connected via S7Client  (PDU ${client.PduLength()})`);

  const buf = await new Promise((resolve, reject) => {
    client.DBRead(DB_NUMBER, BYTE_OFFSET, READ_BYTES, (/** @type {number} */ err, data) => {
      if (err) return reject(new Error(`S7Client DBRead failed: ${client.ErrorText(err)}`));
      resolve(/** @type {Buffer} */ (data));
    });
  });

  printInt(/** @type {Buffer} */ (buf));
  client.Disconnect();
  console.log('  Disconnected');
}

// ─── 3. S7Proxy native mode ─────────────────────────────────────────────────

async function readWithNative() {
  console.log('\n═══ 3/5  S7Proxy native (PlcConnection + WasmBridge) ═══');

  const logger = createLogger({ level: 'silent' });
  const imports = createWasmImports(logger);
  const engine = await loadWasmEngine(imports);
  const bridge = new WasmBridge(engine);

  const conn = new PlcConnection(
    'sample-conn', 'plc1',
    { ip: PLC_IP, rack: PLC_RACK, slot: PLC_SLOT },
    bridge, logger,
  );

  await conn.connect();
  console.log(`  Connected via PlcConnection`);

  // Build S7 Read Request: 1 word (= 1 INT, 2 bytes) from DB1 at offset 0
  const frame = bridge.buildReadRequest(S7AreaDB, DB_NUMBER, BYTE_OFFSET, 1, S7WLWord);
  const pduRef = frame.readUInt16BE(11);      // TPKT(4) + COTP(3) + S7 hdr bytes 4-5
  const response = await conn.sendRequest(frame, pduRef);

  // Parse the S7 read response data items
  // Data item starts after TPKT(4) + COTP DT(3) + S7 header(12) + param(2) = offset 21
  const dataItemOffset = 21;
  const returnCode = response[dataItemOffset];
  if (returnCode !== 0xFF) {
    throw new Error(`S7 read error, return code: 0x${returnCode.toString(16)}`);
  }
  const bitLength = response.readUInt16BE(dataItemOffset + 2);
  const byteLength = Math.ceil(bitLength / 8);
  const data = response.subarray(dataItemOffset + 4, dataItemOffset + 4 + byteLength);

  printInt(data);
  await conn.disconnect();
  console.log('  Disconnected');
}

// ─── 4. S7Proxy child-process + HTTP FETCH ──────────────────────────────────

/**
 * @param {import('node:child_process').ChildProcess} _proc  (kept alive externally)
 */
async function readWithFetch(_proc) {
  console.log(`\n═══ 4/5  S7Proxy child process + FETCH ═══`);

  // Step 1 — create a subscription so the DAQ engine starts polling the tag
  const subRes = await fetch(`${BASE_URL}/api/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      targetId: 'plc1',
      intervalMs: 500,
      tags: [TAG_DEF],
    }),
  });
  const sub = /** @type {any} */ (await subRes.json());
  if (!subRes.ok) throw new Error(`Subscribe failed: ${JSON.stringify(sub)}`);
  console.log(`  Subscribed (id: ${sub.id})`);

  // Step 2 — wait a moment for the first scan, then read the cached value
  await sleep(1500);

  const readRes = await fetch(`${BASE_URL}/api/read?tag=${encodeURIComponent(TAG_DEF.name)}`);
  const cached = /** @type {any} */ (await readRes.json());
  if (!readRes.ok) throw new Error(`Read failed: ${JSON.stringify(cached)}`);

  const buf = Buffer.from(cached.value, 'hex');
  printInt(buf);

  // Step 3 — clean up the subscription
  await fetch(`${BASE_URL}/api/subscriptions/${sub.id}`, { method: 'DELETE' });
  console.log('  Subscription removed');
}

// ─── 5. S7Proxy child-process + WebSocket ────────────────────────────────────

/**
 * @param {import('node:child_process').ChildProcess} _proc  (kept alive externally)
 */
async function readWithWebSocket(_proc) {
  console.log(`\n═══ 5/5  S7Proxy child process + WebSocket ═══`);

  const ws = new WebSocket(WS_URL);

  /** @type {(v?: any) => void} */
  let resolveData;
  /** @type {(r?: any) => void} */
  let rejectData;
  const dataPromise = new Promise((res, rej) => { resolveData = res; rejectData = rej; });

  // Timeout guard
  const timer = setTimeout(() => rejectData(new Error('Timed out waiting for WS data')), 10000);

  await new Promise((resolve, reject) => {
    ws.on('open', () => resolve(undefined));
    ws.on('error', reject);
  });
  console.log('  WebSocket connected');

  ws.on('message', (/** @type {Buffer} */ raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.type === 'subscribed') {
      console.log(`  Subscribed (id: ${msg.subscriptionId})`);
    }

    if (msg.type === 'data') {
      clearTimeout(timer);
      resolveData(msg);
    }
  });

  // Subscribe via WS
  ws.send(JSON.stringify({
    type: 'subscribe',
    targetId: 'plc1',
    intervalMs: 500,
    tags: [TAG_DEF],
  }));

  // Wait for the first data push
  const data = /** @type {any} */ (await dataPromise);

  // The pushed data contains tag values — extract the first tag
  if (data.tags && data.tags.length > 0) {
    const tag = data.tags[0];
    const buf = Buffer.from(tag.value, 'hex');
    printInt(buf);
  } else if (data.value !== undefined) {
    const buf = Buffer.from(data.value, 'hex');
    printInt(buf);
  } else {
    console.log('  → (data pushed)', JSON.stringify(data));
  }

  ws.close();
  console.log('  WebSocket closed');
}

// ─── S7Proxy child-process lifecycle ─────────────────────────────────────────

/**
 * Start S7Proxy as a forked child process.
 * Waits until the web API is listening before returning.
 * @returns {Promise<import('node:child_process').ChildProcess>}
 */
async function startS7Proxy() {
  // Dynamically import node builtins
  const fs   = await import('node:fs');
  const os   = await import('node:os');
  const path = await import('node:path');

  // Write temp config
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 's7proxy-sample-'));
  const cfgPath = path.join(tmpDir, 'config.json');
  const config = {
    listen: { ip: '0.0.0.0', port: 10102 },
    targets: [{
      id: 'plc1',
      primary: { ip: PLC_IP, rack: PLC_RACK, slot: PLC_SLOT },
      maxConnections: 2,
      requestTimeoutMs: 3000,
    }],
    webApi: { enabled: true, host: '0.0.0.0', port: WEB_PORT, cors: { origin: '*' } },
    daq: { minScanIntervalMs: 20, cacheEnabled: true, cacheTtlMs: 5000 },
    logging: { level: 'warn' },
    metrics: { enabled: false },
  };
  fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf-8');

  // Determine project root (3 levels up from this file)
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const projectRoot = resolve(__dirname, '..', '..', '..');
  const entryPoint  = resolve(projectRoot, 'src', 'index.js');

  console.log('  Spawning S7Proxy child process …');
  const child = fork(entryPoint, [cfgPath], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    cwd: projectRoot,
  });

  child.stderr?.on('data', (/** @type {Buffer} */ d) => {
    const line = d.toString().trim();
    if (line) console.error(`  [proxy stderr] ${line}`);
  });

  // Wait until the web API port is accepting connections
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) {
        console.log('  S7Proxy is ready');
        return child;
      }
    } catch { /* not yet */ }
    await sleep(300);
  }
  child.kill();
  throw new Error('S7Proxy did not become ready within 15 s');
}

/** @param {import('node:child_process').ChildProcess} child */
function stopS7Proxy(child) {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    console.log('  S7Proxy child process stopped');
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Target PLC: ${PLC_IP}  (rack ${PLC_RACK}, slot ${PLC_SLOT})`);
  console.log(`Reading:    DB${DB_NUMBER}.INT${BYTE_OFFSET}  (${READ_BYTES} bytes)`);
  console.log(`Delay between tests: ${DELAY_MS / 1000}s`);

  // ── 1. snap7 ──
  try {
    await readWithSnap7();
  } catch (err) {
    console.error('  ✗ snap7 failed:', /** @type {Error} */ (err).message);
  }

  console.log(`\n  ⏳ waiting ${DELAY_MS / 1000}s …`);
  await sleep(DELAY_MS);

  // ── 2. S7Client compat ──
  try {
    await readWithCompat();
  } catch (err) {
    console.error('  ✗ S7Client compat failed:', /** @type {Error} */ (err).message);
  }

  console.log(`\n  ⏳ waiting ${DELAY_MS / 1000}s …`);
  await sleep(DELAY_MS);

  // ── 3. Native PlcConnection ──
  try {
    await readWithNative();
  } catch (err) {
    console.error('  ✗ Native PlcConnection failed:', /** @type {Error} */ (err).message);
  }

  console.log(`\n  ⏳ waiting ${DELAY_MS / 1000}s …`);
  await sleep(DELAY_MS);

  // ── 4 & 5: Start a shared S7Proxy child process ──
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let proxyChild;
  try {
    proxyChild = await startS7Proxy();

    // ── 4. FETCH ──
    try {
      await readWithFetch(proxyChild);
    } catch (err) {
      console.error('  ✗ FETCH failed:', /** @type {Error} */ (err).message);
    }

    console.log(`\n  ⏳ waiting ${DELAY_MS / 1000}s …`);
    await sleep(DELAY_MS);

    // ── 5. WebSocket ──
    try {
      await readWithWebSocket(proxyChild);
    } catch (err) {
      console.error('  ✗ WebSocket failed:', /** @type {Error} */ (err).message);
    }
  } catch (err) {
    console.error('  ✗ S7Proxy child process failed:', /** @type {Error} */ (err).message);
  } finally {
    if (proxyChild) stopS7Proxy(proxyChild);
  }

  console.log('\n✔ Done');
}

main();
