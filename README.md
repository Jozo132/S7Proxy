# S7Proxy

S7Comm/S7CommPlus proxy and client library with an AssemblyScript WASM protocol engine for classic S7Comm and a separate experimental native read-only S7CommPlus client. Classic S7Comm connects to Siemens S7 PLCs (S7-300/400/1200/1500) over TCP with automatic failover, data acquisition, structured DB access, and a REST/WebSocket API.

## Features

- **WASM protocol engine** — TPKT / COTP / S7Comm PDU serialization compiled from AssemblyScript for near-native performance
- **Connection pooling** — multiple PLC connections with automatic health checks and failover/failback
- **Data acquisition (DAQ)** — subscription-based periodic reads with scan groups, read coalescing, priority queues, and caching
- **Structured DB access** — define PLC data block layouts, read/write as plain JS objects with automatic encode/decode
- **REST + WebSocket API** — lightweight built-in HTTP endpoints and real-time WebSocket push with slow-consumer protection
- **S7Comm proxy** — transparent TCP proxy with TSAP/IP-based routing and allow/deny filtering
- **snap7 compatibility** — `S7Client` read/write subset and `S7Server`; unimplemented metadata, upload and control methods return explicit errors
- **Native S7CommPlus** - experimental read-only TLS and legacy S7-1200 sessions, DB/type discovery, typed symbolic reads, and restricted in-memory program-content extraction
- **Worker thread mode** — run the proxy in an isolated worker
- **Prometheus metrics** — built-in `/metrics` endpoint

## Install

```bash
npm install s7proxy
```

Requires Node.js >= 20.

## Recent Updates

### 0.4.2 (current source)

- Cached DB inventories within a client session, avoiding repeated inventory requests. Per-block evidence retains the relevant object's attributes and response correlation instead of the entire inventory.
- More efficient nested-type discovery using indexed lookups and a deduplicated traversal queue, with higher configurable object, depth, response, request and member limits. These are allocation ceilings, not hardware qualification or guarantees of complete discovery.
- Bounded diagnostic history through `limits.maxDiagnosticEntries` (default `128`, maximum `4096`) for each observation/transcript collection. Transcript hex fields retain at most 1024 bytes per entry; reports are diagnostic samples, not guaranteed complete wire captures.

### 0.4.1

- Separate object-count and nesting-depth limits in the native object decoder, with specific errors identifying which limit was exceeded.

### 0.4.0

- Explicit legacy S7-1200 SessionKey setup and activation, with HMAC-SHA256 verification of requests and response fragments. Legacy traffic is not encrypted and there is no automatic TLS downgrade.
- Explicitly configured PLC hostnames/IPs and ports, optional certificate-validation bypass, TLS 1.2/1.3 negotiation, and a separate TLS handshake deadline. Strict certificate verification remains the default.
- Improved compatibility with composite service-status replies and operation-specific latency checks. Authorized testing obtained one genuine process-value read from each of twelve responding S7-1200 CPUs; other families and security profiles remain unqualified.

## Native Read-Only S7CommPlus Foundation

`S7CommPlusClient` is a separate experimental native backend with bounded object
Explore, native DB/type-member discovery and typed symbolic reads. It supports
session-local name resolution after explicit block discovery. Explicit legacy
S7-1200 SessionKey sessions and TLS sessions are supported; username/password
legitimation, S7-1500 legacy keys and PLCSIM key families remain unsupported.
The verified TLS V2 profile
also supports bounded native program-content attribute extraction, returning
in-memory files; this is not a full-controller or restorable backup.
Existing DAQ, proxy and REST/WebSocket APIs remain classic S7Comm paths.

For the production target, only the isolated read-only backend
is permitted; the classic/raw backend rejects this IP. Other classic endpoints
retain read/write behavior. No acquisition runs on import or normal server startup.

The explicit `node src/plus-explore.js --live --legacy` command selects the
plaintext legacy profile and makes one bounded identification attempt, printing
the result to stdout without writing evidence or backup files.
It never retries, dumps blocks, schedules backups or modifies PLC configuration.
Do not rerun it to investigate a rejection without reviewing the saved evidence.
It accepts an explicit `--host HOST` and optional `--port PORT` (default 102).
Without `--host`, the existing local production-target configuration is used.
The library likewise accepts any explicitly configured PLC IP address or hostname
and port; it does not require lab/production environment labels. Only connect to
controllers you are authorized to access. No automatic TLS/plaintext fallback is
implemented; select the profile configured on that controller.

For controllers configured for legacy communication, use `securityMode: 'legacy'`.
Recognized InitSSL incompatibility replies can continue only in that explicit
profile. An exact advertised S7-1200 public key and 20-byte challenge are required;
family-only and unknown identities stop without key guessing. The client creates
a fresh encrypted SessionKey blob, writes it only to its owned session's setup
address, and performs a fixed owned-session activation. Every subsequent packet
uses V3 HMAC-SHA256 integrity, including each metadata response fragment. This is
not TLS: legacy traffic remains readable on the network, and the shared family
key does not independently authenticate the target's identity. Reports label it
`LEGACY_SESSION_KEY_INTEGRITY`. No password guessing or automatic TLS downgrade
is performed. The legacy cryptographic compatibility code is experimental and
has not undergone an independent security audit or constant-time review.

For a separately authorized lab target, configure `S7PROXY_LAB_HOST` separately
from the production target and select `--lab --legacy` or `--lab --tls` explicitly.
Establish that PLC's TCP/102 security profile independently before any attempt.
TLS additionally requires `S7PLUS_TLS_CA`, `S7PLUS_TLS_CERT_SHA256` (64 hex digits
over the peer certificate's DER), and optionally `S7PLUS_TLS_SERVERNAME` for a
verified certificate name. The corresponding library field is
`tls.certificateSha256`. CA, hostname and pin must all verify before CreateObject;
pinning is not trust-on-first-use. Consumers decide whether to save the results.

To explicitly accept any PLC certificate, set `tls.allowAnyCertificate: true`
in the library, or add `--allow-any-certificate` to the TLS exploration command:

```sh
node src/plus-explore.js --live --lab --tls --allow-any-certificate
```

This opt-in disables CA, hostname and SHA-256 pin validation, including any
supplied pin. No CA or pin is required in this mode. Traffic remains encrypted,
but the PLC identity is not authenticated and a man-in-the-middle can impersonate
it. Reports retain the observed fingerprint and say `TLS_UNVERIFIED` with
`allowAnyCertificate: true`; they never claim verified trust. Verification remains
the default. Read-only limits and the verified-TLS requirement for program
extraction are unchanged. TLS is available for any explicitly configured target.

For example, with the authorized target supplied through the environment:

```powershell
node src/plus-explore.js --live --host $env:PLC_HOST --tls --allow-any-certificate --tls-min-version TLSv1.3
```

`tls.minVersion` accepts `TLSv1.2` (default, also permits TLS 1.3) or `TLSv1.3`.
The TLS profile offers AES-GCM TLS 1.3 suites and X25519. The default TLS handshake
deadline is 10 seconds (`limits.tlsHandshakeTimeoutMs`), separate from the
5-second request deadline. The identification CLI retains 3-second ordinary
request deadlines and a 20-second session ceiling.

The current source uses the following client limits. All budgets remain active
independently; increasing the object limit does not increase response bytes,
session duration or the request budget.

| Limit | Default | Maximum accepted |
| --- | ---: | ---: |
| `limits.maxObjects` | 65,536 | 262,144 |
| `limits.maxDepth` | 256 | 1,024 |
| `limits.maxResponseBytes` | 65,536 bytes | 16,777,216 bytes |
| `limits.maxRequests` | 12 | 10,000,000 |

The default session ceiling remains 60 seconds, total received-byte budget
262,144 bytes, and minimum pacing 250 ms. Configure larger budgets deliberately
for an authorized acquisition; accepted maxima do not establish safe PLC load
or support for every program size. The earlier live-test budgets below describe
those specific runs, not the current defaults.

Historical plaintext CreateObject attempts were rejected; the numeric cause is
not established. Subsequent authorized lab testing established verified
TLS-over-COTP sessions, genuine RUN/protection replies, native DB/type metadata,
and BOOL, INT and TIME reads. This does not qualify another controller or security
profile, and no production retest is implied.
An additional configured-target test on a CPU 1214C, firmware V4.5, established
TLS 1.3 with explicit certificate bypass, discovered 96 DBs, and read one native
BOOL with `GOOD` quality. That session used 10 requests and a 256-object budget,
and completed in approximately 8.15 seconds. Its identity remained
`TLS_UNVERIFIED`; it does not qualify every PLC firmware or authentication profile.
Exact test harnesses and evidence live under gitignored `experimentation/`.
An additional multi-controller run established process-value reads on twelve
responding S7-1200 CPUs: nine legacy V4.4/V4.5 sessions and three TLS V4.5/V4.7
sessions. Five other configured addresses did not answer TCP/102 within the
bounded attempt; that does not prove they are offline. Captured inventories
ranged from 17 to 314 DBs. The experiments used explicit budgets, up to 24 requests,
512 objects and 1024 expanded members, and read one discovered process value per
responding PLC. They do not prove every DB or datatype is readable.
See [the evidence and implementation report](docs/S7_READ_ONLY_REPORT.md)
and [reference licensing](THIRD_PARTY_NOTICES.md).

### Native symbol discovery

```js
import { readFile } from 'node:fs/promises';
import { S7CommPlusClient } from 's7proxy';

const host = process.env.PLC_HOST;
if (!host) throw new Error('Configure an authorized PLC target first');
const plc = new S7CommPlusClient({
  host,
  securityMode: 'tls',
  limits: { maxObjects: 256 },
  tls: {
    ca: await readFile(process.env.S7PLUS_TLS_CA),
    certificateSha256: process.env.S7PLUS_TLS_CERT_SHA256,
  },
});
try {
  await plc.connect();
  const block = await plc.getBlockMetadata({ type: 'DB', number: 7 });
  const typeInfo = block.typeInfoId ? await plc.getTypeInfo(block.typeInfoId) : null;
  const discovery = await plc.listBlockMembers({ type: 'DB', number: 7 });
  const member = discovery.members.find(item => item.path === 'Enabled' && item.readable);
  if (!member) throw new Error('Member unavailable in native metadata');
  const result = await plc.readMember(member);
  // Equivalent after discovery: await plc.readSymbol('SampleDB.Enabled');
  console.log(block, typeInfo?.status, result.observation);
} finally {
  await plc.disconnect();
}
```

The example names are synthetic. DB discovery retains the runtime object RID;
LID 1 retrieves its native type reference, which can refer to a shared definition
rather than a DB-specific type. `getTypeInfo()` explores that exact RID, not an
unbounded catalog. Member/name lists retain native IDs, software datatypes, type
references and CRCs independently of byte offsets.

`listBlockMembers()` returns `{ block, members, completeness, diagnostics,
evidence }`. Each member retains `memberId`, `typeInfoId`, `accessPath`,
`datatype`, hierarchy and array dimensions. Structures and arrays include their
containing context; struct-array access paths include the native element selector.
Unknown types, references/pointers, recursive or unavailable types, ambiguous
names, packed BOOL arrays and expansion limits remain explicit and unreadable.
Defaults permit eight type queries and 4096 expanded members, still subject to
the client's request/byte/time budgets. The current source accepts explicit
`listBlockMembers(selector, { maxTypes, maxMembers })` budgets up to 65,536 type
queries and 1,048,576 expanded members. Raising these ceilings does not make
recursive, ambiguous or unsupported layouts readable. DB inventories and type
queries are cached within the client session; use a new client session for a
fresh snapshot. Raise session budgets explicitly when querying multiple blocks;
there are no implicit reconnects or retries.

`readMember()` accepts only readable descriptors discovered by that client.
It checks the returned wire datatype and retains the raw value, request/response
correlation, receipt time and metadata evidence. TIME is a signed 32-bit
millisecond value. Browsed type-entry CRCs are preserved as metadata, not sent
as address CRCs. Results identify their source as `S7COMMPLUS_RESPONSE`; consumers
must distinguish real-controller acquisitions from loopback tests.

Discovery is a bounded session snapshot, not a complete program inventory or
proof of a downloaded project revision. Nested/array reconstruction is covered
by synthetic tests; it is not blanket hardware qualification for all optimized
DBs, FB sections or multi-instance layouts.

### Native program content as in-memory files

`listProgramBlocks()` inventories observed DB, FC and OB objects, preserving
their native classes, RIDs, numbers, names, language codes and returned attributes.
Unknown classes and missing metadata are explicit; the inventory is not claimed
to be exhaustive. `uploadProgramBlock({ type, number })` freshly inventories the
requested block, checks RUN before/after retrieval, and reads that exact object's
native code/body/interface/comment/reference attributes using read-only Explore.
It does **not** transmit the reference implementation's experimental
`GET_VAR_SUBSTREAMED` upload request.

The qualified profile requires verified TLS V2, effective access level 1, and
the observed zero-valued native block-protection mode. Production extraction,
unknown protection states and nonzero protection modes are denied. No credential
guessing or plaintext fallback is attempted.

In a fresh, connected client session with sufficient request/byte budgets:

```js
const acquisition = await plc.uploadProgram({
  mode: 'run',
  include: ['OB', 'FC', 'DB'],
});
for (const file of acquisition.files) {
  // file.bytes is a Buffer. Nothing has been written to disk.
  console.log(file.name, file.byteCount, file.sha256, file.block);
  // The application decides whether to save, send, compare or discard it.
}
// Single-block uploads also return a .files array:
// const { files } = await plc.uploadProgramBlock({ type: 'FC', number: 8 });
```

Single-block results distinguish `CODE_CONTENT_RETRIEVED`, `DEFINITION_ONLY`
and `UNAVAILABLE`. `rawBytes`, `byteCount` and `sha256` identify the primary
component, not the controller's entire load memory. `primaryComponent` and
`rawFormat` distinguish a BLOB payload from a complete sparse PValue container.
All returned component bytes, sparse keys/root IDs, original typed attribute
headers and the correlated response body are preserved. Lengths, response
sequence, integrity counter, fragment ordering and the explicit end trailer are
checked; fragment counts refer to Plus frames, not TCP/TLS records.

Software acquisition is sequential, bounded and non-retrying. It reserves a
request for the final CPU-state check; exhausted budgets, unavailable content,
protected blocks and failures remain explicit. Increase the default 12-request
budget deliberately for larger inventories. FB/UDT/tag enumeration and other
CPU/security profiles remain unqualified, not silently reported as complete.

Each file contains `name`, `bytes`, `byteCount`, `sha256`, native block identity,
component kind, attribute ID and status. Names are logical labels, not storage
paths. `format: 'BLOB_PAYLOAD'` preserves a single BLOB's original payload;
multipart sparse or unsupported content uses `format: 'NATIVE_PVALUE'` to retain
the original container unchanged. `nativeAttribute` always retains the original
typed attribute bytes. Absent/empty components remain explicit in `components`
but do not fabricate files. Partial uploads return only the files obtained.

The library does not write uploaded content, create backup directories, retain
snapshots or choose a storage policy. Disk persistence/evidence helpers exist
only in tests and are not exported or packaged. Existing configuration, WASM
loading, certificate loading and proxy behavior are unchanged.

These artifacts are `BLOCK_CONTENT` and `SOFTWARE_UPLOAD`, not editable TIA
archives, `HARDWARE_SOFTWARE_UPLOAD`, `CONTROLLER_BACKUP`, or
`RESTORABLE_BACKUP_VERIFIED`. Full load-memory reconstruction, initial/retentive
data, memory-card contents, hardware configuration and restore consistency are
not implemented. RUN observations before/after do not establish an atomic snapshot.

**CPU mode control is unavailable.** There is no STOP/START encoder, authorization
token issuer or automatic restart in this backend. Selecting
`stop-required-backup` fails with `EXPLICIT_CPU_STOP_CONFIRMATION_REQUIRED`
without transmission; flags, stored confirmations and automated acknowledgements
cannot enable it. A qualified interactive STOP/START workflow remains future
work, requiring independent protocol qualification and separately authorized
equipment shutdown/readiness procedures.

Siemens distinguishes RUN-capable software/hardware uploads from the STOP-only
consistent online-device backup in its
[backup options documentation](https://docs.tia.siemens.cloud/r/en-us/v20/creating-a-backup-of-an-s7-cpu/backup-options-for-s7-cpus).
That product documentation does not qualify S7Proxy's missing backup operations.

## Quick Start

### Standalone (CLI)

```bash
# Start with default config
npx s7proxy

# Start with custom config
npx s7proxy config/my-plc.json

# Override bind address and ports from the CLI
npx s7proxy config/my-plc.json --host 127.0.0.1 --port 1102 --web-host 127.0.0.1 --web-port 8081
```

### As a library

```js
import { ProxyServer, loadConfig } from 's7proxy';

const config = loadConfig('./config/default.json');
const server = new ProxyServer(config);

// Register struct definitions before or after start
server.registerStruct({
  name: 'Motor',
  db: 10,
  offset: 0,
  items: [
    { name: 'speed',    type: 'REAL' },
    { name: 'running',  type: 'BOOL' },
    { name: 'fault',    type: 'BOOL' },
    { name: 'setpoint', type: 'REAL' },
  ],
});

await server.start();

// Read → plain object
const values = await server.readStruct('Motor');
// { speed: 1200.5, running: true, fault: false, setpoint: 1500 }

// Read specific fields only
const partial = await server.readStruct('Motor', ['speed', 'running']);
// { speed: 1200.5, running: true }

// Write → pass an object (partial writes supported)
await server.writeStruct('Motor', { speed: 1500, setpoint: 1800 });

// Subscribe for periodic decoded updates
server.structs.on('struct:data:Motor', (values) => {
  console.log('Motor update:', values);
});
server.subscribeStruct('Motor', 'plc1', 500);

// Graceful shutdown
await server.stop();
```

### Direct PLC connection

```js
import {
  PlcConnection, WasmBridge,
  loadWasmEngine, createWasmImports, createLogger,
} from 's7proxy';

const engine = await loadWasmEngine(createWasmImports());
const bridge = new WasmBridge(engine);
const logger = createLogger();
const conn = new PlcConnection(
  'plc1-0', 'plc1', { ip: '192.168.1.10', rack: 0, slot: 1 },
  bridge, logger, 3000,
);
conn.on('error', (err) => logger.error({ err }, 'PLC socket error'));

await conn.connect();

// Read 4 bytes from DB1 offset 0
const frame = bridge.buildReadRequest(0x84, 1, 0, 4, 0x02);
const pduRef = frame.readUInt16BE(11);
const response = await conn.sendRequest(frame, pduRef);

await conn.disconnect();
```

### Connection recovery and scan timing

- `PlcConnection.connect()` shares an in-flight attempt and applies a deadline of
  twice `requestTimeoutMs` across TCP, COTP, and S7 setup. Closing or disconnecting
  during setup rejects that attempt.
- Requests use `requestTimeoutMs`. A timeout invalidates the session and rejects
  all outstanding requests, so a pool can reconnect instead of reusing a stalled
  socket. Direct connections must be reconnected by their caller.
- TCP connections enable keepalive (initial delay 1 second) and disable Nagle's
  algorithm. Keepalive is not a substitute for request deadlines.
- Pools maintain one reconnect timer per connection slot, with exponential delays
  of 250 ms up to 5 seconds. Stop and failover cancel old timers and prevent old
  sessions from scheduling replacements.
- A scan group skips ticks while its previous scan is outstanding; missed ticks
  do not accumulate. Results arriving after their scan group is removed or after
  shutdown are discarded.
  A scan with no available connection marks its tags bad rather than republishing
  an old good value.
- The snap7-compatible client reports connection failures through callback error
  codes and `LastError()`, without requiring an EventEmitter `error` listener.

### snap7-compatible client

```js
import { S7Client } from 's7proxy';

const client = new S7Client();
client.ConnectTo('192.168.1.10', 0, 1, (err) => {
  if (err) throw err;

  // Read 10 bytes from DB1 starting at offset 0
  client.DBRead(1, 0, 10, (err, data) => {
    console.log(data); // <Buffer ...>
    client.Disconnect();
  });
});
```

### Worker thread

```js
import { Worker } from 'node:worker_threads';

const worker = new Worker('./node_modules/S7Proxy/src/worker.js', {
  workerData: { config, autoStart: true },
});

// Control via messages
worker.postMessage({ type: 'stop' });
```

## Struct Types

All standard S7 data types are supported in struct definitions:

| Type | Size | Notes |
|------|------|-------|
| `BOOL` / `BIT` | 1 bit | Bit-packed with S7 alignment |
| `BYTE` / `CHAR` / `SINT` / `USINT` | 1 byte | |
| `INT` / `UINT` / `WORD` | 2 bytes | |
| `DINT` / `UDINT` / `DWORD` / `REAL` / `FLOAT` / `TIME` / `S5TIME` | 4 bytes | |
| `LREAL` / `DOUBLE` | 8 bytes | |
| `STRING` | 2 + strlen | Use `strlen` property (default 254) |
| `TIMER` / `IEC_TIMER` | 16 bytes | Decoded as flat sub-fields |

Arrays are declared with `size > 1`:

```js
server.registerStruct({
  name: 'SensorArray',
  db: 20,
  offset: 0,
  items: [
    { name: 'temps', type: 'REAL', size: 8 },  // array of 8 REALs
    { name: 'flags', type: 'BOOL', size: 16 }, // array of 16 BOOLs
  ],
});
```

## REST API

All endpoints are under the configured web API port (default 8080).

### Connection & Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/targets` | Connection pool & failover status |
| POST | `/api/targets/failover` | Force failover to backup |
| POST | `/api/targets/failback` | Force failback to primary |

### Data Acquisition

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/read?tag=<name>` | Read cached tag value |
| GET | `/api/subscriptions` | List active subscriptions |
| POST | `/api/subscriptions` | Create subscription |
| DELETE | `/api/subscriptions/:id` | Remove subscription |
| GET | `/api/scan-groups` | Scan group statistics |
| GET | `/metrics` | Prometheus metrics |

### Structured DB Access

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/structs` | List registered structs |
| POST | `/api/structs` | Register a struct definition |
| GET | `/api/structs/:name` | Struct info + cached values |
| DELETE | `/api/structs/:name` | Remove struct |
| GET | `/api/structs/:name/read` | Read from PLC (optional `?keys=a,b`) |
| POST | `/api/structs/:name/write` | Write `{ values: {...} }` to PLC |
| POST | `/api/structs/:name/subscribe` | Subscribe `{ targetId, intervalMs }` |
| GET | `/api/structs/:name/cached` | Last decoded values (no PLC hit) |

## WebSocket API

Connect to `ws://host:8080/ws`. Messages are JSON.

### Subscribe to raw tags

```json
→ { "type": "subscribe", "targetId": "plc1", "tags": [...], "intervalMs": 500 }
← { "type": "subscribed", "subscriptionId": "...", "tags": 3 }
← { "type": "data", "subscriptionId": "...", "tags": [...] }
```

### Subscribe to structs

```json
→ { "type": "register-struct", "name": "Motor", "db": 10, "items": [...] }
← { "type": "struct-registered", "name": "Motor", "size": 20 }

→ { "type": "subscribe-struct", "name": "Motor", "targetId": "plc1", "intervalMs": 500 }
← { "type": "struct-subscribed", "subscriptionId": "..." }
← { "type": "struct-data", "struct": "Motor", "values": { "speed": 1200.5 }, "timestamp": ... }
```

### Read/write structs

```json
→ { "type": "read-struct", "name": "Motor", "keys": ["speed"] }
← { "type": "struct-data", "struct": "Motor", "values": { "speed": 1200.5 } }

→ { "type": "write-struct", "name": "Motor", "values": { "speed": 1500 } }
← { "type": "struct-written", "struct": "Motor" }
```

## Configuration

Configuration is loaded from JSON. For simple deployments, `S7PROXY_CONFIG` can also point at a `.env` file that sets scalar overrides like ports and log level.

CLI flags can override both environment variables and config file values:

```bash
npx s7proxy [config-path] [options]

Options:
  --host, --ip <host>    Override listen.ip
  --port <port>          Override listen.port
  --web-host <host>      Override webApi.host
  --web-port <port>      Override webApi.port
  --config <path>        Explicit config path
```

```json
{
  "listen": {
    "ip": "0.0.0.0",
    "port": 102
  },
  "targets": [
    {
      "id": "plc1",
      "primary": { "ip": "192.168.1.10", "rack": 0, "slot": 1 },
      "backups": [
        { "ip": "192.168.1.11", "rack": 0, "slot": 1 }
      ],
      "maxConnections": 4
    }
  ],
  "failover": {
    "healthCheckIntervalMs": 3000,
    "failoverThreshold": 3,
    "failbackMode": "auto"
  },
  "webApi": {
    "enabled": true,
    "port": 8080,
    "cors": { "origin": "*" },
    "rateLimit": { "max": 100, "windowMs": 60000 }
  },
  "daq": {
    "minScanIntervalMs": 20,
    "maxGapBytes": 32,
    "cacheEnabled": true,
    "cacheTtlMs": 5000
  },
  "logging": {
    "level": "info"
  }
}
```

### Environment Variables

| Variable | Overrides |
|----------|-----------|
| `S7PROXY_CONFIG` | Config file path |
| `S7PROXY_PORT` | `listen.port` |
| `S7PROXY_IP` | `listen.ip` |
| `S7PROXY_LOG_LEVEL` | `logging.level` |
| `S7PROXY_WEB_HOST` | `webApi.host` |
| `S7PROXY_WEB_PORT` | `webApi.port` |

## Development

Use Node.js 22.12+ (or a compatible newer release) for the current Vite/Vitest
toolchain. Demo PLC integration fixtures use loopback port 11102 rather than
privileged port 102.

```bash
# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Unit tests only
npm run test:unit

# Integration tests only
npm run test:integration

# Type checking (JSDoc)
npm run check-types

# Rebuild WASM engine
npm run build:wasm

# Dev mode with auto-reload
npm run dev
```

## Project Structure

```
assembly/        AssemblyScript WASM engine (TPKT, COTP, S7Comm)
build/           Compiled s7engine.wasm
config/          Default JSON configuration
src/
  api/           REST + WebSocket server
  client/        PLC connections, pool, failover, health probes
  compat/        node-snap7 drop-in replacements
  daq/           Data acquisition, scan groups, caching
  logging/       Lightweight structured logger
  metrics/       Lightweight Prometheus text collector
  protocol/      Types, constants, frame assembly, DB struct codec
  router/        S7Comm proxy routing
  server/        TCP listener, client sessions
  wasm/          WASM loader, bridge, imports
test/
  unit/          Unit tests
  integration/   Integration tests
  samples/       Real PLC sample scripts
```

## License

MIT
