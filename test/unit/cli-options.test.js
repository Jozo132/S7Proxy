// @ts-check

import { describe, expect, it } from 'vitest';
import { formatCliHelp, parseCliArgs } from '../../src/cli-options.js';

describe('parseCliArgs', () => {
  it('accepts a positional config path and listener overrides', () => {
    const parsed = parseCliArgs(['config/custom.json', '--host', '127.0.0.1', '--port', '1102']);

    expect(parsed).toEqual({
      configPath: 'config/custom.json',
      overrides: {
        listenIp: '127.0.0.1',
        listenPort: 1102,
      },
      help: false,
    });
  });

  it('accepts inline values for web api overrides', () => {
    const parsed = parseCliArgs(['--web-host=192.0.2.20', '--web-port=8081']);

    expect(parsed.overrides).toEqual({
      webHost: '192.0.2.20',
      webPort: 8081,
    });
  });

  it('throws on invalid ports', () => {
    expect(() => parseCliArgs(['--port', 'abc'])).toThrow('Invalid port for --port: abc');
    expect(() => parseCliArgs(['--web-port', '70000'])).toThrow('Port out of range for --web-port: 70000');
  });
});

describe('formatCliHelp', () => {
  it('describes the supported override flags', () => {
    const help = formatCliHelp();

    expect(help).toContain('--host, --ip <host>');
    expect(help).toContain('--web-port <port>');
    expect(help).toContain('CLI overrides take precedence');
  });
});