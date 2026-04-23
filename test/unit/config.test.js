// @ts-check

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../../src/config.js';

/** @type {string} */
let tmpDir;
/** @type {Record<string, string | undefined>} */
let originalEnv;

describe('loadConfig', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 's7proxy-config-'));
    originalEnv = {
      S7PROXY_IP: process.env['S7PROXY_IP'],
      S7PROXY_PORT: process.env['S7PROXY_PORT'],
      S7PROXY_WEB_HOST: process.env['S7PROXY_WEB_HOST'],
      S7PROXY_WEB_PORT: process.env['S7PROXY_WEB_PORT'],
    };
  });

  afterEach(() => {
    restoreEnv('S7PROXY_IP');
    restoreEnv('S7PROXY_PORT');
    restoreEnv('S7PROXY_WEB_HOST');
    restoreEnv('S7PROXY_WEB_PORT');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lets explicit overrides win over config file and environment values', () => {
    const configPath = writeConfigFile({
      listen: { ip: '10.10.10.10', port: 2102 },
      webApi: { host: '10.10.10.20', port: 8180 },
    });

    process.env['S7PROXY_IP'] = '10.20.20.20';
    process.env['S7PROXY_PORT'] = '3102';
    process.env['S7PROXY_WEB_HOST'] = '10.20.20.30';
    process.env['S7PROXY_WEB_PORT'] = '8280';

    const config = loadConfig(configPath, {
      listenIp: '127.0.0.1',
      listenPort: 4102,
      webHost: '127.0.0.2',
      webPort: 8380,
    });

    expect(config.listen).toEqual({ ip: '127.0.0.1', port: 4102 });
    expect(config.webApi.host).toBe('127.0.0.2');
    expect(config.webApi.port).toBe(8380);
  });

  it('supports S7PROXY_WEB_HOST as an environment override', () => {
    const configPath = writeConfigFile({
      webApi: { host: '10.10.10.20', port: 8180 },
    });

    process.env['S7PROXY_WEB_HOST'] = '0.0.0.0';

    const config = loadConfig(configPath);

    expect(config.webApi.host).toBe('0.0.0.0');
    expect(config.webApi.port).toBe(8180);
  });
});

/**
 * @param {string} key
 */
function restoreEnv(key) {
  const value = originalEnv[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/**
 * @param {object} content
 * @returns {string}
 */
function writeConfigFile(content) {
  const configPath = join(tmpDir, 'config.json');
  writeFileSync(configPath, JSON.stringify(content), 'utf8');
  return configPath;
}