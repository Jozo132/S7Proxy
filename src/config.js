// @ts-check
// Configuration loader — YAML/JSON config with environment variable overrides

import { readFileSync, existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

/** @import { S7ProxyConfig, FailoverConfig, DaqConfig, WebApiConfig } from './protocol/types.js' */

/** @type {FailoverConfig} */
const DEFAULT_FAILOVER = {
  healthCheckIntervalMs: 3000,
  healthCheckTimeoutMs: 1500,
  failoverThreshold: 3,
  failbackMode: 'auto',
  failbackDelayMs: 15000,
  failbackThreshold: 5,
  healthProbeMode: 'tcp',
};

/** @type {DaqConfig} */
const DEFAULT_DAQ = {
  minScanIntervalMs: 20,
  maxScanGroupsPerTarget: 50,
  maxTagsPerSubscription: 500,
  maxGapBytes: 32,
  cacheEnabled: true,
  cacheTtlMs: 5000,
  priorityQueue: {
    fairnessWindow: 10,
    agingThresholdMs: 2000,
  },
  slowClient: {
    maxSendBufferBytes: 65536,
    maxDroppedFrames: 100,
    dropWindowMs: 10000,
  },
};

/** @type {WebApiConfig} */
const DEFAULT_WEBAPI = {
  enabled: true,
  host: '0.0.0.0',
  port: 8080,
  cors: { origin: '*' },
  auth: { type: 'none' },
  rateLimit: { max: 100, windowMs: 60000 },
};

/** @type {S7ProxyConfig} */
const DEFAULT_CONFIG = {
  listen: { ip: '0.0.0.0', port: 102 },
  targets: [],
  routing: [],
  filters: [],
  failover: DEFAULT_FAILOVER,
  webApi: DEFAULT_WEBAPI,
  daq: DEFAULT_DAQ,
  logging: { level: 'info' },
  metrics: { enabled: true, port: 9090, path: '/metrics' },
};

/**
 * @param {string} [configPath]
 * @returns {S7ProxyConfig}
 */
export function loadConfig(configPath) {
  const path = configPath ?? process.env['S7PROXY_CONFIG'] ?? 'config/default.yaml';

  /** @type {Partial<S7ProxyConfig>} */
  let fileConfig = {};

  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf-8');
    if (path.endsWith('.json')) {
      fileConfig = JSON.parse(raw);
    } else {
      fileConfig = parseYaml(raw) ?? {};
    }
  }

  // Environment variable overrides
  const envPort = process.env['S7PROXY_PORT'];
  const envIp = process.env['S7PROXY_IP'];
  const envLogLevel = process.env['S7PROXY_LOG_LEVEL'];
  const envWebPort = process.env['S7PROXY_WEB_PORT'];

  /** @type {S7ProxyConfig} */
  const config = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    listen: {
      ...DEFAULT_CONFIG.listen,
      ...fileConfig.listen,
      ...(envIp ? { ip: envIp } : {}),
      ...(envPort ? { port: parseInt(envPort, 10) } : {}),
    },
    failover: { ...DEFAULT_FAILOVER, ...fileConfig.failover },
    webApi: {
      ...DEFAULT_WEBAPI,
      ...fileConfig.webApi,
      ...(envWebPort ? { port: parseInt(envWebPort, 10) } : {}),
    },
    daq: {
      ...DEFAULT_DAQ,
      ...fileConfig.daq,
      priorityQueue: { ...DEFAULT_DAQ.priorityQueue, ...fileConfig.daq?.priorityQueue },
      slowClient: { ...DEFAULT_DAQ.slowClient, ...fileConfig.daq?.slowClient },
    },
    logging: {
      ...DEFAULT_CONFIG.logging,
      ...fileConfig.logging,
      ...(envLogLevel ? { level: envLogLevel } : {}),
    },
    metrics: { ...DEFAULT_CONFIG.metrics, ...fileConfig.metrics },
  };

  return config;
}
