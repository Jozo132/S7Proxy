// @ts-check

/**
 * @typedef {Object} CliOverrides
 * @property {string} [listenIp]
 * @property {number} [listenPort]
 * @property {string} [webHost]
 * @property {number} [webPort]
 */

/**
 * @typedef {Object} ParsedCliArgs
 * @property {string | undefined} configPath
 * @property {CliOverrides} overrides
 * @property {boolean} help
 */

/**
 * @param {string[]} argv
 * @returns {ParsedCliArgs}
 */
export function parseCliArgs(argv) {
  /** @type {ParsedCliArgs} */
  const parsed = {
    configPath: undefined,
    overrides: {},
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;

    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }

    if (!arg.startsWith('-')) {
      if (parsed.configPath === undefined) {
        parsed.configPath = arg;
        continue;
      }
      throw new Error(`Unexpected positional argument: ${arg}`);
    }

    const equalsIndex = arg.indexOf('=');
    const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : arg.slice(equalsIndex + 1);
    const value = inlineValue ?? readFlagValue(flag, argv, index);
    const consumedNextArg = inlineValue === undefined;

    switch (flag) {
      case '--config':
      case '-c':
        parsed.configPath = value;
        break;
      case '--host':
      case '--ip':
      case '--listen-host':
      case '--listen-ip':
        parsed.overrides.listenIp = value;
        break;
      case '--port':
      case '--listen-port':
        parsed.overrides.listenPort = parsePortValue(value, flag);
        break;
      case '--web-host':
      case '--web-api-host':
        parsed.overrides.webHost = value;
        break;
      case '--web-port':
      case '--web-api-port':
        parsed.overrides.webPort = parsePortValue(value, flag);
        break;
      default:
        throw new Error(`Unknown option: ${flag}`);
    }

    if (consumedNextArg) index += 1;
  }

  return parsed;
}

/**
 * @param {string} [binName]
 * @returns {string}
 */
export function formatCliHelp(binName = 's7proxy') {
  return [
    `Usage: ${binName} [config-path] [options]`,
    '',
    'Options:',
    '  -c, --config <path>        Path to JSON or .env config file',
    '      --host, --ip <host>    Override listen.ip',
    '      --port <port>          Override listen.port',
    '      --web-host <host>      Override webApi.host',
    '      --web-port <port>      Override webApi.port',
    '  -h, --help                 Show this help message',
    '',
    'CLI overrides take precedence over environment variables and config files.',
  ].join('\n');
}

/**
 * @param {string} flag
 * @param {string[]} argv
 * @param {number} index
 * @returns {string}
 */
function readFlagValue(flag, argv, index) {
  const nextValue = argv[index + 1];
  if (!nextValue || nextValue.startsWith('-')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return nextValue;
}

/**
 * @param {string} rawValue
 * @param {string} flag
 * @returns {number}
 */
function parsePortValue(rawValue, flag) {
  if (!/^\d+$/u.test(rawValue)) {
    throw new Error(`Invalid port for ${flag}: ${rawValue}`);
  }

  const value = Number.parseInt(rawValue, 10);
  if (value < 1 || value > 65535) {
    throw new Error(`Port out of range for ${flag}: ${rawValue}`);
  }

  return value;
}