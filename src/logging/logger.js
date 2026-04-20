// @ts-check
// Structured logging via pino

import pino from 'pino';

/** @import { LogConfig } from '../protocol/types.js' */

/**
 * @param {Partial<LogConfig>} [config]
 * @returns {pino.Logger}
 */
export function createLogger(config) {
  return pino({
    level: config?.level ?? 'info',
    transport: config?.pretty
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  });
}
