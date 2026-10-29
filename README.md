# S7Proxy

Node.js proxy and client library for Siemens S7 PLCs, with managed protocol clients
and an explicit transparent forwarding mode:

| Path | Use It For | Boundaries |
| --- | --- | --- |
| Classic S7Comm | TCP proxying, connection pools/failover, polling DAQ, structured DB reads/writes, REST/WebSocket services and a snap7-compatible subset. | AssemblyScript WASM protocol engine; requires compatible PLC configuration and known addresses/layouts. |
| Transparent S7Comm/Plus | One-to-one TCP pass-through of original COTP, classic/Plus messages and optional end-to-end TLS. | Set `listen.mode: "passthrough"`. No TLS termination, protocol-operation inspection, pooling or session migration. |
| Native S7CommPlus | Experimental symbolic DB/I/Q/M discovery, typed reads, bounded diagnostic snapshots and restricted native program-content extraction. | Separate client, not the proxy/DAQ/REST backend. Read-only by default; CPU RUN requires explicit per-call confirmation. Live Plus subscriptions are not enabled. |

Only connect to explicitly authorized controllers. Read-only traffic can still
affect communications and PLC scan time. Accepted software limits and successful
loopback tests are not hardware, load-safety or scan-synchronous qualification.

## Contents

- [Features](#features)
- [Install](#install)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Native S7CommPlus](#native-s7commplus)
- [Struct Types](#struct-types)
- [REST API](#rest-api)
- [WebSocket API](#websocket-api)
- [Development](#development)
- [Project Structure](#project-structure)
- [Recent Updates](#recent-updates)
- [License](#license)

## Features

- **WASM protocol engine** — TPKT / COTP / S7Comm PDU serialization compiled from AssemblyScript for near-native performance
- **Connection pooling** — multiple PLC connections with automatic health checks and failover/failback
- **Data acquisition (DAQ)** - classic S7Comm polling subscriptions with scan groups, read coalescing, priority queues and caching; not native Plus push notifications
- **Structured DB access** — define PLC data block layouts, read/write as plain JS objects with automatic encode/decode
- **REST + WebSocket API** — lightweight built-in HTTP endpoints and real-time WebSocket push with slow-consumer protection
- **TCP proxy** - managed classic S7Comm routing, or explicit transparent S7Comm/Plus forwarding with optional end-to-end TLS and connection-level TSAP/IP routing/filtering
- **snap7 compatibility** — `S7Client` read/write subset and `S7Server`; unimplemented metadata, upload and control methods return explicit errors
- **Native S7CommPlus** - explicit TLS or legacy S7-1200 sessions, session-owned symbolic descriptors, scalar/batch/name reads, resource/alarm/event metadata and restricted in-memory program content; no restorable controller backup
- **Worker thread mode** — run the proxy in an isolated worker
- **Prometheus metrics** — built-in `/metrics` endpoint

## Install

```bash
npm install s7proxy
```

Requires Node.js >= 20.

Development and current test tooling require Node.js 22.12+; see
[Development](#development). The library is ESM. WASM is used by managed classic
S7Comm; transparent forwarding and the separate native Plus client do not load it.

## Quick Start

Managed examples use **classic S7Comm**. For transparent Plus transport, see
[pass-through mode](#transparent-s7commplus-forwarding). For symbolic native Plus access, use
[Native S7CommPlus](#native-s7commplus) and its
[discovery example](#native-symbol-discovery). Classic proxy, DAQ and web services
do not automatically use the Plus client.

### Standalone (CLI)

```bash
# Start with default config
npx s7proxy

# Start with custom config
npx s7proxy config/my-plc.json

# Override bind address and ports from the CLI
npx s7proxy config/my-plc.json --host 127.0.0.1 --port 1102 --web-host 127.0.0.1 --web-port 8081
```

### Transparent S7Comm/Plus Forwarding

Select this mode when an existing client (for example TIA Portal or a Plus driver)
must communicate directly with a PLC through the proxy. The original COTP request,
confirmation and all subsequent bytes are forwarded unchanged, with a dedicated
upstream connection per client. Both plaintext Plus/legacy integrity traffic and
TLS-over-COTP are opaque to the proxy; classic S7Comm can also pass through.

Example configuration for an explicitly authorized target:

```json
{
  "listen": { "ip": "127.0.0.1", "port": 1102, "mode": "passthrough" },
  "targets": [{
    "id": "plc1",
    "primary": { "ip": "192.168.1.10", "port": 102, "rack": 0, "slot": 1 },
    "maxConnections": 4,
    "requestTimeoutMs": 3000
  }],
  "webApi": { "enabled": false }
}
```

Run with `npx s7proxy config/my-plc.json`, then point the existing client at the
proxy's address/port. The omitted/default mode is `classic`; `passthrough` skips
the classic connection pool, health probes, WASM and polling DAQ. If web services
are enabled, they do not gain a Plus DAQ backend.

**TLS remains end-to-end between client and PLC.** No proxy certificate, decryption
or TLS downgrade is involved. Keep the client's approved CA and PLC certificate
pin, and verify the PLC's certificate name rather than the proxy hostname (for
the native client, use `tls.servername`). The proxy neither adds TLS to plaintext
nor makes an unverified TLS client verified. Controller authentication and security
configuration still govern the upstream session.

Routing uses the first matching `srcIp`/numeric two-byte `dstTsap` rule; without a
match it uses the first configured target. Longer symbolic TSAPs are preserved but
do not match numeric TSAP rules. Target `primary` is pinned for the whole stream;
backup endpoints, automatic reconnect/retry and mid-session failover are not used.
`maxConnections` bounds dedicated streams per target (including pending connects).
The router caps all streams/handshakes at 256, waits at most 3 seconds for the
initial COTP request, buffers at most 128 KiB during that request, and uses
`requestTimeoutMs` for upstream connect (default 3000 ms, maximum 60000 ms).
Established streams use socket backpressure, not a per-message timeout. Client or
upstream closure/error closes the owned pair; server shutdown or target changes
close affected raw streams rather than replaying session bytes on another PLC.

**This is unrestricted protocol transport, not the native client's read-only
allowlist.** Writes, downloads and mode-control commands from an authorized client
can pass through on eligible targets. Restrict access at the network/connection
level. `srcIp`/`targetId` allow/deny filters are supported (deny wins; applicable
allow rules form an allowlist). Function/area/DB filters are rejected at startup
because encrypted traffic cannot be inspected. The configured production target's
existing raw-forwarding prohibition remains enforced; this mode does not bypass it.

Loopback tests cover plaintext and verified TLS Plus reads, pin mismatch propagation,
original handshake preservation, unsolicited data, stream isolation/backpressure,
routing/filtering, connection limits and teardown. Real TIA/PLC pass-through has
not been hardware-qualified by those tests.

### As A Library

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

### Direct PLC Connection

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

### Connection Recovery And Scan Timing

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

### snap7-Compatible Client

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

### Worker Thread

```js
import { Worker } from 'node:worker_threads';
import { loadConfig } from 's7proxy';

const config = loadConfig('./config/my-plc.json');
const worker = new Worker(new URL(import.meta.resolve('s7proxy/worker')), {
  workerData: { config, autoStart: true },
});

// Control via messages
worker.postMessage({ type: 'stop' });
```

## Configuration

This JSON configures the TCP listener and classic services. `listen.mode` accepts
`classic` (default) or [transparent `passthrough`](#transparent-s7commplus-forwarding).
The native client's TLS settings and budgets are passed separately to
`S7CommPlusClient` or the explicit native CLI commands below, not to the tunnel.

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

<a id="native-read-only-s7commplus-foundation"></a>

## Native S7CommPlus


`S7CommPlusClient` is a separate experimental native backend with bounded object
Explore, native DB/I/Q/M type-member discovery and typed symbolic reads. It supports
session-local name resolution after explicit block or area discovery. Explicit legacy
S7-1200 SessionKey sessions and TLS sessions are supported; username/password
legitimation, S7-1500 legacy keys and PLCSIM key families remain unsupported.
The verified TLS V2 profile
also supports bounded native program-content attribute extraction, returning
in-memory files; this is not a full-controller or restorable backup.
DAQ and REST/WebSocket value APIs remain classic S7Comm paths. The separate
[transparent proxy mode](#transparent-s7commplus-forwarding) can transport Plus
without providing native decoding, acquisition or a public subscription API.

### Native API Reference

| Workflow | API / Section | Status And Limits |
| --- | --- | --- |
| Session setup | `connect()`, `disconnect()`, `report`; [security](#security-and-sessions) | Explicit TLS or supported legacy profile; no automatic reconnect or downgrade. |
| DB/type discovery | `listDataBlocks()`, `getBlockMetadata()`, `getTypeInfo()`, `listBlockMembers()`; [symbol discovery](#native-symbol-discovery) | Bounded, session-cached metadata; not proof of running program revision. |
| Process-area discovery | `getAreaMetadata()`, `listAreaMembers()`; [I/Q/M](#iqm-exploration) | Native symbolic descriptors; not fabricated absolute addresses. |
| Values | `readMember()`, `readMembers()`, `readSymbol()`, `readSymbolic()`; [batch reads](#batch-value-reads) | RUN required; discovered member descriptors belong to one client session. |
| CPU/communication snapshots | `readCpuState()`, `readCommunicationResources()`; [resources](#communication-resources) | Fresh bounded reads; resource counts do not establish safe connection capacity. |
| Alarm snapshot | `readActiveAlarms()`; [alarms](#current-alarm-diagnostics) | Current/update-relevant service, not diagnostic history or acknowledgement. |
| Program metadata | `listProgramBlocks()`, `readProgramEventMetadata()`, `explore()`; [events](#native-software-event-metadata) | Native identities, attributes and relations; not executable equivalence or execution history. |
| Program content | `uploadProgramBlock()`, `uploadProgram()`; [content](#native-program-content-as-in-memory-files) | Restricted verified-TLS profile; in-memory components, not a restorable backup. `uploadBlock()` remains unsupported. |
| CPU control | `cpuStart()`; [explicit RUN](#explicit-cpu-start) | Confirmed RUN only. STOP, reset, generic writes, force and downloads remain denied. |
| Concurrency | [Independent HMI sessions](#concurrent-hmi-sessions) | One in-flight request per client, bounded FIFO; separate clients for parallel traffic. |
| Push acquisition | [Offline notification foundation](#offline-data-notification-foundation) | Parser, owned routing and lifecycle adapter tested offline; no public live subscription API or wire adapter. |
| Sampling measurements | [Benchmark API/CLI](#parallel-sampling-and-stress-measurement) | Explicit finite workload; polling is neither push nor scan-synchronous acquisition. |

### Security And Sessions

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

### Native Budgets

The current source uses the following client limits. All budgets remain active
independently; increasing the object limit does not increase response bytes,
session duration or the request budget.

| Limit | Default | Maximum accepted |
| --- | ---: | ---: |
| `limits.maxObjects` | 65,536 | 262,144 |
| `limits.maxDepth` | 256 | 1,024 |
| `limits.maxResponseBytes` | 65,536 bytes | 16,777,216 bytes |
| `limits.maxRequests` | 12 | 10,000,000 |
| `limits.maxConnectionsPerTarget` | 4 | 16 |
| `limits.maxQueuedRequests` | 32 | 4,096 |

The default session ceiling remains 60 seconds, total sent-plus-received transport
budget 262,144 bytes, and minimum pacing 250 ms. Configure larger budgets deliberately
for an authorized acquisition; accepted maxima do not establish safe PLC load
or support for every program size. The earlier live-test budgets below describe
those specific runs, not the current defaults.

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

### Structure Cache

`listBlockMembers()` caches expanded structures per DB and the exact
`maxTypes`/`maxMembers` budgets. Repeating the same discovery skips type traversal
and member expansion and makes no PLC request. Results are returned as isolated
copies with fresh session-local address bindings; changing a returned object
cannot alter the cache. `receivedAt` remains the original metadata receipt time,
not the time of the cache hit. Changing discovery budgets rebuilds the structure
and still enforces the requested limits.

Discover once, retain the readable member arrays, and use only `readMembers()`
inside the scan loop. The cache and compiled read plans belong to that connected
client; no discovery is repeated per scan. After a program download or online
edit, explicitly disconnect and rediscover with a new client. Automatic program
revision detection and cross-session cache import are not implemented. Saved
structure JSON under ignored experimentation is an audit snapshot, not an
authorized source of runtime addresses for a new connection. The explicit local
archive binding API below is separate from native metadata discovery.

### Archive-Backed Members

`bindArchiveMembers(block, members)` registers locally parsed DB declarations in
the connected client without sending inventory, metadata or type queries. It
returns fresh session-owned members usable with `readMember` and `readMembers`.
It does not verify the archive against the loaded program or replace discovery
caches. The caller must select a trusted archive and exact controller scope.

`block` requires `type: 'DB'`, a unique DB number from 1 to 65535, its name and
`objectRid: 0x8A0E0000 + number`. Members use the runtime descriptor shape:
unique paths, qualified scalar `datatype`/`softdatatype`, serialized `memberId`
and ordered `accessPath`, `readable`, `status`, `parentPath`, null `typeInfoId`
and `referencedTypeInfoId`, zero `symbolCrc`, and `arrayDimensions`. No native
type RID is fabricated from archive declaration/definition IDs. Unsupported or
ambiguous declarations must be marked unreadable by the archive mapper.

```js
const bound = client.bindArchiveMembers(archiveBlock, archiveMembers);
const values = await client.readMembers(bound.members.filter(member => member.readable));
```

The returned catalogue has `ARCHIVE_UNVERIFIED` completeness and evidence with
`source: 'ARCHIVE_AST'`, `revisionStatus: 'UNVERIFIED'` and
`runtimeMetadataObserved: false`. Its local binding time is not a PLC metadata
receipt. Actual reads retain normal wire datatype, response correlation and
integrity checks. A GOOD typed value cannot prove archive/executable equivalence:
a stale LID may identify another value of the same type. No fallback discovery,
retry, writes, CPU-mode changes or role changes are performed. Bind again in each
new session; never reuse descriptors from a previous or different client.

### Cached PLC Members

`bindCachedMembers(discovery)` binds previously extracted DB or I/Q/M metadata
in a connected session without inventory or type queries. `discovery.block`
must identify the exact DB RID (`0x8A0E0000 + number`) or I/Q/M RID (80/81/82).
Persist structural member metadata, not protocol evidence, observations or old
handles. Readable entries require unique paths, supported scalar software types
and unambiguous bounded LID access paths. Unreadable unresolved entries remain
unbound. The returned members are fresh session-owned handles.

Evidence is `source: 'PLC_CACHE'`, `revisionStatus: 'UNVERIFIED'` and
`runtimeMetadataObserved: false`. Callers retain the original capture timestamp
and enforce target/profile/scope isolation. Binding does not establish that the
PLC program is unchanged; even a GOOD read may address a different value of the
same type after a download. Refresh explicitly after program changes. No fallback
discovery or writes are performed.

### Batch Value Reads

`readMembers(members)` reads 1..4096 descriptors discovered or explicitly archive/cache-bound by the same connected
client and returns lightweight `{ observation }` entries in input order. Combine
members across DBs to fill packets instead of issuing a small request per DB.
Plans obey the selected item ceiling, complete request-byte budget, and worst-case
response sizes, including STRING capacity. Per-item type checks, response
correlation and transport integrity remain enforced. Well-formed item rejection,
omitted values and supported scalar datatype mismatches are returned for that
member as `quality: 'MISMATCH'`, with expected datatype, actual wire type when
available, status and diagnostic text; they are not cast to the archive datatype.
When a batched service is rejected, the client retries its members individually
and preserves successful values alongside per-member mismatches. Malformed
responses, integrity/correlation failures, timeouts and transport errors remain
fatal and stop the session. An insufficient remaining request budget rejects the
whole plan before its first request.

`readMembers(members, { maxItems: 48 })` explicitly raises the per-request item
ceiling for a separately qualified target; accepted values are 1..64 and the
default stays 32. The 900-byte request ceiling may split batches earlier. The
plan cache includes this setting, so changing it cannot reuse a differently
sized plan. Acceptance by the library is not evidence that a PLC supports that
batch size; rejection stops the client without fallback or retry.

In a connected RUN session with explicit budgets sufficient for discovery and
the intended scans:

```js
const members = [];
for (const block of (await plc.listDataBlocks()).blocks) {
  const discovery = await plc.listBlockMembers({ type: 'DB', number: block.number });
  members.push(...discovery.members.filter(member => member.readable));
}
const chunks = [];
for (let offset = 0; offset < members.length; offset += 4096) {
  chunks.push(members.slice(offset, offset + 4096));
}
async function readScan() {
  const values = [];
  for (const chunk of chunks) values.push(...await plc.readMembers(chunk));
  return values;
}
const first = await readScan();
const next = await readScan();
```

Retain the same chunk arrays to reuse session-local plans. Changed array contents
rebuild the plan; serialized descriptors or descriptors from another session are
not accepted. Returned positions match the original flattened member order.
Discovery diagnostics and unreadable members must still be reported separately;
a successful scan is not proof of an exhaustive or atomic DB snapshot.

`limits.readPacingMs` defaults to 250 ms and applies specifically to multi-item
reads. Values down to 10 ms are accepted only by explicit configuration; discovery
and session housekeeping retain `limits.pacingMs` (minimum 250 ms). There is still
one outstanding request per client. Lower pacing must be qualified against PLC
load and latency, not enabled by removing safety limits. The default 12-request,
60-second session remains a bounded acquisition, not an unlimited DAQ service.

An authorized TLS test inventoried 96 DBs and read all 1109 discovered leaf values,
including 15 STRINGs, in 35 cross-DB requests per scan. Values came from 95 DBs;
one inventoried DB lacked complete member-name metadata and could not be read.
Three scans at 10 ms read
pacing took 2.75..2.79 seconds each (397..404 values/s); cold discovery took about
35 seconds separately. The PLC remained RUN and certificate trust was explicitly
unverified. These measurements do not establish safe load on other controllers,
complete program coverage or restorable backup capability. Exact target details,
per-DB values and Markdown reports remain under gitignored `experimentation/`.

A subsequent single-session qualification reused the same 96-DB structure and
1109 readable values. Retrieving every expanded structure from cache took 55 ms
and zero PLC requests, versus about 35 seconds for initial discovery. Three
32-item scans averaged 408 values/s in 35 requests each; three 48-item scans
averaged 474 values/s in 24 requests each, a 16.3% improvement. The subsequent
64-item request was rejected and the session disconnected without retry. RUN
was confirmed after each successful scan, not after that rejection. Coverage
remained 95 readable DBs with one incomplete member-name metadata result;
certificate trust remained unverified. These results do not qualify a universal
item limit or establish PLC load safety.

An ordering comparison then ran five interleaved scans each with input order,
numeric DB RID/LID order, and response-size balancing. All scans read the same
1109 values in 24 requests, with RUN confirmed between scans and at completion.
Aggregate throughput was 477 values/s for input order, 472 for RID ordering and
474 for balancing. All 360 read replies used a single inbound TPKT frame, so
the predicted fragmentation bottleneck was absent. The small differences do
not establish a meaningful ordering advantage. The production planner retains
input order; the ordering prototype and exact evidence remain only in ignored
experimentation, not the packaged library. Worst-case STRING capacity estimates
are allocation bounds, not measurements of actual reply length.

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

<a id="native-iqm-exploration"></a>

### I/Q/M Exploration

On an explicitly connected `S7CommPlusClient`, select inputs (`I`), outputs (`Q`)
or marker memory (`M`). These are native symbolic tags, not an absolute-byte scan
and not a list manufactured from offline project declarations.

```js
const discovery = await client.listAreaMembers({ type: 'I' }, {
  maxTypes: 8,
  maxMembers: 4096,
});

console.log(discovery.area, discovery.completeness, discovery.diagnostics);
const member = discovery.members.find(candidate => candidate.readable);
if (member) {
  const sample = await client.readMember(member);
  console.log(sample.observation);
}
```

`getAreaMetadata({ type: 'Q' })` returns the area's `type`, `name`, native
`objectRid`, actual `typeInfoId` (or null), status and type-reference evidence.
Area RIDs are I=80, Q=81 and M=82; the client reads LID 1 rather than assuming a
type-info RID. No DB inventory request is needed. `listAreaMembers` adds
`members`, `diagnostics`, `completeness`, native type evidence and `receivedAt`,
with root metadata under `area` rather than `block`.

The existing scalar type and nested/array rules apply. Default discovery budgets
are 8 types and 4096 expanded members, with maxima 65536 and 1048576 respectively;
session request/byte/time limits still apply. Missing types remain partial, and
unsupported/ambiguous members are not readable. Decoded native layout metadata
remains in `evidence`; the API does not invent absolute byte/bit locations or
validate the running program revision.

Readable descriptors also work with `readMembers`, including mixed DB/I/Q/M
batches (at most 4096 members/call). `readSymbol('I.TagName')`, `Q.TagName` and
`M.TagName` resolve only after the corresponding area has been discovered.
Names that conflict with a discovered DB remain ambiguous, never silently
preferred. Scalar samples retain the existing `block` root-metadata field,
whose `type` may now be I/Q/M and which has no DB `number` for those areas.
Caller edits do not change the native address bound to a descriptor; copies and
descriptors from another session are rejected.

Metadata exploration is allowed in RUN or STOP. Process-value reads require RUN;
no mode change or process write is issued. Results are defensively cloned and
cached only within this client session, not continuously revision-refreshed.
The portal and benchmark lane selector remain DB-only. In addition to loopback
tests, one bounded CPU1212C V4.5 run discovered 2 input, 8 output and 14 marker
tags and obtained 33 GOOD BOOL/BYTE observations through batch, scalar,
qualified-name and mixed-area reads. The historical certificate fingerprint
matched, but TLS remained unverified. RUN was confirmed before disconnect;
a post-close ECONNRESET was retained as a teardown warning. No process writes,
mode changes or retries were issued. This is scoped functional evidence, not
general datatype, throughput or scan-synchronous qualification.

`disconnect()` cancels pending and queued calls with `DISCONNECTED`. An
`ECONNRESET` received after explicit disconnect begins is retained separately
in `report.teardownWarning` (`null` on clean close), not promoted to
`report.failure`. Earlier failures remain authoritative; resets during setup
or active reads still fail the session. Shutdown remains bounded and does not
retry or issue `DeleteObject`. This classifies a teardown reset without proving
or preventing its PLC-side cause.

<a id="native-communication-resources"></a>

### Communication Resources

On a connected native `S7CommPlusClient` in RUN or STOP:

```js
const snapshot = await client.readCommunicationResources();
console.log(snapshot.counters.tagsPerReadRequestMax);
console.log(snapshot.counters.subscriptionsFree);
```

One eight-item `GetMultiVariables` request reads root RID 201, SystemLimits
subarea 1037 (LIDs 1000, 1001, 0, 1, 2) and FreeItems subarea 1081
(LIDs 0, 1, 2). Every call is fresh, not cached. Counters are
`tagsPerReadRequestMax`, `tagsPerWriteRequestMax`, `subscriptionsMax`,
`attributesMax`, `subscriptionMemoryMax`, `subscriptionsFree`, `attributesFree`
and `subscriptionMemoryFree`. Each retains its native address, raw value,
status and error code. Rejected, omitted, non-DINT or negative counters have
`value: null`, never a fabricated default; completeness is then `PARTIAL`.
Malformed lists, integrity failures and transport failures still stop the session.
Request timing/correlation is retained; no PLC timestamp or atomic snapshot is
claimed. The capability getter indicates API availability, not that a CPU has
returned every counter successfully.

The item-limit read/write interpretation follows the pinned independent
reference and remains marked `REFERENCE_ASSUMPTION`. Subscription-memory units
remain `UNKNOWN`; subscription capacity is not TCP/HMI connection capacity.
No batch size, software connection budget or sampling rate is changed
automatically, and reading a write limit does not enable writes.

A bounded CPU1212C V4.5 lab run returned all eight counters: item limits 50/50,
subscriptions maximum/free 40/40, attributes 400/400 and subscription memory
102400/102400 (unit unqualified). Seven total session requests completed, final
state RUN, read-only and disconnected. Historical fingerprint/identity matched
but TLS remained unverified. A late reset was retained as `teardownWarning`,
with no acquisition failure. This does not establish a connection ceiling or
qualify subscriptions, actual write limits or general resource-unit semantics.

<a id="native-current-alarm-diagnostics"></a>

### Current Alarm Diagnostics

On a connected native TLS V2 client in RUN or STOP:

```js
const snapshot = await client.readActiveAlarms({ languageId: 1033, maxAlarms: 128 });
for (const alarm of snapshot.alarms) {
  console.log(alarm.cpuAlarmId, alarm.text, alarm.coming?.timestamp);
}
```

This is one fixed read-only Explore query of alarm subsystem 8, selector 2667,
with ten reference-defined attributes. It does not create a subscription,
acknowledge or clear alarms, change CPU mode, or modify the PLC program.
Only `languageId` (1..65535, default 1033) and `maxAlarms` (1..4096, default 128)
are accepted. Session request, byte, object, depth and duration limits still apply;
the result limit does not reduce the controller's response before decoding.

Records retain lossless decimal alarm IDs, raw state bits, domain/type, sequence,
coming/going timestamps, available language texts and native evidence. Timestamp
nanoseconds are preserved alongside UTC milliseconds and the submillisecond
remainder; PLC clock synchronization is unknown. Missing or unsupported fields
stay null/partial, unknown objects are diagnosed, and local result truncation is
explicit. State-bit meanings, HMI-detail interpretation and associated-value
decoding are not qualified; text placeholders are not expanded. No language is
silently substituted when the requested text is unavailable.

This is the current/update-relevant alarm service, **not the historical CPU
diagnostic buffer**. An empty response does not prove a fault-free history or
coverage of every CPU/system diagnostic source. Alarm subscriptions, fault-buffer
history and CPU cycle/load diagnostics remain unimplemented.

A bounded CPU1212C V4.5 lab query succeeded and returned zero alarm records.
Seven total requests completed; final state RUN, read-only and disconnected.
TLS remained unverified despite matching the historical fingerprint; the late
reset remained a teardown warning with no acquisition failure. This qualifies
the empty-query path on that CPU, not real positive alarm/text/timestamp decoding;
positive records and partial cases currently have verified-TLS loopback coverage.

### Native software-event metadata

Generic `explore` now preserves native object relations as optional
`object.relations: Array<{id:number,targetRid:number}>`. Element `0xA4` carries a
VLQ relation ID and a big-endian UInt32 target RID, independently checked against
the pinned C# reference's `Core/PObject.cs` and `Core/ElementID.cs`. Relations stay
on their owning object, including nested objects; duplicate IDs, truncated fields
and more than 128 relations per object fail closed. Unknown elements still stop
the session. Relation decoding does not automatically follow targets.

`readProgramEventMetadata({maxEvents:128})` turns this into a structured,
read-only RUN/STOP workflow on a connected client. It freshly inventories the
program, requires the observed RID/class/parent/name of `SWEvents`, then reads
only that container. Each event retains its native attributes and relations;
exact target RIDs are resolved to identified blocks from that same inventory.
Unknown targets return `PARTIAL` with diagnostics, and an unadvertised container
returns `NOT_REPORTED_IN_INVENTORY` without a guessed-object query. Exceeding
`maxEvents` (1..128) or receiving a mismatched tree stops the session rather than
silently dropping records. Calls are not cached and never follow relation targets.

```js
const snapshot = await plc.readProgramEventMetadata({ maxEvents: 128 });
for (const event of snapshot.events) console.log(event.name, event.relations);
```

The result includes raw evidence, inventory, controller identity, receipt times,
`atomicSnapshot: false` and `revisionStatus: 'UNKNOWN'`. Resolved targets are
identity matches, not a decoded meaning for every relation ID. Event names do
not establish active faults or prove the corresponding code was executed.

A bounded CPU1212C V4.5 lab read recovered the observed `SWEvents` container and
12 software-event objects. `ProgramCycle` (RID 96) returned relation ID 2057 to
`0x8A320001`, independently matching OB1 `Main` in the same session's inventory.
The other 11 event objects returned no relations. This is native program/event
metadata, not a PLC execution trace, fault history or runtime revision proof.

The observed `RuntimeMeters` object (RID 86/class 7825) returned 14 attributes,
including two native structs. Numeric fields were zero and the Boolean field was
false. Their meanings, units and activation requirements are not qualified; this
is not a typed CPU cycle/load API. The identity-checked nine-request session ended
in RUN and disconnected, with `report.failure: null` and a late ECONNRESET
teardown warning. TLS remained unverified. Program-content security gates below
are unchanged. See the parent runtime report for retained raw evidence.

The structured API was separately qualified on that lab target: eight requests,
12 events and the same exact OB1 link, final RUN/read-only/disconnected, no main
failure and the existing late reset warning. TLS remained unverified. This adds
a usable metadata workflow, not a claim of novel protocol discovery or greater
overall coverage than the reference libraries.

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

**STOP and automatic restart remain unavailable.** Selecting
`stop-required-backup` fails with `EXPLICIT_CPU_STOP_CONFIRMATION_REQUIRED`
without transmission; flags, stored confirmations and automated acknowledgements
cannot enable it. A qualified interactive STOP/backup/restart workflow remains future
work, requiring independent protocol qualification and separately authorized
equipment shutdown/readiness procedures.

Siemens distinguishes RUN-capable software/hardware uploads from the STOP-only
consistent online-device backup in its
[backup options documentation](https://docs.tia.siemens.cloud/r/en-us/v20/creating-a-backup-of-an-s7-cpu/backup-options-for-s7-cpus).
That product documentation does not qualify S7Proxy's missing backup operations.

### Explicit CPU Start

`cpuStart()` is the only mode-changing API. After the operator has authorized
starting the equipment, use a connected TLS V2 client with effective full access
and at least five remaining requests:

```js
const { host, port } = plc.report.target;
const result = await plc.cpuStart({
  confirmRun: true,
  confirmTarget: `${host}:${port}`,
});
console.log(result); // { before: 'STOP', after: 'RUN', commandSent: true, verified: true }
```

The exact target confirmation is required on every call, not stored in constructor
configuration. Verified TLS identity is required by default. An isolated lab
using `tls.allowAnyCertificate: true` additionally requires the explicit per-call
`allowUnverifiedIdentity: true`; its report remains `TLS_UNVERIFIED`. These options
do not establish equipment readiness or authorize production operation.

The client freshly reads state, writes DINT(3) only to CPU object 52 / attribute
2167 using SetVariable and the separate write-integrity counter, then performs up
to three state reads to confirm RUN. An already-running CPU sends no start command.
Acknowledgement alone is not success. The command is never retried, including
after a timeout or lost reply; such failures can leave the actual state unknown.
Other operations cannot interleave with this workflow. The session's
`productionReadOnly` report becomes false when a start command is attempted.
STOP, reset, arbitrary values/addresses and generic writes remain denied.

One isolated CPU 1212C, firmware V4.5, was observed transitioning STOP to RUN on
2026-10-27, with RUN confirmed twice. This is not qualification of other CPU or
security profiles; see the qualification report's CPU-start update.

### Concurrent HMI Sessions

Each client requests `SIMATIC-ROOT-HMI`, with its own socket, TLS context, session
ID, sequence/integrity counters, metadata caches and owned member descriptors.
The transport TSAP does not select or prove the PLC's session role. CreateSession
intentionally omits `ServerSession.Role` (attribute 299): explicitly requesting
value 1 caused a Multi-ES conflict with TIA Portal on the tested controller.
Omitting that attribute allowed the PLC to return role 2 and permitted native
DB/I/Q/M discovery and scalar reads while TIA remained connected. Do not restore
the role-1 request or assume a role transition is required after discovery.
See [TIA Portal coexistence and session roles](docs/S7_READ_ONLY_REPORT.md#tia-portal-coexistence-and-session-roles-2026-10-28)
for the failure signature, evidence, cleanup behavior and qualification limits.

Multiple clients can connect and issue requests in parallel to the same endpoint.
The connection registry is scoped to this loaded module in one Node process and
keyed by case-normalized configured hostname plus port; it does not resolve DNS
aliases or coordinate independent processes. The smallest connection limit among
the new client and active clients governs admission. A new client cannot bypass
an existing client's lower limit by specifying a higher one.

Connecting consumes a slot before TCP setup. Failed handshakes and closed sockets
release only their owned slot. Disconnecting or failing one client does not close
another. Connection-limit rejection occurs before opening a socket and does not
invalidate other sessions. Reconnect still requires an explicit new client after
a connection attempt; there is no automatic reconnect or retry. A client rejected
before reserving a connection slot may retry admission explicitly.

Concurrent calls on one client enter a bounded FIFO request queue. Only one
request is on the wire per session; replies still require exact sequence,
function, protocol-version and integrity correlation. This is not same-socket
request pipelining. Use separate clients for actual parallel requests, and
discover each client's members separately: descriptors cannot cross sessions.
Queued operations and read addresses are snapshotted when submitted.

When the queue is full, the new call rejects with `REQUEST_QUEUE_FULL` without
disconnecting the healthy session or transmitting that request. Disconnect aborts
pacing, rejects active/queued work and prevents later transmission. A transport,
protocol or request-timeout failure rejects that session's remaining queue; other
clients remain independent. Request deadlines start when transmitted; queued work
is also bounded by the overall session deadline. All per-session byte, request,
latency and pacing budgets remain in force.

```js
const client = new S7CommPlusClient({
  host: process.env.PLC_HOST,
  securityMode: 'tls',
  tls: approvedTlsConfiguration,
  limits: { maxConnectionsPerTarget: 4, maxQueuedRequests: 32 },
});
```

`client.report.concurrency` reports the HMI transport identity, endpoint connection count,
queue capacity/current depth, and single in-flight request limit. No pool is
created automatically; the caller owns every client and must disconnect all of
them in cleanup, including failed parallel-connect attempts. The TIA runtime
continues to share its existing session per approved scope rather than opening
connections per UI request.

`client.report.sessionRole` separately reports `{ requested, returned }`.
`requested: null` means the request omitted attribute 299, not that the PLC has
no role. `returned` is the unambiguous scalar role supplied by the PLC, or null
when unavailable; the observed value 2 is not a universal firmware guarantee.

CPU start requires an exclusive idle endpoint connection in this process and
blocks additional connection admission while control is active. STOP, reset and
generic writes remain denied. These local guards cannot detect a TIA Portal
connection or a different process. HMI transport identity alone does not
prove PG coexistence or reserve engineering resources on the PLC. The corrected
session payload has bounded coexistence evidence on one controller, not a
guarantee for other firmware, operations or connection order. Connection
caps are library bounds, not measured safe CPU capacity; aggregate traffic can
increase with each session. Qualify load and real TIA online monitoring on the
specific CPU/firmware before increasing production concurrency. Loopback tests
do not establish those hardware guarantees.

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

### Offline Data Notification Foundation

This is **not live subscription support**. The internal `decodeDataNotification`
and `DataNotificationBuffer` modules accept already assembled V2 bodies offline.
`PlusReceiveRouter` is the native client's single application dispatcher: replies
retain the existing sequence/function/integrity checks; notifications require a
session-local owner token. No live owner registration API or lifecycle wire adapter
is enabled, so unsolicited live notifications still fail closed. No outgoing
operation was added and the 22 named native client methods are unchanged.

The supported format is opcode `0x33`, owner RID, the six-byte `040000000000`
marker, credit tick, UInt32-VLQ sequence, change counter/optional timestamp and
terminated item records. Status `0x92` uses a fixed UInt32 reference, `0x9B` a VLQ
reference; `0x03`/`0x13` retain explicit item errors without inventing values.
Registered references and the expected owner/change counter must match. Unknown
statuses, markers, versions, duplicate references, truncation and trailing bytes
(including possible alarm extensions) are rejected, not silently skipped.
Timestamps remain lossless decimal strings with unqualified reference-microsecond
semantics; they are not qualified scan times. Each result is a delta, not a full
snapshot or evidence that omitted members are freshly GOOD.

Limits are 1..4096 items and 16..1048576 body bytes (defaults: registered reference
count and 262144 bytes). The buffer defaults to 16 slots and 1048576 retained
wire-body bytes; maxima are 128 slots and 16777216 bytes. This byte accounting is
not a total JavaScript heap measurement. Overflow drops oldest updates and counts
them explicitly. Gaps, reordering/ambiguous sequence distances and overflow leave
a sticky resynchronization requirement. Duplicates are counted and rejected.
UInt32 modular sequence ordering/wrap is an **offline reference assumption**, not
hardware qualification. A new buffer does not establish an initial value baseline;
close discards queued deltas and rejects further input. Caller-supplied owner fields
are not proof of live session ownership.

`OwnedSubscriptionSession` is an **offline lifecycle adapter**, not a public PLC
subscription API. Its trusted adapter supplies create/renew/delete-owned/transport-
abort operations; no wire encoder or live authorization is supplied. The adapter
must serialize qualified requests, validate actual PLC response ownership and stop
the transport when aborted. The helper validates receipt session/container IDs,
child RID uniqueness and opaque handle identity. It never accepts a caller's RID
as a deletion command, deletes a container, or guesses an object after uncertain
creation. RIDs cannot be reused within one generation; at most 16 handles may be
issued. A new session requires explicit recreation and a new baseline, not replay
of old handles or automatic restoration.

Finite credits use a deliberately narrow **unqualified reference assumption**:
zero-based ticks below an acknowledged boundary, 1..254 total credits before
rollover. Initial grants default to 10; explicit renewal only commits after an
acknowledgement. Unlimited credits, rollover and automatic replenishment are
rejected. Gaps consume the observed tick distance; duplicates do not extend
freshness or consume a second credit. Invalid credit windows abort the transport.
Reported states include `AWAITING_INITIAL`, `CREDIT_EXHAUSTED`, `STALE`,
`RESYNC_REQUIRED`, `RECENT_DELTA_NOT_GOOD` and `CLOSED`; quality remains `UNKNOWN`.
Silence is checked using a monotonic clock (default 3000 ms) whenever diagnostics
are requested; it is not an autonomous staleness event or a PLC timestamp.

Lifecycle calls have bounded deadlines (default 1000 ms, configurable 1..60000 ms).
Pre-cancelled creation sends nothing; cancellation/timeout after transmission or
an uncertain acknowledgement aborts without speculative deletion. Normal close
deletes only acknowledged owned children once, then closes local routing; the
adapter owner remains responsible for its transport's final normal close.
Known deltas arriving during deletion are parsed and counted as discarded, never
queued as fresh samples. Cleanup failure is retained, aborts transport and is not
retried. Alarm notifications, scan-time/quality qualification and a live lifecycle
adapter remain unimplemented.

<a id="native-parallel-sampling-and-stress-measurement"></a>

### Parallel Sampling And Stress Measurement

`src/client/s7commplus-benchmark.js` exports `runS7CommPlusBenchmark(config,
{ signal, onRecord })`. It opens **one independent native session per lane**,
discovers that session's own descriptors, then starts all lanes on a shared host
monotonic clock. It does not use a single connection's queue as a connection pool.
Each explicit stage gets fresh sessions; discovery is excluded from sampling
rates. A failure stops sibling traffic and prevents later stages. There are no
automatic retries, reconnects, writes, CPU mode changes or transport fallbacks.

The [example plan](examples/s7commplus-benchmark.json) selects DB1 and DB2. It
progressively reduces native read pacing from 50 to 20 to 10 ms, while a second
connection samples numeric members every 500 ms. Its final stage adds a second
boolean reader of the **same members** to measure replicated traffic load, not
sharding. Review DB selection, stages and bounds for the authorized test target
before use. Read-only traffic can still affect PLC communications and scan time.
This example has **not** been qualified as safe or sustainable on a real CPU.

From this repository, with the authorized CA path and independently approved
certificate SHA256 in `S7PLUS_TLS_CA` and `S7PLUS_TLS_CERT_SHA256`:

```bash
node src/plus-benchmark.js --live --acknowledge-load --host 192.168.1.200 \
  --tls --config examples/s7commplus-benchmark.json --output trace.ndjson
```

Use only an explicitly authorized test PLC. Both `--live` and
`--acknowledge-load` are mandatory; there is no implicit production endpoint.
`--legacy` selects legacy explicitly. TLS uses the same CA, servername and pin
environment variables as `plus-explore.js`; `--allow-any-certificate` explicitly
disables authentication and records `TLS_UNVERIFIED`. `--tls-min-version` accepts
`TLSv1.2` or `TLSv1.3`. SIGINT/SIGTERM cancels owned sessions. Existing output
files are never overwritten, and an output-open failure occurs before connection.

Plan fields and hard bounds:

- `dbNumbers`: explicit unique DB numbers, up to `maxBlocks` (default 64, maximum
  256). All readable supported scalar members of the selected type are included;
  there is no silent truncation. Empty selections or incomplete structures fail.
  This harness currently selects DB members, not I/Q/M process-area tags.
- `stages`: 1..32 uniquely named stages, `durationMs` 50..60000 each, at most
  300000 ms of sampling total. Setup has a separate `startupTimeoutMs`, default
  30000 and maximum 120000 per stage.
- Each lane specifies unique `id`, `type` (`boolean` or `numeric`) and `periodMs`.
  Zero means back-to-back complete sweeps, still respecting native pacing;
  otherwise 1..60000 ms is an absolute sweep-start schedule. Overdue slots are
  skipped, never replayed as catch-up bursts.
- `readPacingMs`: 10..5000, default 10; this is a minimum request interval, not a
  PLC sample-time or achievable-rate guarantee. `maxItems`: 1..64, default 32.
  The existing response/request byte planners can split batches further.
  `maxMembers`: 1..4096 per lane, default 4096.
- `maxConnectionsPerTarget`: default 4, maximum 16, subject to the native
  process-local endpoint admission limit. Each lane needs its own slot.
- `maxRequestsPerLane`: default 20000, maximum 100000, including setup;
  `maxSweepsPerLane`: default 10000, maximum 100000. Exhaustion fails the run;
  it does not silently declare the requested duration completed.
- `maxLatencyMs`: default 1000, maximum 5000. Existing native latency, request
  timeout, integrity and CPU RUN checks remain active. Each lane also has a
  64 MiB session byte budget and 4 MiB response budget.
- Optional `reference: { archiveSha256, controllerKey }` records an offline
  project reference, **not** a verified runtime revision or approved AST match.

The NDJSON trace contains `run`, per-lane `manifest`, `sweep`, `stage` and final
`summary` records. A manifest records ordered member identities (DB number/name,
path, datatype, RID, type IDs, LID path and metadata CRC), security profile and
certificate fingerprint. Sweep values use that exact manifest order and identify
their request sequence; each request retains its monotonic send/receive window,
integrity ID and application byte counts. Sequence IDs are session-scoped and can
wrap; join using run, stage, lane and sweep, not sequence alone. BigInts serialize
as `{ "encoding": "bigint", "decimal": "..." }` rather than losing precision.
`performance.timeOrigin` in the run record relates host monotonic timestamps to
host Unix time; it does not synchronize the host with the PLC.

Each lane reports request/sweep/value throughput, byte throughput, skipped periods,
response deadline overruns, and min/max/mean/stddev/p50/p95/p99 distributions:

- `wirePeriodMs`: actual host application-send intervals, including inter-sweep
  gaps; `wirePeriodDeltaMs` measures consecutive interval differences (jitter).
- `latencyMs`: application send to complete assembled response, excluding queued
  pacing. These are host observations, not NIC timestamps or PLC execution time.
- `sweepPeriodMs`, signed `sweepPeriodErrorMs` against a nonzero target period,
  and consecutive `sweepPeriodDeltaMs` distinguish full-set cadence from batches.
- `scheduleLatenessMs`, `sweepWindowMs` and `outputWaitMs` expose scheduling
  delay, inter-batch acquisition span and trace sink backpressure separately.

`requestBytes` measures native application request frames; `responseBytes`
measures assembled response bodies. They are **not** symmetric full TCP/TLS
wire-byte counts. `sessionStatistics` includes setup and the client's transport
counters; it is separate from sampling-only application throughput.

`COMPLETED` means the bounded workload finished without acquisition errors, not
that it met real-time requirements. `periodicScheduleMet` requires no skipped
periods or response deadline overruns and is null for fastest-mode lanes. Compare
p99/max lateness, period error and sweep windows against the diagnostic tolerance
and shortest event duration; an acceptable rate must also be qualified against
PLC scan/communications load on the real machine. No rate automatically earns a
"reliable" or "safe" classification. Stop escalation on protocol/latency failures;
deadline misses are retained so the capacity boundary remains visible.

The CLI serializes records through bounded stream backpressure; output cost is
part of the measured workload. `--max-trace-bytes` defaults to 134217728 (128 MiB),
maximum 1073741824. A full budget, disk/write error or interrupted run can leave
a **partial** trace; require a successful final summary before treating it as
complete. The library stores bounded timing arrays, not an unbounded value history;
custom `onRecord` sinks must resolve/reject promptly and honor their own storage
budgets. Without a sink the library returns metrics but does not retain values.

**Diagnostic limit:** a response window is not a PLC scan timestamp, and a
multi-batch sweep is not atomic. Fast transitions can occur entirely between
polls. Offline AST/rung rules may correlate sampled declarations, but polling
cannot prove rung power, event order within a scan, absence of short pulses or an
exact state transition time. Scan-synchronous guarantees require PLC-side trace,
timestamps/counters or an explicitly qualified acquisition mechanism. The portal
shared polling driver is unchanged; this is a separate native benchmark API/CLI.

## Struct Types

The **classic S7Comm struct codec** supports the types below. These are explicit
application-supplied DB layouts, not native Plus datatype/discovery guarantees.

| Type | Size | Notes |
|------|------|-------|
| `BOOL` / `BIT` | 1 bit | Bit-packed with S7 alignment |
| `BYTE` / `CHAR` / `SINT` / `USINT` | 1 byte | |
| `INT` / `UINT` / `WORD` / `S5TIME` | 2 bytes | |
| `DINT` / `UDINT` / `DWORD` / `REAL` / `FLOAT` / `TIME` / `TIMER` | 4 bytes | |
| `LREAL` / `DOUBLE` | 8 bytes | |
| `STRING` | 2 + strlen | Use `strlen` property (default 254) |
| `IEC_TIMER` | 16 bytes | Decoded as flat sub-fields |

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

These endpoints belong to the **classic S7Comm services**, not the native Plus
client. All endpoints are under the configured web API port (default 8080).
Subscriptions schedule polling; they do not create native PLC push subscriptions.

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

Connect to `ws://host:8080/ws` on the **classic S7Comm web service**. Individual
messages are JSON; the transcripts below show client (`->`) and server (`<-`)
directions and abbreviated payloads. Subscriptions are polling-based.

### Subscribe to raw tags

```text
-> { "type": "subscribe", "targetId": "plc1", "tags": [...], "intervalMs": 500 }
<- { "type": "subscribed", "subscriptionId": "...", "tags": 3 }
<- { "type": "data", "subscriptionId": "...", "tags": [...] }
```

### Subscribe to structs

```text
-> { "type": "register-struct", "name": "Motor", "db": 10, "items": [...] }
<- { "type": "struct-registered", "name": "Motor", "size": 20 }

-> { "type": "subscribe-struct", "name": "Motor", "targetId": "plc1", "intervalMs": 500 }
<- { "type": "struct-subscribed", "subscriptionId": "..." }
<- { "type": "struct-data", "struct": "Motor", "values": { "speed": 1200.5 }, "timestamp": ... }
```

### Read/write structs

```text
-> { "type": "read-struct", "name": "Motor", "keys": ["speed"] }
<- { "type": "struct-data", "struct": "Motor", "values": { "speed": 1200.5 } }

-> { "type": "write-struct", "name": "Motor", "values": { "speed": 1500 } }
<- { "type": "struct-written", "struct": "Motor" }
```

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

# Focused native subscription fixtures (offline only)
npm test -- --configLoader runner test/unit/s7commplus.test.js -t 'offline owned subscription lifecycle|owned subscription receive routing'

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
  client/        Classic connections/pool; separate native Plus client/benchmark
  compat/        node-snap7 drop-in replacements
  daq/           Data acquisition, scan groups, caching
  logging/       Lightweight structured logger
  metrics/       Lightweight Prometheus text collector
  protocol/      Classic codecs; s7commplus/ codecs, policy and offline lifecycle
  router/        S7Comm proxy routing
  server/        TCP listener, client sessions
  wasm/          WASM loader, bridge, imports
test/
  unit/          Unit tests
  integration/   Integration tests
  samples/       Real PLC sample scripts
```

## Recent Updates

### 0.4.6 (current source)

- Add `bindCachedMembers(discovery)` to restore serialized DB and I/Q/M structure metadata into fresh session-owned descriptors without inventory, type queries or first-read rediscovery. Persistence and target/profile/scope isolation remain the caller's responsibility; S7Proxy does not provide database storage.
- Validate exact DB/process-area RIDs, supported scalar software types and unique bounded LID addresses. Unreadable entries, including unresolved paths, remain unbound. Old session descriptors are still rejected.
- Mark restored metadata as `PLC_CACHE` with an unverified revision. Binding time is not the original capture time, and successful typed reads do not prove that the PLC program is unchanged. No fallback exploration or writes are performed.
- Add JSON round-trip and cross-session DB/I/Q/M fixture coverage, including reads without exploration and rejection of invalid identities.

### 0.4.5

- Add `bindArchiveMembers(block, members)` for locally parsed DB declarations, returning fresh session-owned descriptors without PLC inventory or metadata queries.
- Require exact DB identity and unambiguous supported scalar LID addresses without fabricated native type identities. Archive bindings remain explicitly `ARCHIVE_UNVERIFIED`; refresh metadata after PLC program changes.

### 0.4.4

- Omit the explicit ServerSession.Role=1 request that caused Multi-ES conflicts with TIA Portal. Full DB/I/Q/M discovery and scalar reads succeeded on the tested controller with TIA connected; other firmware and reverse connection order remain unqualified.
- Report requested and PLC-returned session roles separately from HMI transport identity, with regression coverage and coexistence troubleshooting documentation.

### 0.4.3

- Explicit `listen.mode: "passthrough"` preserves original COTP/S7Comm/Plus and optional end-to-end TLS over dedicated upstream sockets. No classic probes/pool/DAQ, TLS termination, retries or mid-session failover; connection filters and the production raw-forwarding gate remain enforced.
- Fresh native communication-resource and current-alarm snapshots, plus structured software-event metadata with bounded native relations. Current alarms are not diagnostic history; event links are not execution or revision proof.
- Single native receive dispatcher with per-message fragment evidence, strict V2 notification parsing, bounded delta queues and an offline owned lifecycle adapter. Finite credits, staleness, cancellation, cleanup and reconnect isolation are fixture-tested; live subscription wire operations remain disabled.
- Independent native HMI sessions, bounded request queues and an explicit finite sampling benchmark. Neither local connection limits nor measured polling throughput establish safe PLC load or scan-synchronous capture.

### 0.4.2

- Native I/Q/M exploration through `getAreaMetadata({ type: 'I' | 'Q' | 'M' })` and `listAreaMembers(selector, { maxTypes, maxMembers })`. Actual native type references drive bounded expansion; readable descriptors work with existing scalar, batch and qualified-name reads and cannot be shared between sessions.
- Cached DB inventories and expanded member structures within a client session, avoiding repeated inventory requests and structure expansion. Cached discoveries are isolated from caller mutations and preserve their original metadata receipt time. Per-block evidence retains the relevant object's attributes and response correlation instead of the entire inventory.
- More efficient nested-type discovery using indexed lookups and a deduplicated traversal queue, with higher configurable object, depth, response, request and member limits. These are allocation ceilings, not hardware qualification or guarantees of complete discovery.
- Bounded diagnostic history through `limits.maxDiagnosticEntries` (default `128`, maximum `4096`) for each observation/transcript collection. Transcript hex fields retain at most 1024 bytes per entry; reports are diagnostic samples, not guaranteed complete wire captures.
- Cached, response-aware `readMembers()` plans default to 32 symbolic items per request, including members from different DBs. An explicit `maxItems` option supports bounded qualification up to 64; 48-item reads succeeded on the tested target, while its 64-item attempt was rejected. Linear address sizing replaces trial-encoding each growing batch; canonical outgoing checks, fresh integrity counters and HMACs remain active.
- Qualified S7 `STRING` reads validate native byte-array capacity/length headers and preserve the original bytes, exposing a byte-preserving Latin-1 representation. Unsupported string layouts and WSTRING remain explicit rather than guessed.

### 0.4.1

- Separate object-count and nesting-depth limits in the native object decoder, with specific errors identifying which limit was exceeded.

### 0.4.0

- Explicit legacy S7-1200 SessionKey setup and activation, with HMAC-SHA256 verification of requests and response fragments. Legacy traffic is not encrypted and there is no automatic TLS downgrade.
- Explicitly configured PLC hostnames/IPs and ports, optional certificate-validation bypass, TLS 1.2/1.3 negotiation, and a separate TLS handshake deadline. Strict certificate verification remains the default.
- Improved compatibility with composite service-status replies and operation-specific latency checks. Authorized testing obtained one genuine process-value read from each of twelve responding S7-1200 CPUs; other families and security profiles remain unqualified.

## License

MIT
