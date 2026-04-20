// @ts-check
// WASM module loader — loads and instantiates the AssemblyScript-compiled s7engine.wasm

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as loader from '@assemblyscript/loader';

/**
 * @typedef {Object} WasmExports
 * @property {WebAssembly.Memory} memory
 *
 * @property {(ptr: number, len: number) => number} tpkt_parse
 * @property {(payloadLen: number, outPtr: number) => number} tpkt_build
 * @property {() => number} tpkt_getPayloadOffset
 * @property {() => number} tpkt_getPayloadLength
 * @property {() => number} tpkt_getTotalLength
 *
 * @property {(ptr: number, len: number) => number} cotp_parse
 * @property {(srcTsap: number, dstTsap: number, outPtr: number) => number} cotp_buildCR
 * @property {(srcRef: number, dstRef: number, outPtr: number) => number} cotp_buildCC
 * @property {(lastUnit: number, outPtr: number) => number} cotp_buildDT
 * @property {(srcRef: number, dstRef: number, reason: number, outPtr: number) => number} cotp_buildDR
 * @property {() => number} cotp_getPduType
 * @property {() => number} cotp_getHeaderLength
 * @property {() => number} cotp_getSrcRef
 * @property {() => number} cotp_getDstRef
 * @property {() => number} cotp_getSrcTsap
 * @property {() => number} cotp_getDstTsap
 * @property {() => number} cotp_getTpduSize
 * @property {() => number} cotp_isLastDataUnit
 * @property {() => number} cotp_getReason
 * @property {() => number} cotp_getPayloadOffset
 *
 * @property {(ptr: number, len: number) => number} s7_parse
 * @property {(maxAmqCalling: number, maxAmqCalled: number, pduSize: number, outPtr: number) => number} s7_buildSetupComm
 * @property {(area: number, dbNum: number, start: number, amount: number, wordLen: number, outPtr: number) => number} s7_buildReadRequest
 * @property {(area: number, dbNum: number, start: number, amount: number, wordLen: number, dataPtr: number, dataLen: number, outPtr: number) => number} s7_buildWriteRequest
 * @property {(itemsPtr: number, itemCount: number, outPtr: number) => number} s7_buildMultiReadRequest
 * @property {() => number} s7_getMessageType
 * @property {() => number} s7_getFunctionCode
 * @property {() => number} s7_getPduRef
 * @property {() => number} s7_getParameterLength
 * @property {() => number} s7_getDataLength
 * @property {() => number} s7_getErrorClass
 * @property {() => number} s7_getErrorCode
 * @property {() => number} s7_getHeaderSize
 * @property {() => number} s7_getParamOffset
 * @property {() => number} s7_getDataOffset
 * @property {() => void} s7_resetSeqCounter
 *
 * @property {(s7Ptr: number, s7Len: number, outPtr: number) => number} frame_build
 * @property {(ptr: number, len: number) => number} frame_parse
 *
 * @property {(totalDataLen: number, maxPduSize: number) => number} pdu_needsSplit
 * @property {(maxPduSize: number) => number} pdu_maxPayload
 * @property {(totalDataLen: number, maxPduSize: number) => number} pdu_chunkCount
 *
 * @property {() => number} getLastError
 *
 * @property {(size: number) => number} scratchAlloc
 * @property {() => void} scratchReset
 * @property {() => number} getRxBufferOffset
 * @property {() => number} getTxBufferOffset
 * @property {() => number} getRxBufferSize
 * @property {() => number} getTxBufferSize
 */

/**
 * @typedef {Object} WasmImports
 * @property {(ptr: number, len: number) => void} log_debug
 * @property {(ptr: number, len: number) => void} log_error
 * @property {() => number} now_ms
 * @property {(oldPages: number, newPages: number) => void} memory_grown
 */

/**
 * @typedef {Object} WasmEngine
 * @property {*} instance
 * @property {WasmExports} exports
 * @property {WebAssembly.Memory} memory
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WASM_PATH = join(__dirname, '..', '..', 'build', 's7engine.wasm');

/** @type {WasmEngine | null} */
let cachedEngine = null;

/**
 * Load and instantiate the WASM engine.
 * @param {Partial<WasmImports>} [imports]
 * @returns {Promise<WasmEngine>}
 */
export async function loadWasmEngine(imports) {
  if (cachedEngine) return cachedEngine;

  const wasmBytes = await readFile(WASM_PATH);
  const wasmModule = await WebAssembly.compile(new Uint8Array(wasmBytes.buffer, wasmBytes.byteOffset, wasmBytes.byteLength));

  /** @type {WasmImports} */
  const hostImports = {
    log_debug: imports?.log_debug ?? (() => {}),
    log_error: imports?.log_error ?? (() => {}),
    now_ms: imports?.now_ms ?? (() => Date.now()),
    memory_grown: imports?.memory_grown ?? (() => {}),
  };

  const instance = await loader.instantiate(wasmModule, {
    env: /** @type {*} */ (hostImports),
  });

  /** @type {WasmEngine} */
  const engine = {
    instance,
    exports: /** @type {WasmExports} */ (/** @type {unknown} */ (instance.exports)),
    memory: /** @type {WebAssembly.Memory} */ (instance.exports.memory),
  };

  cachedEngine = engine;
  return engine;
}

export function resetWasmCache() {
  cachedEngine = null;
}
