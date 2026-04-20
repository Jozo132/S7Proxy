# S7Comm Proxy — Node.js + AssemblyScript Architecture Plan

## 1. Project Overview

Build a fully-featured **S7Comm proxy** that sits between S7 clients (SCADA/HMI/PG) and Siemens S7 PLCs. The proxy accepts incoming S7Comm connections, processes/inspects/transforms PDUs, and forwards them to real PLC targets.

**Key differentiator:** The S7Comm protocol engine (PDU serialization, deserialization, TPKT/COTP framing) runs in **AssemblyScript-compiled WebAssembly** for near-native performance, while **Node.js** provides the TCP networking, configuration, and orchestration layer. AssemblyScript modules communicate with the host's native `net` module through WASM imports/exports.

**Reference implementation:** [node-snap7](https://github.com/mathiask88/node-snap7) — the API surface, constants, and protocol behavior are modeled after snap7's Client and Server APIs.

---

## 2. Protocol Stack

```
┌─────────────────────────────┐
│   S7Comm (Application)      │  ← AssemblyScript: PDU encode/decode
├─────────────────────────────┤
│   COTP (ISO 8073, RFC 905)  │  ← AssemblyScript: TPDU framing
├─────────────────────────────┤
│   TPKT (RFC 1006)           │  ← AssemblyScript: 4-byte header parse/build
├─────────────────────────────┤
│   TCP (port 102)            │  ← Node.js net.Server / net.Socket
└─────────────────────────────┘
```

### 2.1 TPKT Layer
- 4-byte header: `Version (0x03)` | `Reserved (0x00)` | `Length (2 bytes, big-endian)`
- Length includes the 4-byte TPKT header itself

### 2.2 COTP Layer (ISO 8073)
- **CR (Connection Request)** — TPDU type `0xE0`
- **CC (Connection Confirm)** — TPDU type `0xD0`
- **DT (Data Transfer)** — TPDU type `0xF0`, last data unit flag
- **DR (Disconnect Request)** — TPDU type `0x80`
- Source/Destination TSAP parameters carry rack/slot addressing

### 2.3 S7Comm Layer
- Protocol ID: `0x32`
- Message types: Job (`0x01`), Ack (`0x02`), AckData (`0x03`), UserData (`0x07`)
- Function codes for Setup Communication (`0xF0`), Read Var (`0x04`), Write Var (`0x05`), Upload/Download, PLC Control, etc.
- PDU negotiation during connection setup (240–960 bytes)

---

## 3. Architecture

```
                    ┌──────────────────────────────────────────────────┐
  S7 Clients        │              S7Proxy (Node.js)                   │         S7 PLCs
  (HMI/SCADA/PG)    │                                                  │
                    │  ┌────────────┐    ┌─────────────────────────┐   │
  ───TCP:102────>   │  │ net.Server │───>│  Session Manager (JS)   │   │
                    │  └────────────┘    └───────────┬─────────────┘   │
                    │                                │                 │
                    │                    ┌───────────▼─────────────┐   │
                    │                    │  WASM Protocol Engine   │   │
                    │                    │  (AssemblyScript)       │   │
                    │                    │                         │   │
                    │                    │  • TPKT codec           │   │
                    │                    │  • COTP codec           │   │
                    │                    │  • S7Comm PDU codec     │   │
                    │                    │  • PDU splitter/merger  │   │
                    │                    │  • Data area helpers    │   │
                    │                    └───────────┬─────────────┘   │
                    │                                │                 │
                    │                    ┌───────────▼─────────────┐   │
                    │                    │  Proxy Router (JS)      │   │
                    │                    │  • Route by TSAP/IP     │   │
                    │                    │  • Filter / transform   │   │
                    │                    │  • Logging / metrics    │   │
                    │                    └───────────┬─────────────┘   │
                    │                                │                 │
                    │                    ┌───────────▼─────────────┐   │
                    │                    │  net.Socket pool (JS)   │───────> TCP:102
                    │                    └─────────────────────────┘   │
                    │                                ▲                 │
                    │                    ┌───────────┴─────────────┐   │
                    │                    │    Priority Queue (JS)  │   │
                    │                    │    AMQ-aware dispatch   │   │
                    │                    └───┬───────────────┬─────┘   │
                    │                        │               │         │
                    │           ┌────────────┴──┐   ┌────────┴──────┐  │
  REST (HTTP)  ──>  │           │  REST Handler │   │  DAQ Engine   │  │
  WS (subscribe) ─> │           │  single-shot  │   │  scan groups  │  │
                    │           │  read/write   │   │  coalescer    │  │
                    │           └───────────────┘   │  fan-out→WS   │  │
                    │                               └───────────────┘  │
                    └──────────────────────────────────────────────────┘
```

### 3.1 Component Breakdown

| Component | Runtime | Responsibility |
|---|---|---|
| **TCP Listener** | Node.js `net` | Accept inbound S7 client connections on port 102 |
| **Session Manager** | Node.js | Track client sessions, map to PLC connections, handle lifecycle |
| **WASM Protocol Engine** | AssemblyScript → WASM | All protocol encode/decode (TPKT, COTP, S7Comm), PDU splitting, zero-copy buffer ops |
| **Proxy Router** | Node.js | Routing rules, filtering, data transformation, access control |
| **PLC Connection Pool** | Node.js `net` | **Persistent, always-open** outbound connections to PLCs; connection reuse; reconnect/keep-alive; failover to backup endpoints |
| **DAQ Engine** | Node.js | Cyclic scan scheduler with priority queues; coalesces overlapping reads; feeds WS subscribers |
| **Web REST API** | Node.js (Fastify) | HTTP endpoints for single-shot PLC reads/writes from web clients |
| **Web WS API** | Node.js (ws) | WebSocket server for high-speed DAQ subscriptions with per-client tag sets |
| **Config / API** | Node.js | YAML/JSON config, environment overrides,queues; coalesces overlapping reads; feeds WS subscribers |
| **Web REST API** | Node.js (Fastify) | HTTP endpoints for single-shot PLC reads/writes from web clients |
| **Web WS API** | Node.js (ws) | WebSocket server for high-speed DAQ subscriptions with per-client tag sets |
| **Config / API** | Node.js | YAML/JSON config, environment overrides, management interface |

---

## 4. AssemblyScript WASM Module Design

### 4.1 Host ↔ WASM Interface

AssemblyScript cannot call `net.Socket` directly. Instead, Node.js provides **host imports** and the WASM module exposes **exports**.

#### WASM Exports (called by Node.js)

```typescript
// === Memory Management ===
export function allocBuffer(size: u32): usize;           // Allocate in WASM linear memory
export function freeBuffer(ptr: usize): void;            // Free WASM buffer

// === TPKT Layer ===
export function tpkt_parse(ptr: usize, len: u32): i32;   // Parse TPKT, return payload offset or error
export function tpkt_build(payloadLen: u16, outPtr: usize): u32; // Build TPKT header

// === COTP Layer ===
export function cotp_parse(ptr: usize, len: u32): i32;   // Parse COTP TPDU
export function cotp_buildCR(srcTsap: u16, dstTsap: u16, outPtr: usize): u32;
export function cotp_buildCC(srcRef: u16, dstRef: u16, outPtr: usize): u32;
export function cotp_buildDT(lastUnit: bool, outPtr: usize): u32;

// === S7Comm Layer ===
export function s7_parse(ptr: usize, len: u32): i32;     // Parse S7 PDU header + params
export function s7_getMessageType(): u8;                   // After parse: msg type
export function s7_getFunctionCode(): u8;                  // After parse: function code
export function s7_getParameterLength(): u16;
export function s7_getDataLength(): u16;
export function s7_getErrorClass(): u8;
export function s7_getErrorCode(): u8;

// === S7 PDU Builders ===
export function s7_buildSetupComm(maxAmqCalling: u16, maxAmqCalled: u16, pduSize: u16, outPtr: usize): u32;
export function s7_buildReadRequest(area: u8, dbNum: u16, start: u32, amount: u16, wordLen: u8, outPtr: usize): u32;
export function s7_buildWriteRequest(area: u8, dbNum: u16, start: u32, amount: u16, wordLen: u8, dataPtr: usize, dataLen: u32, outPtr: usize): u32;
export function s7_buildMultiReadRequest(itemsPtr: usize, itemCount: u32, outPtr: usize): u32;
export function s7_buildMultiWriteRequest(itemsPtr: usize, itemCount: u32, outPtr: usize): u32;

// === PDU Splitting ===
export function pdu_needsSplit(totalDataLen: u32, maxPduSize: u16): bool;
export function pdu_split(ptr: usize, len: u32, maxPduSize: u16, outPtrsArray: usize): u32;  // Returns chunk count
export function pdu_merge(ptrsArray: usize, count: u32, outPtr: usize): u32;

// === Full Frame Assembly ===
export function frame_build(cotpPtr: usize, cotpLen: u32, s7Ptr: usize, s7Len: u32, outPtr: usize): u32;
export function frame_parse(ptr: usize, len: u32): i32;  // Full TPKT+COTP+S7 parse

// === Utility ===
export function getLastError(): i32;
export function getErrorText(code: i32, outPtr: usize): u32;
```

#### Host Imports (provided by Node.js to WASM)

```typescript
// Logging (WASM → Node.js)
function log_debug(ptr: usize, len: u32): void;
function log_error(ptr: usize, len: u32): void;

// Timestamp
function now_ms(): f64;

// Memory growth notification
function memory_grown(oldPages: u32, newPages: u32): void;
```

### 4.2 Shared Memory Strategy

```
┌─────────────────────────────────────┐
│       WASM Linear Memory            │
│                                     │
│  ┌──────────┐  ┌──────────────────┐ │
│  │ RX Ring  │  │ TX Ring          │ │
│  │ Buffer   │  │ Buffer           │ │
│  │ (64 KB)  │  │ (64 KB)          │ │
│  └──────────┘  └──────────────────┘ │
│  ┌──────────────────────────────┐   │
│  │ Parse State / Scratch Area   │   │
│  │ (16 KB)                      │   │
│  └──────────────────────────────┘   │
│  ┌──────────────────────────────┐   │
│  │ General Heap                 │   │
│  └──────────────────────────────┘   │
└─────────────────────────────────────┘
```

- Node.js writes incoming TCP data into the **RX ring buffer** region of WASM memory
- WASM parses in-place, writes outbound frames to the **TX ring buffer**
- Node.js reads from TX ring and sends via `socket.write()`
- This avoids repeated `ArrayBuffer` copies between JS and WASM

### 4.3 AssemblyScript Project Structure

```
assembly/
├── index.ts              # WASM entry point, exports
├── tpkt.ts               # TPKT header encode/decode
├── cotp.ts               # COTP TPDU encode/decode (CR/CC/DT/DR)
├── s7comm.ts             # S7Comm PDU header + parameter parsing
├── s7-functions/
│   ├── setup-comm.ts     # Setup Communication (0xF0)
│   ├── read-var.ts       # Read Var (0x04)
│   ├── write-var.ts      # Write Var (0x05)
│   ├── upload.ts         # Upload block (0x1E)
│   ├── download.ts       # Download block (0x1A)
│   ├── plc-control.ts    # PLC control (start/stop) (0x28)
│   ├── plc-stop.ts       # PLC stop (0x29)
│   ├── szl.ts            # Read SZL (userdata)
│   ├── security.ts       # Password functions
│   ├── datetime.ts       # Clock read/write
│   └── directory.ts      # Block list / block info
├── pdu-splitter.ts       # PDU split/merge for large transfers
├── ring-buffer.ts        # Ring buffer implementation
├── constants.ts          # Area codes, word lengths, error codes, function codes
├── error.ts              # Error code definitions and text
└── memory.ts             # WASM memory allocator helpers
```

---

## 5. Node.js Layer Design

### 5.1 Project Structure

```
src/
├── index.ts                  # Entry point
├── config.ts                 # Configuration loader (YAML/JSON/env)
├── proxy-server.ts           # Main proxy orchestrator
├── server/
│   ├── tcp-listener.ts       # net.createServer, accept clients
│   └── client-session.ts     # Per-client session state machine
├── client/
│   ├── plc-connection.ts     # Outbound connection to PLC
│   ├── connection-pool.ts    # Pool of PLC connections with reconnect
│   ├── failover-manager.ts   # Health monitoring, failover/failback state machine
│   └── health-probe.ts       # TCP connect probe for endpoint liveness
├── wasm/
│   ├── loader.ts             # Load & instantiate WASM module
│   ├── bridge.ts             # JS ↔ WASM bridge: buffer copy, call exports
│   └── imports.ts            # Host import functions provided to WASM
├── router/
│   ├── router.ts             # Route client TSAP → PLC target
│   ├── filter.ts             # Read/write access control filters
│   └── transform.ts          # Data transformation hooks
├── protocol/
│   ├── frame-assembler.ts    # Fastify REST server (management + data API)
│   ├── rest-routes/
│   │   ├── plc-data.ts       # GET/POST /api/plc/:target/read, /write (single-shot)
│   │   ├── daq.ts            # DAQ subscription management via REST
│   │   ├── targets.ts        # Target health, failover control
│   │   └── management.ts     # Config, sessions, metrics endpoints
│   ├── ws-server.ts          # WebSocket server for DAQ subscriptions
│   └── ws-handler.ts         # Per-WS-client subscription state, auth, message protocol
├── daq/
│   ├── daq-engine.ts         # Core DAQ scheduler: scan groups, cycle management
│   ├── scan-group.ts         # A set of tags sharing one scan rate + priority
│   ├── tag-registry.ts       # Central registry of all subscribed tags, dedup, ref-count
│   ├── read-coalescer.ts     # Merge overlapping/adjacent reads into minimal PDU requests
│   ├── priority-queue.ts     # Priority-aware request queue for PLC connection access
│   └── data-cache.ts         # Latest-value cache with timestamps per tag
├── api/
│   ├── rest-server.ts        # Fastify REST server (management + data API)
│   ├── rest-routes/
│   │   ├── plc-data.ts       # GET/POST /api/plc/:target/read, /write (single-shot)
│   │   ├── daq.ts            # DAQ subscription management via REST
│   │   ├── targets.ts        # Target health, failover control
│   │   └── management.ts     # Config, sessions, metrics endpoints
│   ├── ws-server.ts          # WebSocket server for DAQ subscriptions
│   └── ws-handler.ts         # Per-WS-client subscription state, auth, message protocol
├── daq/
│   ├── daq-engine.ts         # Core DAQ scheduler: scan groups, cycle management
│   ├── scan-group.ts         # A set of tags sharing one scan rate + priority
│   ├── tag-registry.ts       # Central registry of all subscribed tags, dedup, ref-count
│   ├── read-coalescer.ts     # Merge overlapping/adjacent reads into minimal PDU requests
│   ├── priority-queue.ts     # Priority-aware request queue for PLC connection access
│   └── data-cache.ts         # Latest-value cache with timestamps per tag
├── logging/
│   └── logger.ts             # Structured logging (pino/winston)
└── metrics/
    └── metrics.ts            # Prometheus-compatible metrics
```

### 5.2 TCP Stream → Frame Assembly (Node.js side)

TCP delivers a byte stream — TPKT frames can span multiple `data` events or be coalesced. The **frame assembler** must buffer and emit complete frames:

```typescript
class FrameAssembler {
  private buffer: Buffer = Buffer.alloc(0);

  feed(data: Buffer): Buffer[] {
    this.buffer = Buffer.concat([this.buffer, data]);
    const frames: Buffer[] = [];
    while (this.buffer.length >= 4) {
      const tpktLen = this.buffer.readUInt16BE(2);
      if (this.buffer.length < tpktLen) break;
      frames.push(this.buffer.subarray(0, tpktLen));
      this.buffer = this.buffer.subarray(tpktLen);
    }
    return frames;
  }
}
```

### 5.3 Client Session State Machine

```
  [NEW] ──TCP connect──> [CONNECTED]
                              │
                     COTP CR received
                              │
                              ▼
                        [COTP_PENDING]
                              │
                      COTP CC forwarded
                              │
                              ▼
                        [S7_SETUP_PENDING]
                              │
                    S7 Setup Comm negotiated
                              │
                              ▼
                        [ESTABLISHED]
                              │
                     S7 data exchange
                              │
                    disconnect / error
                              │
                              ▼
                        [CLOSED]
```

### 5.4 Connection Pool (PLC-side)

```typescript
interface PlcEndpoint {
  ip: string;
  rack: number;
  slot: number;
}

interface PlcTarget {
  id: string;                          // Logical target name e.g. "plc-line1"
  primary: PlcEndpoint;                // Primary PLC IP/rack/slot
  backups?: PlcEndpoint[];             // Ordered backup endpoints (same PLC, alt network paths)
  maxConnections: number;
  failover?: FailoverConfig;           // Optional failover tuning
}

interface FailoverConfig {
  healthCheckIntervalMs: number;       // How often to probe the active endpoint (default: 2000)
  healthCheckTimeoutMs: number;        // TCP connect timeout for probe (default: 1000)
  failoverThreshold: number;           // Consecutive failures before switching (default: 3)
  failbackMode: 'auto' | 'manual';    // Auto-return to primary when it recovers, or stay on backup
  failbackDelayMs: number;             // Wait time before auto-failback (default: 10000)
  failbackThreshold: number;           // Consecutive primary successes before switching back (default: 3)
}

class ConnectionPool {
  /** Establish persistent, always-open connections to target at startup */
  bootstrap(target: PlcTarget): Promise<void>;
  /** Get a connection with a free AMQ slot (round-robin among open connections) */
  acquire(targetId: string): Promise<PlcConnection>;
  /** Return AMQ slot to pool (does NOT close the connection) */
  release(conn: PlcConnection): void;
  getActive(target: PlcTarget): PlcConnection[];
  getActiveEndpoint(targetId: string): PlcEndpoint;   // Which endpoint is currently live
  getEndpointHealth(targetId: string): EndpointHealth[]; // Health of all endpoints
  forceFailover(targetId: string): Promise<void>;     // Manual failover trigger
  forceFailback(targetId: string): Promise<void>;     // Manual failback trigger
  /** Drain in-flight, send COTP DR, close sockets */
  shutdown(): Promise<void>;
}
```

---

## 6. API Surface (Modeled after node-snap7)

### 6.1 S7ProxyClient (outbound PLC connections)

Mirrors the node-snap7 `S7Client` API for the proxy's own outbound connections:

| Category | Methods |
|---|---|
| **Connection** | `ConnectTo(ip, rack, slot)`, `Connect()`, `Disconnect()`, `SetConnectionParams(ip, localTSAP, remoteTSAP)`, `SetConnectionType(type)` |
| **Data I/O** | `ReadArea(area, dbNum, start, amount, wordLen)`, `WriteArea(area, dbNum, start, amount, wordLen, buffer)` |
| **Data I/O (lean)** | `DBRead`, `DBWrite`, `ABRead`, `ABWrite`, `EBRead`, `EBWrite`, `MBRead`, `MBWrite`, `TMRead`, `TMWrite`, `CTRead`, `CTWrite` |
| **Multi-var** | `ReadMultiVars(items)`, `WriteMultiVars(items)` |
| **Directory** | `ListBlocks()`, `ListBlocksOfType(type)`, `GetAgBlockInfo(type, num)`, `GetPgBlockInfo(buffer)` |
| **Block ops** | `FullUpload(type, num)`, `Upload(type, num)`, `Download(num, buffer)`, `Delete(type, num)`, `DBGet(num)`, `DBFill(num, char)` |
| **Date/Time** | `GetPlcDateTime()`, `SetPlcDateTime(dt)`, `SetPlcSystemDateTime()` |
| **System info** | `ReadSZL(id, index)`, `ReadSZLList()`, `GetOrderCode()`, `GetCpuInfo()`, `GetCpInfo()` |
| **PLC control** | `PlcHotStart()`, `PlcColdStart()`, `PlcStop()`, `CopyRamToRom(timeout)`, `Compress(timeout)` |
| **Security** | `SetSessionPassword(pw)`, `ClearSessionPassword()`, `GetProtection()` |
| **Properties** | `ExecTime()`, `LastError()`, `PDURequested()`, `PDULength()`, `PlcStatus()`, `Connected()`, `ErrorText(err)` |
| **Params** | `GetParam(num)`, `SetParam(num, val)` |

All methods return `Promise<T>` — no blocking calls.

### 6.2 S7ProxyServer (inbound client handling)

Mirrors the node-snap7 `S7Server` API:

| webApi: WebApiConfig;                 // REST + WS data API configuration
  daq: DaqConfig;                       // DAQ engine defaults
  Category | Methods |
|---|---|
| **Admin** | `Start()`, `StartTo(ip)`, `Stop()`, `GetParam(num)`, `SetParam(num, val)` |
| **Memory** | `RegisterArea(code, index, buffer)`, `UnregisterArea(code, index)`, `GetArea(code, index)`, `SetArea(code, index, buffer)`, `LockArea(code, index)`, `UnlockArea(code, index)` |
| **Events** | `on('event', handler)`, `on('readWrite', handler)`, `SetResourceless(val)` |
| **Misc** | `LastError()`, `EventText(event)`, `ErrorText(err)`, `ServerStatus()`, `ClientsCount()`, `GetCpuStatus()`, `SetCpuStatus(status)` |

### 6.3 S7Proxy (the proxy-specific API)

```typescript
interface S7ProxyConfig {
  listen: { ip: string; port: number };
  targets: PlcTargetConfig[];           // Each target may include backup endpoints
  routing: RoutingRule[];
  filters: FilterRule[];
  failover: GlobalFailoverConfig;       // Global defaults for failover behavior
  webApi: WebApiConfig;                 // REST + WS data API configuration
  daq: DaqConfig;                       // DAQ engine defaults
  logging: LogConfig;
  metrics: MetricsConfig;
}

class S7Proxy extends EventEmitter {
  constructor(config: S7ProxyConfig);

  start(): Promise<void>;
  stop(): Promise<void>;

  // Routing
  addRoute(rule: RoutingRule): void;
  removeRoute(id: string): void;

  // Filtering
  addFilter(filter: FilterRule): void;
  on(event: 'daq:scan', handler: (groupId: string, tags: string[], durationMs: number) => void): this;
  on(event: 'daq:subscribe', handler: (clientId: string, tags: string[]) => void): this;
  on(event: 'daq:unsubscribe', handler: (clientId: string, tags: string[]) => void): this;

  // Monitoring
  getSessions(): SessionInfo[];
  getTargetStatus(): TargetStatus[];  // Includes active endpoint + failover state per target
  getMetrics(): ProxyMetrics;

  // Failover control
  forceFailover(targetId: string): Promise<void>;
  forceFailback(targetId: string): Promise<void>;

  // Events
  on(event: 'client:connect', handler: (info: ClientInfo) => void): this;
  on(event: 'client:disconnect', handler: (info: ClientInfo) => void): this;
  on(event: 'pdu:request', handler: (pdu: ParsedPDU, session: SessionInfo) => void): this;
  on(event: 'pdu:response', handler: (pdu: ParsedPDU, session: SessionInfo) => void): this;
  on(event: 'error', handler: (err: Error) => void): this;
  on(event: 'failover', handler: (targetId: string, from: PlcEndpoint, to: PlcEndpoint) => void): this;
  on(event: 'failback', handler: (targetId: string, from: PlcEndpoint, to: PlcEndpoint) => void): this;
  on(event: 'daq:scan', handler: (groupId: string, tags: string[], durationMs: number) => void): this;
  on(event: 'daq:subscribe', handler: (clientId: string, tags: string[]) => void): this;
  on(event: 'daq:unsubscribe', handler: (clientId: string, tags: string[]) => void): this;
}
```

---

## 7. Constants (from node-snap7 reference)

### 7.1 Area Identifiers
| Constant | Value | Description |
|---|---|---|
| `S7AreaPE` | `0x81` | Process Inputs |
| `S7AreaPA` | `0x82` | Process Outputs |
| `S7AreaMK` | `0x83` | Merkers |
| `S7AreaDB` | `0x84` | Data Blocks |
| `S7AreaCT` | `0x1C` | Counters |
| `S7AreaTM` | `0x1D` | Timers |

### 7.2 Word Lengths
| Constant | Value | Description |
|---|---|---|
| `S7WLBit` | `0x01` | Bit |
| `S7WLByte` | `0x02` | Byte (8 bit) |
| `S7WLWord` | `0x04` | Word (16 bit) |
| `S7WLDWord` | `0x06` | Double Word (32 bit) |
| `S7WLReal` | `0x08` | Real (32 bit float) |
| `S7WLCounter` | `0x1C` | Counter (16 bit) |
| `S7WLTimer` | `0x1D` | Timer (16 bit) |

### 7.3 Block Types
| Constant | Value |
|---|---|
| `Block_OB` | `0x38` |
| `Block_DB` | `0x41` |
| `Block_SDB` | `0x42` |
| `Block_FC` | `0x43` |
| `Block_SFC` | `0x44` |
| `Block_FB` | `0x45` |
| `Block_SFB` | `0x46` |

### 7.4 Connection Types
| Constant | Value |
|---|---|
| `CONNTYPE_PG` | `0x01` |
| `CONNTYPE_OP` | `0x02` |
| `CONNTYPE_BASIC` | `0x03–0x10` |

---

## 8. Implementation Phases

### Phase 1: Foundation (Core Protocol in WASM)
1. **Initialize project** — `npm init`, install `assemblyscript`, configure `tsconfig`, `asconfig`
2. **TPKT codec** — `assembly/tpkt.ts`: parse 4-byte header, build header, validate version
3. **COTP codec** — `assembly/cotp.ts`: parse/build CR, CC, DT, DR TPDUs; TSAP extraction
4. **S7Comm header parser** — `assembly/s7comm.ts`: parse protocol ID `0x32`, msg type, function code, sequence number, parameter/data lengths
5. **Constants module** — `assembly/constants.ts`: all area codes, word lengths, error codes, function codes
6. **WASM loader** — `src/wasm/loader.ts`: load `.wasm`, instantiate with imports, expose typed wrapper
7. **Unit tests** — Test each codec against known-good packet captures (Wireshark pcaps from S7Comm reference)

### Phase 2: Proxy Core (TCP + Routing)
1. **Frame assembler** — `src/protocol/frame-assembler.ts`: TCP stream → TPKT frames
2. **TCP listener** — `src/server/tcp-listener.ts`: `net.createServer` on port 102
3. **Client session** — `src/server/client-session.ts`: state machine (NEW → COTP → S7_SETUP → ESTABLISHED → CLOSED)
4. **PLC connection** — `src/client/plc-connection.ts`: outbound `net.Socket` to PLC
5. **Connection pool** — `src/client/connection-pool.ts`: pool with health checks, reconnect
6. **Health probe** — `src/client/health-probe.ts`: lightweight TCP connect probe to check endpoint liveness
7. **Failover manager** — `src/client/failover-manager.ts`: per-target state machine, health monitoring loop, failover/failback triggers
8. **Proxy router** — `src/router/router.ts`: TSAP-based routing, map client → PLC target (resolves active endpoint via failover manager)
9. **Basic pass-through proxy** — Wire it all up: client → parse → forward → PLC → parse → forward → client
10. **Integration tests** — Test with node-snap7 as client against the proxy, with a mock PLC server; test failover by killing primary mock

### Phase 3: Full S7 Client API
1. **Setup Communication** — Negotiate PDU size, handle AMQ parameters
2. **ReadArea / WriteArea** — Build/parse read/write var PDUs in WASM, implement PDU splitting for large transfers
3. **Lean functions** — `DBRead`, `DBWrite`, `ABRead`, `ABWrite`, `EBRead`, `EBWrite`, `MBRead`, `MBWrit, **DAQ scan stats** (Prometheus)
6. **REST management API** — Runtime config changes, session inspection, health endpoint, failover control endpoints
7. **TLS termination** — Optional TLS wrapper for all HTTP/WS endpoints
8. **Configuration** — YAML/JSON config file, environment variable overrides

### Phase 6: Web Data API + DAQ Engine (see §15)
1. **Persistent PLC connections** — Always-open, keep-alive S7 connections per target; pre-established at startup; auto-reconnect
2. **REST data endpoints** — Single-shot read/write via `GET/POST /api/plc/:target/read` and `/write`
3. **Priority request queue** — All PLC access (proxy pass-through, REST, DAQ) funneled through priority queue
4. **DAQ engine core** — Scan groups with configurable cycle times; tag registry with dedup and ref-counting
5. **Read coalescer** — Merge overlapping/adjacent tag reads into minimal S7 `ReadMultiVars` PDUs
6. **WebSocket DAQ subscriptions** — Clients subscribe to tag sets; receive push updates at scan rate
7. **Data cache** — Latest-value cache for immediate REST reads without waiting for next scan cycle
8. **DAQ backpressure** — Slow WS clients get dropped frames (latest-value semantics), not queued indefinitely`
8. **System info** — `ReadSZL`, `ReadSZLList`, `GetOrderCode`, `GetCpuInfo`, `GetCpInfo`
9. **PLC c7ntrol** — `PlcHotStart`, `PlcColdStart`, `PlcStop`, `CopyRamToRom`, `Compress`
10. **Security** — `SetSessionPassword`, `ClearSessionPassword`, `GetProtection`

### Phase 4: Full S7 Server API
1. **Area registration** — `RegisterArea`, `UnregisterArea`, `GetArea`, `SetArea`, `LockArea`, `UnlockArea`
2. **Event system** — `event` and `readWrite` events, event mask filtering
3. **Resourceless mode** — Dynamic read/write callbacks
4. **Virtual CPU** — `GetCpuStatus`, `SetCpuStatus`, `ServerStatus`, `ClientsCount`
5. **Server-side PDU handling** — Respond to client requests from registered areas

### Phase 5: Proxy Features
1. **Filtering / ACL** — Block/allow specific function codes, areas, DB numbers per client IP
2. **Failover / Redundancy** — Backup PLC endpoint support with automatic failover and failback (see §14)
3. **Data transformation** — Modify data in-flight (scaling, mapping, byte-swap)
4. **Logging** — Structured logging of all PDU traffic with configurable verbosity
5. **Metrics** — Connection counts, PDU throughput, latency histograms, error rates, **failover events**, **DAQ scan stats** (Prometheus)
6. **REST management API** — Runtime config changes, session inspection, health endpoint, failover control endpoints
7. **TLS termination** — Optional TLS wrapper for all HTTP/WS endpoints
8. **Configuration** — YAML/JSON config file, environment variable overrides

### Phase 6: Web Data API + DAQ Engine (see §15)
1. **Persistent PLC connections** — Always-open, keep-alive S7 connections per target; pre-established at startup; auto-reconnect
2. **REST data endpoints** — Single-shot read/write via `GET/POST /api/plc/:target/read` and `/write`
3. **Priority request queue** — All PLC access (proxy pass-through, REST, DAQ) funneled through priority queue
4. **DAQ engine core** — Scan groups with configurable cycle times; tag registry with dedup and ref-counting
5. **Read coalescer** — Merge overlapping/adjacent tag reads into minimal S7 `ReadMultiVars` PDUs
6. **WebSocket DAQ subscriptions** — Clients subscribe to tag sets; receive push updates at scan rate
7. **Data cache** — Latest-value cache for immediate REST reads without waiting for next scan cycle
8. **DAQ backpressure** — Slow WS clients get dropped frames (latest-value semantics), not queued indefinitely

### Phase 7: Hardening & Performance
1. **Error handling** — Graceful degradation, connection recovery, timeout management
2. **PDU validation** — Reject malformed packets, prevent buffer overflows in WASM
3. **Backpressure** — Handle slow consumers, `socket.pause()`/`socket.resume()` flow control
4. **Memory limits** — Cap WASM memory growth, connection limits, buffer pool recycling
5. **Benchmarks** — Compare WASM codec performance vs pure-JS codec
6. **Load testing** — Simulate 100+ concurrent client sessions
7. **Security audit** — Validate no raw pointer leaks from WASM, sanitize all external input

---

## 9. WASM ↔ Node.js Native NET Interaction Pattern

The critical design detail: how AssemblyScript "directly interacts" with Node.js `net`:

```
  socket.on('data') ──> copy to WASM memory ──> wasm.frame_parse() ──> read parsed fields
                                                                              │
                                                                    (routing decision in JS)
                                                                              │
  socket.write() <── copy from WASM memory <── wasm.frame_build() <───────────┘
```

### Detailed flow for a Read Request:

```
1. Client TCP data arrives          → Node.js socket.on('data', chunk)
2. Frame assembly                   → FrameAssembler.feed(chunk) → complete TPKT frame
3. Copy frame into WASM RX buffer   → wasmMemory.set(frame, rxOffset)
4. Parse in WASM                    → wasm.frame_parse(rxOffset, frame.length)
5. Read parsed results              → type = wasm.s7_getMessageType()
                                      func = wasm.s7_getFunctionCode()
                                      area, db, start, amount, wordLen (from WASM memory)
6. Routing decision in JS           → router.resolve(session, parsedPDU) → PlcTarget
7. Optional filter/API server (management + data endpoints) |
| `@fastify/cors` | CORS for browser-based web clients |
| `@fastify/rate-limit` | Per-client rate limiting on REST data endpoints |
| `@fastify/websocket` | WebSocket upgrade integration with Fastify |
| `ws` | Low-level WebSocket server for high-speed DAQ  → wasm.frame_build(cotpPtr, cotpLen, s7Ptr, s7Len, txOffset)
9. Copy TX buffer to Node.js Buffer → Buffer.from(wasmMemory, txOffset, txLen)
10. Send to PLC                     → plcSocket.write(txBuffer)
```

### Per-Session WASM Instance Strategy

**Option A: Shared WASM instance** (recommended for start)
- Single WASM module, each session gets a slice of the ring buffer
- Lower memory footprint, but requires careful offset management
- Parse state stored per-session in JS

**Option B: Per-session WASM instance**
- Each client session gets its own WASM instantiation
- Full isolation, simpler code, higher memory use
- Better for heavy concurrent loads where isolation matters

**Recommendation:** Start with Option A, evolve to Option B if needed.

---

## 10. Dependencies

| Package | Purpose |
|---|---|
| `assemblyscript` | AssemblyScript compiler (dev) |
| `@assemblyscript/loader` | Load WASM modules in Node.js |
| `typescript` | TypeScript for Node.js layer |
| `pino` | Structured logging |
| `fastify` | REST API server (management + data endpoints) |
| `@fastify/cors` | CORS for browser-based web clients |
| `@fastify/rate-limit` | Per-client rate limiting on REST data endpoints |
| `@fastify/websocket` | WebSocket upgrade integration with Fastify |
| `ws` | Low-level WebSocket server for high-speed DAQ feed |
| `yaml` | Config file parsing |
| `prom-client` | Prometheus metrics |
| `vitest` or `jest` | Testing framework |
| `node-snap7` | **Dev dependency only** — used for integration testing as a reference client/server |

---

## 11. File Tree (Complete)

```
S7Proxy/
├── package.json
├── tsconfig.json
├── asconfig.json                     # AssemblyScript compiler config
├── config/
│   └── default.yaml                  # Default proxy configuration
├── assembly/                         # AssemblyScript source (→ WASM)
│   ├── index.ts
│   ├── tpkt.ts
│   ├── cotp.ts
│   ├── s7comm.ts
│   ├── s7-functions/
│   │   ├── setup-comm.ts
│   │   ├── read-var.ts
│   │   ├── write-var.ts
│   │   ├── upload.ts
│   │   ├── download.ts
│   │   ├── plc-control.ts
│   │   ├── plc-stop.ts
│   │   ├── szl.ts
│   │   ├── security.ts
│   │   ├── datetime.ts             # Fastify app setup, plugin registration
│   │   ├── rest-routes/
│   │   │   ├── plc-data.ts            # Single-shot PLC read/write endpoints
│   │   │   ├── daq.ts                 # DAQ subscription management
│   │   │   ├── targets.ts             # Target health, failover
│   │   │   └── management.ts          # Config, sessions, metrics
│   │   ├── ws-server.ts               # WebSocket DAQ server
│   │   └── ws-handler.ts              # Per-client WS subscription state
│   ├── daq/
│   │   ├── daq-engine.ts              # Scan group scheduler
│   │   ├── scan-group.ts              # Scan group definition + cycle timer
│   │   ├── tag-registry.ts            # Tag dedup, ref-counting
│   │   ├── read-coalescer.ts          # Merge adjacent reads
│   │   ├── priority-queue.ts          # Priority request queue
│   │   └── data-cache.ts              # Latest-value tag cache
│   ├── pdu-splitter.ts
│   ├── ring-buffer.ts
│   ├── constants.ts
│   ├── error.ts
│   └── memory.ts
├── build/                            # Compiled WASM output
│   └── s7engine.wasm
├── src/                              # Node.js TypeScript source
│   ├── index.ts
│   ├── config.ts
│   ├── proxy-server.ts
│   ├── server/
│   │   ├── tcp-listener.ts
│   │   └── client-session.ts
│   ├── client/
│   │   ├── rest-data-api.test.ts      # REST single-shot read/write tests
│   │   ├── ws-daq.test.ts             # WS DAQ subscription + priority tests
│   │   ├── plc-connection.ts
│   │   ├── connection-pool.ts
│   │   ├── failover-manager.ts    # Per-target failover state machine
│   │   └── health-probe.ts        # TCP liveness probe
│   ├── wasm/
│   │   ├── loader.ts
│   │   ├── bridge.ts
│   │   └── imports.ts
│   ├── router/
│   │   ├── router.ts
│   │   ├── filter.ts
│   │   └── transform.ts
│   ├── protocol/
│   │   ├── frame-assembler.ts
│   │   └── types.ts
│   ├── api/
│   │   ├── rest-server.ts             # Fastify app setup, plugin registration
│   │   ├── rest-routes/
│   │   │   ├── plc-data.ts            # Single-shot PLC read/write endpoints
│   │   │   ├── daq.ts                 # DAQ subscription management
│   │   │   ├── targets.ts             # Target health, failover
│   │   │   └── management.ts          # Config, sessions, metrics
│   │   ├── ws-server.ts               # WebSocket DAQ server
| PLC connections | Persistent, always-open, pre-established | Eliminates per-request connection overhead; enables high-speed DAQ; keep-alive + auto-reconnect |
| Web data access | REST for single-shot, WS for DAQ subscriptions | REST is simple/stateless for ad-hoc reads; WS avoids HTTP overhead for high-frequency push |
| DAQ scheduling | Priority queue + scan groups + read coalescing | Prevents PLC overload under many clients; maximizes PDU utilization; ensures critical reads aren't starved |
│   │   └── ws-handler.ts              # Per-client WS subscription state
│   ├── daq/
│   │   ├── daq-engine.ts              # Scan group scheduler
│   │   ├── scan-group.ts              # Scan group definition + cycle timer
│   │   ├── tag-registry.ts            # Tag dedup, ref-counting
│   │   ├── read-coalescer.ts          # Merge adjacent reads
│   │   ├── priority-queue.ts          # Priority request queue
│   │   └── data-cache.ts              # Latest-value tag cache
│   ├── logging/
│   │   └── logger.ts
│   └── metrics/
│       └── metrics.ts
├── test/
│   ├── unit/
│   │   ├── tpkt.test.ts
│   │   ├── cotp.test.ts
| DAQ overloads PLC with too many reads | PLC watchdog / CPU overload | Read coalescing; max PDUs-per-cycle cap; scan group rate limiting; priority queue ensures fair access |
| Many WS clients cause memory bloat | Node.js OOM | Latest-value semantics (drop stale frames); per-client send buffer limits; slow client disconnection |
| REST reads contend with DAQ scans | High latency for REST | Priority levels — REST on-demand reads get `high` priority; DAQ cyclic gets `normal`; management gets `low` |
| Persistent PLC connection drops silently | Stale data / timeouts | Keep-alive pings (S7 NOP or TCP keepalive); immediate reconnect on socket `close`/`error` events |
│   │   ├── s7comm.test.ts
│   │   ├── frame-assembler.test.ts
│   │   └── pdu-splitter.test.ts
│   ├── integration/
│   │   ├── proxy-passthrough.test.ts
│   │   ├── proxy-filter.test.ts
│   │   ├── proxy-failover.test.ts     # Failover/failback scenario tests
│   │   ├── rest-data-api.test.ts      # REST single-shot read/write tests
│   │   ├── ws-daq.test.ts             # WS DAQ subscription + priority tests
│   │   └── client-server.test.ts
│   └── fixtures/
│       └── pcap/                     # Captured S7 packets for test vectors
├── docs/
│   ├── client-api.md
│   ├── server-api.md
│   └── proxy-config.md
└── PLAN.md                           # This file
```

---

## 12. Key Technical Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Protocol codec runtime | AssemblyScript → WASM | Near-native speed for hot-path parsing; deterministic memory; no GC pauses |
| Networking runtime | Node.js `net` module | Mature, async, handles TCP lifecycle; WASM can't do sockets |
| JS ↔ WASM data passing | Shared linear memory (typed views) | Avoids copy overhead; `Buffer.from(wasmMemory.buffer, offset, len)` |
| API style | async/await (Promises) | Node.js idiom; no blocking; unlike node-snap7's sync+callback dual mode |
| Configuration | YAML + env overrides | Human-readable, 12-factor app compatible |
| Testing reference | node-snap7 as dev dep | Known-good S7 implementation for integration test clients |
| Failover strategy | Threshold-based with auto/manual failback | Prevents flapping; `failbackDelayMs` + hysteresis ensures stability; session migration keeps clients connected |
| PLC connections | Persistent, always-open, pre-established | Eliminates per-request connection overhead; enables high-speed DAQ; keep-alive + auto-reconnect |
| Web data access | REST for single-shot, WS for DAQ subscriptions | REST is simple/stateless for ad-hoc reads; WS avoids HTTP overhead for high-frequency push |
| DAQ scheduling | Priority queue + scan groups + read coalescing | Prevents PLC overload under many clients; maximizes PDU utilization; ensures critical reads aren't starved |

---

## 13. Risk & Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| WASM memory management complexity | Buffer leaks, corruption | Use ring buffers with fixed regions; extensive fuzzing |
| Protocol edge cases (S7-1200/1500 extended) | Incompatible devices | Start with S7-300/400 base protocol; add extended support incrementally |
| PDU splitting across async boundaries | Data corruption | Implement sequence numbering; test with multi-PDU transfers |
| TCP backpressure not handled | Memory exhaustion | Implement `drain` event handling; per-connection buffer limits |
| AssemblyScript limitations (no closures, limited stdlib) | Development friction | Keep WASM layer focused on codec only; all complex logic in JS |
| Port 102 requires elevated privileges | Deployment friction | Document `setcap` on Linux; support configurable port |
| Backup PLC has stale data after failover | Data inconsistency | Document that backup must be a redundant/synced PLC; optionally re-read critical areas on failover |
| Health probe false positives (TCP open but PLC unresponsive) | Unnecessary failover | Use threshold-based detection (N consecutive failures); optionally probe with S7 Setup Communication instead of raw TCP |
| Failover flapping between primary/backup | Unstable connections | Enforce `failbackDelayMs` and `failbackThreshold`; exponential backoff; hysteresis |
| DAQ overloads PLC with too many reads | PLC watchdog / CPU overload | Read coalescing; max PDUs-per-cycle cap; scan group rate limiting; priority queue ensures fair access |
| Many WS clients cause memory bloat | Node.js OOM | Latest-value semantics (drop stale frames); per-client send buffer limits; slow client disconnection |
| REST reads contend with DAQ scans | High latency for REST | Priority levels — REST on-demand reads get `high` priority; DAQ cyclic gets `normal`; management gets `low` |
| Persistent PLC connection drops silently | Stale data / timeouts | Keep-alive pings (S7 NOP or TCP keepalive); immediate reconnect on socket `close`/`error` events |

---

## 14. PLC Endpoint Failover / Redundancy

### 14.1 Concept

A single logical PLC target can have **multiple network endpoints** — the same physical PLC reachable via different network interfaces/subnets, or an H-system (S7-400H) with a standby CPU. The proxy transparently fails over to a backup endpoint when the primary becomes unreachable and fails back when it recovers.

```
  Example: PLC "line1-cpu" has two Ethernet ports:
    Primary:  192.168.1.10  (Plant network)
    Backup:   192.168.2.20  (Redundant ring)

  Client connects to proxy → proxy connects to 192.168.1.10
  If 192.168.1.10 goes down → proxy reconnects via 192.168.2.20
  If 192.168.1.10 recovers  → proxy optionally fails back
```

### 14.2 Configuration Example

```yaml
targets:
  - id: "plc-line1"
    primary:
      ip: "192.168.1.10"
      rack: 0
      slot: 1
    backups:
      - ip: "192.168.2.20"
        rack: 0
        slot: 1
      - ip: "10.0.0.10"        # Third path (e.g. VPN/WAN)
        rack: 0
        slot: 1
    maxConnections: 4
    failover:
      healthCheckIntervalMs: 2000    # Probe every 2s
      healthCheckTimeoutMs: 1000     # TCP connect must complete within 1s
      failoverThreshold: 3           # 3 consecutive failures → switch
      failbackMode: "auto"           # "auto" | "manual"
      failbackDelayMs: 10000         # Wait 10s of primary being healthy before switching back
      failbackThreshold: 3           # 3 consecutive primary successes → switch back

  - id: "plc-line2"
    primary:
      ip: "192.168.1.11"
      rack: 0
      slot: 2
    # No backups — single endpoint, no failover

failover:
  # Global defaults (overridden per-target)
  healthCheckIntervalMs: 3000
  healthCheckTimeoutMs: 1500
  failoverThreshold: 3
  failbackMode: "auto"
  failbackDelayMs: 15000
  failbackThreshold: 5
```

### 14.3 Failover State Machine (per target)

```
                       ┌─────────────────────────────────────┐
                       │                                     │
                       ▼                                     │
               ┌──────────────┐                              │
         ┌────>│   PRIMARY    │──── N consecutive ──────┐    │
         │     │   ACTIVE     │    health failures      │    │
         │     └──────────────┘                         │    │
         │                                              ▼    │
         │                                     ┌──────────────┐
         │ failback                            │ FAILING_OVER │
         │ (auto or manual)                    │ (switching)  │
         │                                     └──────┬───────┘
         │                                            │
         │              backup connect succeeds       │
         │                                            ▼
         │     ┌──────────────┐              ┌──────────────┐
         │     │   FAILBACK   │<── primary   │    BACKUP    │
         └─────│  (switching) │   recovers ──│    ACTIVE    │
               └──────────────┘              └──────────────┘
                                                     │
                                             If backup also fails
                                                     │
                                                     ▼
                                             ┌──────────────┐
                                             │  TRY_NEXT    │
                                             │  BACKUP      │──── cycle through backups[]
                                             └──────────────┘
```

**States:**

| State | Description |
|---|---|
| `PRIMARY_ACTIVE` | Normal operation, connected via primary endpoint. Health probes run in background. |
| `FAILING_OVER` | Primary declared unhealthy. Draining in-flight requests. Connecting to first available backup. |
| `BACKUP_ACTIVE` | Operating on a backup endpoint. Health probes continue on primary (and current backup). |
| `TRY_NEXT_BACKUP` | Current backup also failed. Trying next backup in the list. Cycles back to primary if all backups exhausted. |
| `FAILBACK` | Primary recovered (met `failbackThreshold`). Draining backup, reconnecting to primary. |

### 14.4 Health Probe Design

```typescript
// src/client/health-probe.ts

class HealthProbe {
  private endpoint: PlcEndpoint;
  private intervalMs: number;
  private timeoutMs: number;
  private timer: NodeJS.Timeout | null = null;
  private consecutiveFailures: number = 0;
  private consecutiveSuccesses: number = 0;

  start(): void;    // Begin periodic probing
  stop(): void;     // Stop probing
  probeOnce(): Promise<boolean>;  // Single TCP connect test

  on(event: 'healthy', handler: () => void): this;      // Fires on each successful probe
  on(event: 'unhealthy', handler: () => void): this;    // Fires on each failed probe
  on(event: 'threshold:failed', handler: () => void): this;   // N consecutive failures
  on(event: 'threshold:recovered', handler: () => void): this; // N consecutive successes
}
```

**Probe strategy:**
1. **TCP connect probe** (default): `net.createConnection({ port: 102 })` — fast, low overhead, checks network path
2. **S7 connect probe** (optional, deeper): Full COTP CR + S7 Setup Communication — confirms PLC firmware is responsive, not just TCP stack
3. **Configurable**: Choose per-target via `healthProbeMode: "tcp" | "s7"`

### 14.5 Failover Execution — Session Migration

When failover is triggered, existing client sessions must be migrated to the new endpoint:

```
1. FailoverManager detects primary unhealthy (threshold met)
2. Emit 'failover:start' event with targetId
3. For each active PlcConnection on this target:
   a. Pause client-side socket (backpressure)
   b. Close PLC-side socket (primary)
   c. Open new PLC-side socket to backup endpoint
   d. Re-establish COTP connection (new CR/CC exchange)
   e. Re-negotiate S7 Setup Communication (new PDU negotiation)
   f. Resume client-side socket
   g. Forward next queued client PDU to new PLC connection
4. Update routing table: target → backup endpoint
5. Emit 'failover:complete' event
6. Begin health-probing primary for failback
```

**Key design decisions:**
- **Client sessions are NOT disconnected** — the proxy absorbs the failover. Clients see a brief pause (typically < 2s) but no connection drop.
- **In-flight requests** at the moment of failover may time out. The proxy returns an S7 error response (`errCliSendingRequest`) for requests that cannot be delivered. The client will retry.
- **COTP/S7 must be re-negotiated** with the backup because it's a new TCP connection to the PLC. The proxy handles this transparently — the client's original COTP/S7 session parameters are reused.

### 14.6 Failback Behavior

| Mode | Behavior |
|---|---|
| `auto` | When the primary endpoint passes `failbackThreshold` consecutive health probes after `failbackDelayMs`, the proxy migrates all sessions back to primary using the same session migration process. |
| `manual` | The proxy logs that primary has recovered but stays on backup. An operator must call `proxy.forceFailback(targetId)` or hit the REST API `POST /api/targets/:id/failback` to trigger the switch. |

### 14.7 REST API Endpoints for Failover Control

```
GET    /api/targets                         → List all targets with active endpoint + state
GET    /api/targets/:id/health              → Health status of all endpoints for a target
POST   /api/targets/:id/failover            → Force immediate failover to next backup
POST   /api/targets/:id/failback            → Force immediate failback to primary
PUT    /api/targets/:id/failover/config     → Update failover config at runtime
```

### 14.8 Metrics

```
# Prometheus metrics
s7proxy_failover_total{target="plc-line1", direction="to_backup"}       3
s7proxy_failover_total{target="plc-line1", direction="to_primary"}      2
s7proxy_failover_duration_ms{target="plc-line1"}                        1843
s7proxy_health_probe_result{target="plc-line1", endpoint="primary"}     1     # 1=healthy, 0=unhealthy
s7proxy_health_probe_result{target="plc-line1", endpoint="backup_0"}    1
s7proxy_active_endpoint{target="plc-line1"}                             0     # 0=primary, 1+=backup index
s7proxy_health_probe_latency_ms{target="plc-line1", endpoint="primary"} 12
```

### 14.9 Event Emissions

```typescript
proxy.on('failover', (targetId, from, to) => {
  // { targetId: "plc-line1", from: { ip: "192.168.1.10", ... }, to: { ip: "192.168.2.20", ... } }
  log.warn(`Target ${targetId} failed over: ${from.ip} → ${to.ip}`);
});

proxy.on('failback', (targetId, from, to) => {
  log.info(`Target ${targetId} failed back: ${from.ip} → ${to.ip}`);
});

proxy.on('endpoint:unhealthy', (targetId, endpoint, consecutiveFailures) => { ... });
proxy.on('endpoint:recovered', (targetId, endpoint) => { ... });
```

---

## 15. Web Data API + High-Speed DAQ Engine

### 15.1 Overview

In addition to the transparent S7Comm proxy (TCP:102), the system exposes **web-based interfaces** for applications that cannot or should not speak raw S7:

| Interface | Transport | Use Case | Paradigm |
|---|---|---|---|
| **REST API** | HTTP (Fastify) | Single-shot reads/writes from dashboards, scripts, MES systems | Request → Response |
| **WebSocket API** | WS (ws) | High-speed data acquisition (DAQ) subscriptions for real-time UIs, historians, analytics | Subscribe → Push stream |

Both interfaces share the **same persistent PLC connections** — no per-request connect/disconnect overhead.

### 15.2 Persistent PLC Connection Strategy

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     Connection Lifecycle                                │
│                                                                         │
│  Startup:                                                               │
│    For each configured target:                                          │
│      1. Open TCP socket to PLC (primary endpoint)                       │
│      2. Complete COTP CR/CC handshake                                   │
│      3. Negotiate S7 Setup Communication (PDU size, AMQ slots)          │
│      4. Mark connection READY in pool                                   │
│      5. Start keep-alive timer                                          │
│                                                                         │
│  Steady state:                                                          │
│    • Connections stay open indefinitely                                 │
│    • Keep-alive: periodic S7 NOP / TCP keepalive every N seconds        │
│    • AMQ (max concurrent jobs) tracked per connection                   │
│    • Multiple connections per target for parallelism (configurable)     │
│                                                                         │
│  Recovery:                                                              │
│    • On socket error/close → immediate reconnect (backoff: 1s→2s→4s…)   │
│    • On PLC reboot detected → full re-handshake                         │
│    • Queued requests wait for reconnect (up to timeout)                 │
│    • Failover kicks in if reconnect fails past threshold                │
│                                                                         │
│  Shutdown:                                                              │
│    • Drain in-flight requests                                           │
│    • Send COTP DR (disconnect request)                                  │
│    • Close TCP sockets                                                  │
└─────────────────────────────────────────────────────────────────────────┘
```

**Configuration:**
```yaml
targets:
  - id: "plc-line1"
    primary:
      ip: "192.168.1.10"
      rack: 0
      slot: 1
    connections: 2                # Open 2 persistent connections (for AMQ parallelism)
    keepAliveIntervalMs: 5000     # Send keep-alive every 5s
    reconnectBackoffMs: [1000, 2000, 4000, 8000, 15000]  # Exponential backoff
    requestTimeoutMs: 3000        # Per-request timeout
```

### 15.3 REST Data API

The REST API provides stateless, single-shot PLC access for web clients.

#### Endpoints

```
# ── Read Operations ──

GET /api/plc/:target/read
  ?area=DB&db=1&start=0&amount=100&wordLen=byte
  → { data: "base64...", timestamp: "2026-04-20T12:00:00Z", target: "plc-line1" }

GET /api/plc/:target/db/:dbNum
  ?start=0&size=100
  → { data: "base64...", timestamp: ... }

GET /api/plc/:target/db/:dbNum/int?offset=10
  → { value: 1234, type: "int16", timestamp: ... }

GET /api/plc/:target/db/:dbNum/real?offset=20
  → { value: 3.14, type: "float32", timestamp: ... }

POST /api/plc/:target/read-multi
  body: { items: [
    { area: "DB", db: 1, start: 0, amount: 10, wordLen: "byte" },
    { area: "MK", start: 0, amount: 4, wordLen: "byte" },
    { area: "DB", db: 2, start: 100, amount: 2, wordLen: "word" }
  ]}
  → { results: [ { data: "...", result: 0 }, ... ] }

# ── Write Operations ──

POST /api/plc/:target/write
  body: { area: "DB", db: 1, start: 0, wordLen: "byte", data: "base64..." }
  → { success: true, timestamp: ... }

POST /api/plc/:target/write-multi
  body: { items: [ { area: "DB", db: 1, start: 0, wordLen: "byte", data: "..." }, ... ] }
  → { results: [ { result: 0 }, ... ] }

# ── Convenience ──

GET  /api/plc/:target/status       → { cpuStatus: "run", timestamp: ... }
GET  /api/plc/:target/info         → { orderCode: ..., cpuInfo: ..., cpInfo: ... }
GET  /api/plc/:target/blocks       → { OBCount: 4, DBCount: 12, ... }
GET  /api/plc/:target/datetime     → { datetime: "2026-04-20T12:00:00" }
```

**Key behaviors:**
- Each REST request is translated into S7 PDU(s), dispatched through the **priority queue** on the persistent connection, and the response returned as JSON.
- If a recent value exists in the **data cache** (from a DAQ scan), REST can optionally return it immediately (`?cache=true&maxAgeMs=500`) without hitting the PLC.
- Rate-limited per client IP (`@fastify/rate-limit`) to prevent a single web client from monopolizing PLC bandwidth.
- Authentication via API key header (`X-API-Key`) or Bearer token.

### 15.4 WebSocket DAQ Subscription API

The WS interface provides high-speed, push-based data acquisition.

#### Connection & Protocol

```
ws://proxy:8080/api/ws/daq

// Client → Server: Subscribe
{
  "type": "subscribe",
  "id": "sub-1",
  "target": "plc-line1",
  "tags": [
    { "area": "DB", "db": 1, "start": 0, "amount": 100, "wordLen": "byte" },
    { "area": "DB", "db": 2, "start": 50, "amount": 4, "wordLen": "real" },
    { "area": "MK", "start": 0, "amount": 8, "wordLen": "byte" }
  ],
  "intervalMs": 100,          // Desired scan rate (100ms = 10 Hz)
  "priority": "normal",       // "critical" | "high" | "normal" | "low"
  "deadband": 0,              // Optional: only push if value changed (0 = always push)
  "format": "base64"          // "base64" | "hex" | "json-values"
}

// Server → Client: Subscription confirmed
{
  "type": "subscribed",
  "id": "sub-1",
  "actualIntervalMs": 100,    // May be clamped to minimum
  "scanGroupId": "sg-42"
}

// Server → Client: Data push (at scan rate)
{
  "type": "data",
  "id": "sub-1",
  "timestamp": 1745150400000,
  "seq": 12345,
  "tags": [
    { "area": "DB", "db": 1, "start": 0, "data": "AQIDBA==", "quality": "good" },
    { "area": "DB", "db": 2, "start": 50, "data": "QEkP2w==", "quality": "good" },
    { "area": "MK", "start": 0, "data": "//8A/w==", "quality": "good" }
  ]
}

// Client → Server: Modify subscription
{
  "type": "modify",
  "id": "sub-1",
  "intervalMs": 50,            // Speed up to 20 Hz
  "addTags": [ { "area": "DB", "db": 3, "start": 0, "amount": 20, "wordLen": "byte" } ],
  "removeTags": [ { "area": "MK", "start": 0, "amount": 8, "wordLen": "byte" } ]
}

// Client → Server: Unsubscribe
{ "type": "unsubscribe", "id": "sub-1" }

// Server → Client: Error
{ "type": "error", "id": "sub-1", "code": "PLC_UNREACHABLE", "message": "..." }

// Client → Server: Single-shot read (also available via WS)
{ "type": "read", "reqId": "r-1", "target": "plc-line1", "area": "DB", "db": 1, "start": 0, "amount": 10 }

// Server → Client: Read response
{ "type": "readResponse", "reqId": "r-1", "data": "AQIDBA==", "timestamp": ... }
```

### 15.5 DAQ Engine Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           DAQ Engine                                    │
│                                                                         │
│  ┌─────────────┐    ┌─────────────────┐    ┌──────────────────────────┐ │
│  │ WS Client 1 │───>│                 │    │                          │ │
│  │ sub: DB1,MK │    │  Tag Registry   │    │   Scan Groups            │ │
│  ├─────────────┤    │                 │    │                          │ │
│  │ WS Client 2 │───>│ • Dedup tags    │───>│  SG-1: 50ms  (critical)  │ │
│  │ sub: DB1,DB3│    │ • Ref-count     │    │  SG-2: 100ms (normal)    │ │
│  ├─────────────┤    │ • Map → scan    │    │  SG-3: 500ms (low)       │ │
│  │ WS Client 3 │───>│   groups        │    │  SG-4: 1000ms (low)      │ │
│  │ sub: DB2    │    │                 │    │                          │ │
│  └─────────────┘    └─────────────────┘    └───────────┬──────────────┘ │
│                                                        │                │
│                                         ┌──────────────▼──────────────┐ │
│                                         │       Read Coalescer        │ │
│                                         │                             │ │
│                                         │  DB1[0..100] + DB1[80..120] │ │
│                                         │  → merged: DB1[0..120]      │ │
│                                         │                             │ │
│                                         │  DB2[50..54] (standalone)   │ │
│                                         │                             │ │
│                                         │  MK[0..8] (standalone)      │ │
│                                         └──────────────┬──────────────┘ │
│                                                        │                │
│                                           ┌────────────▼──────────────┐ │
│                                           │     Priority Queue        │ │
│                                           │                           │ │
│                                           │  [critical] ████          │ │
│                                           │  [high]     ██            │ │
│                                           │  [normal]   ██████████    │ │
│                                           │  [low]      ████          │ │
│                                           └────────────┬──────────────┘ │
│                                                        │                │
│                                           ┌────────────▼──────────────┐ │
│                                           │  Persistent PLC Conn Pool │ │
│                                           │  (AMQ-aware dispatch)     │ │
│                                           └────────────┬──────────────┘ │
│                                                        │                │
│                                           ┌────────────▼──────────────┐ │
│                                           │     Data Cache            │ │
│                                           │  tag → { value, ts, seq } │ │
│                                           └────────────┬──────────────┘ │
│                                                        │                │
│                                              Fan-out to subscribers     │
│                                                        │                │
│                       ┌────────────────────────────────┼──────────┐     │
│                       ▼                                ▼          ▼     │
│                  WS Client 1                     WS Client 2  Client 3  │
└─────────────────────────────────────────────────────────────────────────┘
```

### 15.6 Priority Queue Design

All PLC access — S7 proxy pass-through, REST single-shot, DAQ cyclic scans — flows through a **unified priority queue** per PLC target. This prevents any single source from starving others.

#### Priority Levels

| Level | Value | Sources | Semantics |
|---|---|---|---|
| `critical` | 0 | DAQ subscriptions marked critical; PLC control commands | Always dispatched first; preempts lower levels |
| `high` | 1 | REST on-demand reads/writes; proxy pass-through from S7 clients | Low latency for interactive use |
| `normal` | 2 | DAQ cyclic scans (default) | Bulk of throughput |
| `low` | 3 | Management queries (SZL reads, block lists, status); background tasks | Best-effort |

#### Queue Behavior

```typescript
interface PriorityRequest {
  id: string;
  priority: 'critical' | 'high' | 'normal' | 'low';
  targetId: string;
  pduBuilder: () => Buffer;        // Builds the S7 request PDU on demand
  resolve: (data: Buffer) => void; // Fulfill the promise with response
  reject: (err: Error) => void;    // Reject on timeout/error
  createdAt: number;               // For timeout tracking
  timeoutMs: number;               // Per-request deadline
  source: 'proxy' | 'rest' | 'daq' | 'management';
}

class PriorityRequestQueue {
  enqueue(req: PriorityRequest): void;
  
  // Called when a PLC connection has a free AMQ slot
  dequeue(): PriorityRequest | null;     // Highest priority first, FIFO within level
  
  peek(): PriorityRequest | null;
  size(): number;
  sizeByPriority(): Record<string, number>;
  
  // Starvation prevention: after N consecutive critical/high dispatches,
  // force-dispatch one normal/low request
  setFairnessWindow(n: number): void;    // Default: 10

  // Aging: requests waiting > ageThresholdMs get promoted one level
  setAgingThreshold(ms: number): void;   // Default: 2000ms
}
```

**Starvation prevention:**
- A **fairness window** ensures that after N consecutive high-priority dispatches, at least one lower-priority request gets through.
- **Request aging**: requests waiting longer than `ageThresholdMs` are promoted one priority level, ensuring nothing waits indefinitely.

#### AMQ Slot Management

S7 connections have a negotiated **AMQ (max calling/called)** — typically 8 or 16 concurrent jobs. The queue dispatcher:

```
1. Check: does target have a connection with free AMQ slot?
   YES → dequeue highest-priority request, send PDU, decrement free slots
   NO  → wait for a response to come back (frees a slot), then retry
2. On response received:
   a. Increment free AMQ slot
   b. Match response to pending request (by sequence number)
   c. Resolve the request's promise
   d. Immediately dequeue next request if queue non-empty
```

### 15.7 Read Coalescer

When multiple subscribers (or a mix of REST + DAQ) need overlapping memory ranges from the same PLC, the coalescer merges them into minimal requests:

```
Input requests (same scan cycle):
  Client A: DB1[0..99]     (100 bytes)
  Client B: DB1[80..179]   (100 bytes)
  Client C: DB1[200..203]  (4 bytes, a REAL)
  Client D: MK[0..7]       (8 bytes)

Coalesced PLC reads:
  Read 1: DB1[0..179]      (180 bytes — merged A+B overlap)
  Read 2: DB1[200..203]    (4 bytes — gap too large to merge with Read 1)
  Read 3: MK[0..7]         (8 bytes — different area)

After PLC response:
  Client A gets: DB1[0..99]   sliced from Read 1
  Client B gets: DB1[80..179] sliced from Read 1
  Client C gets: DB1[200..203] from Read 2
  Client D gets: MK[0..7]     from Read 3
```

**Merge rules:**
- Same area + same DB number → eligible for merge
- Gap between ranges ≤ `maxGapBytes` (default: 32) → merge (reading a few extra bytes is cheaper than a separate PDU)
- Merged range must fit in one PDU (considering `maxPduSize - headers`)
- If merged range exceeds PDU size → split into multiple reads (PDU splitter handles this)
- Cross-area reads are never merged (use `ReadMultiVars` instead)

### 15.8 Scan Group Management

```typescript
interface ScanGroup {
  id: string;
  targetId: string;                  // Which PLC
  intervalMs: number;                // Scan cycle time (e.g. 100ms)
  priority: 'critical' | 'high' | 'normal' | 'low';
  tags: TagDefinition[];             // Coalesced tag set
  subscribers: Set<string>;          // WS client IDs subscribed to this group
  lastScanTimestamp: number;
  lastScanDurationMs: number;
  missedScans: number;               // Incremented if scan takes longer than interval
}
```

**Scan group lifecycle:**
1. WS client subscribes with `intervalMs: 100, priority: normal`
2. DAQ engine checks: does a matching scan group exist (same target, same interval, same priority)?
   - **YES** → add tags to existing group (deduplicated), increment subscriber ref-count
   - **NO** → create new scan group, start its cycle timer
3. On each cycle tick:
   a. Coalesce all tags in the group
   b. Enqueue read request(s) into priority queue
   c. On response: update data cache, fan-out to all subscribers of this group
4. When last subscriber unsubscribes from a group → stop timer, destroy group

**Minimum interval enforcement:** Configurable floor (e.g. `minScanIntervalMs: 20`) to prevent clients from requesting unsustainable rates.

### 15.9 Data Cache

```typescript
interface CachedValue {
  data: Buffer;              // Raw bytes from PLC
  timestamp: number;         // When this value was read
  quality: 'good' | 'uncertain' | 'bad';  // Reflects PLC response code
  scanGroupId: string;       // Which scan group produced this value
  seq: number;               // Monotonic sequence number
}

class DataCache {
  get(target: string, area: string, db: number, start: number, amount: number): CachedValue | null;
  set(target: string, area: string, db: number, start: number, data: Buffer, quality: string): void;
  getAge(key: string): number;  // ms since last update
  clear(target?: string): void;
  stats(): { entries: number; hitRate: number; avgAgeMs: number };
}
```

**REST cache integration:**
```
GET /api/plc/plc-line1/db/1?start=0&size=100&cache=true&maxAgeMs=500

→ If cache has DB1[0..99] updated < 500ms ago → return cached value (no PLC hit)
→ Otherwise → enqueue read as priority=high, wait for response, return fresh value
```

### 15.10 WS Backpressure & Slow Client Handling

High-speed DAQ can produce data faster than a slow WS client can consume:

```
Strategy: Latest-Value Semantics (drop stale, keep fresh)

┌─────────┐    scan @ 100ms    ┌──────────┐    ws.send()    ┌─────────────┐
│   PLC   │ ───────────────>   │ DAQ Eng  │ ─────────────>  │  WS Client  │
└─────────┘                    └──────────┘                 └─────────────┘
                                    │                              │
                                    │  bufferedAmount > threshold? │
                                    │         YES → skip this push │
                                    │         NO  → send normally  │
```

**Rules:**
1. Before each `ws.send()`, check `ws.bufferedAmount`
2. If `bufferedAmount > maxSendBufferBytes` (default: 64 KB):
   - **Skip** the data push for this cycle (the next cycle's fresh data will be sent instead)
   - Increment `droppedFrames` counter for this client
   - Log at `debug` level
3. If `droppedFrames > maxDroppedFrames` within a window (default: 100 drops in 10s):
   - Send `{ type: "warning", code: "SLOW_CONSUMER", message: "..." }` to client
   - If client still can't keep up: forcefully disconnect with close code `4008 Slow Consumer`
4. Include `seq` (sequence number) in every data push so clients can detect gaps

### 15.11 Configuration

```yaml
webApi:
  enabled: true
  host: "0.0.0.0"
  port: 8080
  cors:
    origin: "*"                       # Restrict in production
  auth:
    type: "api-key"                   # "none" | "api-key" | "jwt"
    keys: ["key-1-abc", "key-2-xyz"]  # Or reference env var / secrets file
  rateLimit:
    max: 100                          # Requests per window per client
    windowMs: 60000                   # 1 minute
  tls:
    enabled: false
    cert: "./certs/server.crt"
    key: "./certs/server.key"

daq:
  minScanIntervalMs: 20              # Floor: no scan group faster than 50 Hz
  maxScanGroupsPerTarget: 50         # Limit scan group proliferation
  maxTagsPerSubscription: 500        # Per WS client limit
  maxGapBytes: 32                    # Read coalescer merge gap threshold
  cacheEnabled: true
  cacheTtlMs: 5000                   # Evict cache entries older than 5s
  priorityQueue:
    fairnessWindow: 10               # Force lower-priority dispatch every N
    agingThresholdMs: 2000           # Promote after 2s wait
  slowClient:
    maxSendBufferBytes: 65536        # 64 KB
    maxDroppedFrames: 100
    dropWindowMs: 10000
```

### 15.12 Metrics

```
# DAQ-specific Prometheus metrics
s7proxy_daq_scan_duration_ms{target="plc-line1", group="sg-42"}          12.3
s7proxy_daq_scan_total{target="plc-line1", group="sg-42"}                50000
s7proxy_daq_missed_scans{target="plc-line1", group="sg-42"}              3
s7proxy_daq_active_scan_groups{target="plc-line1"}                       4
s7proxy_daq_active_subscriptions                                         12
s7proxy_daq_tags_total{target="plc-line1"}                               342
s7proxy_daq_tags_unique{target="plc-line1"}                              187     # After dedup
s7proxy_daq_coalesced_reads{target="plc-line1"}                          89      # vs 187 raw reads

s7proxy_priority_queue_size{target="plc-line1", priority="critical"}     0
s7proxy_priority_queue_size{target="plc-line1", priority="high"}         2
s7proxy_priority_queue_size{target="plc-line1", priority="normal"}       8
s7proxy_priority_queue_size{target="plc-line1", priority="low"}          1
s7proxy_priority_queue_wait_ms{target="plc-line1", priority="high"}      5.2
s7proxy_priority_queue_aged_promotions_total{target="plc-line1"}         14

s7proxy_rest_requests_total{target="plc-line1", method="read"}           1042
s7proxy_rest_requests_total{target="plc-line1", method="write"}          87
s7proxy_rest_cache_hits_total{target="plc-line1"}                        623
s7proxy_rest_latency_ms{target="plc-line1"}                              8.1

s7proxy_ws_clients_active                                                5
s7proxy_ws_dropped_frames_total{client="..."}                            12
s7proxy_ws_disconnects_slow_consumer_total                               1

s7proxy_plc_connection_uptime_ms{target="plc-line1", conn="0"}           3600000
s7proxy_plc_connection_reconnects_total{target="plc-line1"}              2
s7proxy_plc_amq_slots_free{target="plc-line1", conn="0"}                6
s7proxy_plc_amq_slots_total{target="plc-line1", conn="0"}               8
```
