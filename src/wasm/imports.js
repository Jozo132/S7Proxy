// @ts-check
// Host import functions provided to WASM module

import pino from 'pino';

/**
 * Create WASM host imports.
 * @param {pino.Logger} logger
 * @returns {import('./loader.js').WasmImports}
 */
export function createWasmImports(logger) {
  return {
    log_debug(_ptr, _len) {
      logger.debug('WASM debug');
    },
    log_error(_ptr, _len) {
      logger.error('WASM error');
    },
    now_ms() {
      return Date.now();
    },
    memory_grown(oldPages, newPages) {
      logger.debug({ oldPages, newPages }, 'WASM memory grown');
    },
  };
}
