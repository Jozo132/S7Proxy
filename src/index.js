#!/usr/bin/env node
// @ts-check
// Standalone CLI entry point

import { loadConfig } from './config.js';
import { ProxyServer } from './proxy-server.js';

const configPath = process.argv[2] || undefined;
const config = loadConfig(configPath);
const server = new ProxyServer(config);

await server.start();
