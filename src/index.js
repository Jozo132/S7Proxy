#!/usr/bin/env node
// @ts-check
// Standalone CLI entry point with JSON persistence

import { resolve } from 'node:path';
import { formatCliHelp, parseCliArgs } from './cli-options.js';
import { loadConfig } from './config.js';
import { ProxyServer } from './proxy-server.js';
import { AdminStore } from './admin/store.js';

let cli;
try {
  cli = parseCliArgs(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.error('');
  console.error(formatCliHelp());
  process.exit(1);
}

if (cli.help) {
  console.log(formatCliHelp());
  process.exit(0);
}

const config = loadConfig(cli.configPath, cli.overrides);

// Enable pretty logs when running in a terminal (not piped/redirected)
if (process.stdout.isTTY && config.logging.pretty === undefined) {
  config.logging.pretty = true;
}

// Initialize JSON persistence. For compatibility, S7PROXY_DB_PATH may still
// point at a legacy .db-style path; AdminStore will persist a .json file
// alongside it.
const dbPath = process.env['S7PROXY_DB_PATH'] ?? resolve('data', 's7proxy.json');
const store = new AdminStore(dbPath);

// Merge config and persisted targets, honoring database overrides and disabled IDs.
const persistedTargets = store.loadTargets();
const disabledTargetIds = new Set(store.getDisabledTargets());
const mergedTargets = new Map(
  config.targets
    .filter((target) => !disabledTargetIds.has(target.id))
    .map((target) => [target.id, target]),
);

for (const target of persistedTargets) {
  if (!disabledTargetIds.has(target.id)) mergedTargets.set(target.id, target);
}

config.targets = [...mergedTargets.values()];

const server = new ProxyServer(config, store);

await server.start();
