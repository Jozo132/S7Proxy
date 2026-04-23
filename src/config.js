// @ts-check
// Configuration loader — JSON config with optional env and CLI overrides

import { readFileSync, existsSync } from 'node:fs';

/** @import { S7ProxyConfig, FailoverConfig, DaqConfig, WebApiConfig } from './protocol/types.js' */
/** @import { CliOverrides } from './cli-options.js' */

/**
 * @param {string} raw
 * @returns {Record<string, string>}
 */
function parseEnvFile(raw) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key) env[key] = value;
  }
  return env;
}

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
 * @param {CliOverrides} [overrides]
 * @returns {S7ProxyConfig}
 */
export function loadConfig(configPath, overrides = {}) {
  const path = configPath ?? process.env['S7PROXY_CONFIG'] ?? 'config/default.json';

  /** @type {Partial<S7ProxyConfig>} */
  let fileConfig = {};
  /** @type {Record<string, string>} */
  let fileEnv = {};

  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf-8');
    if (path.endsWith('.env')) {
      fileEnv = parseEnvFile(raw);
    } else if (path.endsWith('.json')) {
      fileConfig = JSON.parse(raw);
    } else {
      throw new Error(`Unsupported config format for "${path}". Use .json or .env.`);
    }
  }

  // Environment variable overrides
  const env = { ...fileEnv, ...process.env };
  const envPort = env['S7PROXY_PORT'];
  const envIp = env['S7PROXY_IP'];
  const envLogLevel = env['S7PROXY_LOG_LEVEL'];
  const envWebHost = env['S7PROXY_WEB_HOST'];
  const envWebPort = env['S7PROXY_WEB_PORT'];

  /** @type {S7ProxyConfig} */
  const config = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    listen: {
      ...DEFAULT_CONFIG.listen,
      ...fileConfig.listen,
      ...(envIp ? { ip: envIp } : {}),
      ...(envPort ? { port: parseInt(envPort, 10) } : {}),
      ...(overrides.listenIp ? { ip: overrides.listenIp } : {}),
      ...(overrides.listenPort !== undefined ? { port: overrides.listenPort } : {}),
    },
    failover: { ...DEFAULT_FAILOVER, ...fileConfig.failover },
    webApi: {
      ...DEFAULT_WEBAPI,
      ...fileConfig.webApi,
      ...(envWebHost ? { host: envWebHost } : {}),
      ...(envWebPort ? { port: parseInt(envWebPort, 10) } : {}),
      ...(overrides.webHost ? { host: overrides.webHost } : {}),
      ...(overrides.webPort !== undefined ? { port: overrides.webPort } : {}),
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
      ...(envLogLevel ? { level: /** @type {import('./protocol/types.js').LogConfig['level']} */ (envLogLevel) } : {}),
    },
    metrics: { ...DEFAULT_CONFIG.metrics, ...fileConfig.metrics },
  };

  return config;
}
