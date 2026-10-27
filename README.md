# S7Proxy

S7Comm/S7CommPlus proxy and client library with an AssemblyScript WASM protocol engine for classic S7Comm and a separate experimental native S7CommPlus client, read-only by default with explicitly confirmed RUN-only CPU control. Classic S7Comm connects to Siemens S7 PLCs (S7-300/400/1200/1500) over TCP with automatic failover, data acquisition, structured DB access, and a REST/WebSocket API.

## Features

- **WASM protocol engine** — TPKT / COTP / S7Comm PDU serialization compiled from AssemblyScript for near-native performance
- **Connection pooling** — multiple PLC connections with automatic health checks and failover/failback
- **Data acquisition (DAQ)** — subscription-based periodic reads with scan groups, read coalescing, priority queues, and caching
- **Structured DB access** — define PLC data block layouts, read/write as plain JS objects with automatic encode/decode
- **REST + WebSocket API** — lightweight built-in HTTP endpoints and real-time WebSocket push with slow-consumer protection
- **S7Comm proxy** — transparent TCP proxy with TSAP/IP-based routing and allow/deny filtering
- **snap7 compatibility** — `S7Client` read/write subset and `S7Server`; unimplemented metadata, upload and control methods return explicit errors
- **Native S7CommPlus** - experimental TLS and legacy S7-1200 sessions, DB/type discovery, typed symbolic reads, restricted in-memory program-content extraction, and explicitly confirmed TLS CPU start
- **Worker thread mode** — run the proxy in an isolated worker
- **Prometheus metrics** — built-in `/metrics` endpoint

## Install

```bash
npm install s7proxy
```

Requires Node.js >= 20.

## Recent Updates

### 0.4.2 (current source)

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

## Native Parallel Sampling And Stress Measurement

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
| `limits.maxConnectionsPerTarget` | 4 | 16 |
| `limits.maxQueuedRequests` | 32 | 4,096 |

The default session ceiling remains 60 seconds, total received-byte budget
262,144 bytes, and minimum pacing 250 ms. Configure larger budgets deliberately
for an authorized acquisition; accepted maxima do not establish safe PLC load
or support for every program size. The earlier live-test budgets below describe
those specific runs, not the current defaults.

### Concurrent HMI Sessions

Each client requests `SIMATIC-ROOT-HMI`, with its own socket, TLS context, session
ID, sequence/integrity counters, metadata caches and owned member descriptors.
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

`client.report.concurrency` reports the HMI role, endpoint connection count,
queue capacity/current depth, and single in-flight request limit. No pool is
created automatically; the caller owns every client and must disconnect all of
them in cleanup, including failed parallel-connect attempts. The TIA runtime
continues to share its existing session per approved scope rather than opening
connections per UI request.

CPU start requires an exclusive idle endpoint connection in this process and
blocks additional connection admission while control is active. STOP, reset and
generic writes remain denied. These local guards cannot detect a TIA Portal
connection or a different process. HMI identity and concurrency support do not
prove PG coexistence or reserve engineering resources on the PLC. Connection
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

### Structure cache

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
authorized source of runtime addresses for a new connection.

### Batch value reads

`readMembers(members)` reads 1..4096 descriptors discovered by the same connected
client and returns lightweight `{ observation }` entries in input order. Combine
members across DBs to fill packets instead of issuing a small request per DB.
Plans obey the selected item ceiling, complete request-byte budget, and worst-case
response sizes, including STRING capacity. Per-item type checks, response
correlation and transport integrity are unchanged; rejected items or invalid
replies fail closed. An insufficient remaining request budget rejects the whole
plan before its first request.

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
