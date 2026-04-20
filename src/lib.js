// @ts-check
// NPM package entry point — re-exports public API

export { ProxyServer } from './proxy-server.js';
export { loadConfig } from './config.js';
export { WasmBridge } from './wasm/bridge.js';
export { loadWasmEngine, resetWasmCache } from './wasm/loader.js';
export { createWasmImports } from './wasm/imports.js';
export { PlcConnection } from './client/plc-connection.js';
export { ConnectionPool } from './client/connection-pool.js';
export { FailoverManager } from './client/failover-manager.js';
export { HealthProbe } from './client/health-probe.js';
export { TcpListener } from './server/tcp-listener.js';
export { ClientSession } from './server/client-session.js';
export { ProxyRouter } from './router/router.js';
export { DaqEngine } from './daq/daq-engine.js';
export { PriorityQueue } from './daq/priority-queue.js';
export { TagRegistry } from './daq/tag-registry.js';
export { ReadCoalescer } from './daq/read-coalescer.js';
export { DataCache } from './daq/data-cache.js';
export { ScanGroup } from './daq/scan-group.js';
export { RestServer } from './api/rest-server.js';
export { WsServer } from './api/ws-server.js';
export { Metrics } from './metrics/metrics.js';
export { createLogger } from './logging/logger.js';
export { FrameAssembler } from './protocol/frame-assembler.js';
export * from './protocol/constants.js';
