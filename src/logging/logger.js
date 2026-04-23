// @ts-check
// Lightweight structured logger with a pino-like shape.

/** @import { LogConfig } from '../protocol/types.js' */

const LEVELS = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: 100,
};

/**
 * @param {unknown[]} args
 * @returns {{ message: string, fields: Record<string, unknown> }}
 */
function splitLogArgs(args) {
  /** @type {Record<string, unknown>} */
  const fields = {};
  /** @type {string[]} */
  const messages = [];

  for (const arg of args) {
    if (typeof arg === 'string') {
      messages.push(arg);
      continue;
    }

    if (arg && typeof arg === 'object' && !Array.isArray(arg) && !Buffer.isBuffer(arg)) {
      Object.assign(fields, /** @type {Record<string, unknown>} */ (arg));
      continue;
    }

    messages.push(String(arg));
  }

  return {
    message: messages.join(' ').trim(),
    fields,
  };
}

export class Logger {
  /** @type {keyof typeof LEVELS} */
  #level;
  /** @type {Record<string, unknown>} */
  #bindings;
  /** @type {boolean} */
  #pretty;

  /**
   * @param {keyof typeof LEVELS} level
   * @param {Record<string, unknown>} [bindings]
   * @param {boolean} [pretty]
   */
  constructor(level, bindings = {}, pretty = false) {
    this.#level = level;
    this.#bindings = bindings;
    this.#pretty = pretty;
  }

  /**
   * @param {Record<string, unknown>} [bindings]
   * @returns {Logger}
   */
  child(bindings = {}) {
    return new Logger(this.#level, { ...this.#bindings, ...bindings }, this.#pretty);
  }

  /** @param {...unknown} args */ trace(...args) { this.#write('trace', args); }
  /** @param {...unknown} args */ debug(...args) { this.#write('debug', args); }
  /** @param {...unknown} args */ info(...args) { this.#write('info', args); }
  /** @param {...unknown} args */ warn(...args) { this.#write('warn', args); }
  /** @param {...unknown} args */ error(...args) { this.#write('error', args); }
  /** @param {...unknown} args */ fatal(...args) { this.#write('fatal', args); }

  /**
   * @param {keyof typeof LEVELS} level
   * @param {unknown[]} args
   */
  #write(level, args) {
    if (LEVELS[level] < LEVELS[this.#level]) return;
    if (this.#level === 'silent') return;

    const { message, fields } = splitLogArgs(args);
    const entry = {
      level,
      time: new Date().toISOString(),
      ...this.#bindings,
      ...fields,
      ...(message ? { msg: message } : {}),
    };

    if (this.#pretty) {
      const prefix = `[${entry.time}] ${level.toUpperCase()}`;
      const tail = message ? ` ${message}` : '';
      const extras = /** @type {Record<string, unknown>} */ ({ ...entry });
      delete extras['level'];
      delete extras['time'];
      delete extras.msg;
      const serializedExtras = Object.keys(extras).length > 0 ? ` ${JSON.stringify(extras)}` : '';
      console.error(`${prefix}${tail}${serializedExtras}`);
      return;
    }

    console.error(JSON.stringify(entry));
  }
}

/**
 * @param {Partial<LogConfig>} [config]
 * @returns {Logger}
 */
export function createLogger(config) {
  return new Logger(config?.level ?? 'info', {}, config?.pretty === true);
}
