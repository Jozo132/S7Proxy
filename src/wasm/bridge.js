// @ts-check
// JS ↔ WASM bridge — high-level typed wrapper around WASM exports

/** @import { WasmEngine, WasmExports, WasmImports } from './loader.js' */
/** @import { ParsedPDU } from '../protocol/types.js' */

export class WasmBridge {
  /** @type {WasmEngine} */
  #engine;
  /** @type {Uint8Array} */
  #wasmMemory;

  /** @param {WasmEngine} engine */
  constructor(engine) {
    this.#engine = engine;
    this.#wasmMemory = new Uint8Array(engine.memory.buffer);
  }

  #refreshMemoryView() {
    if (this.#wasmMemory.buffer !== this.#engine.memory.buffer) {
      this.#wasmMemory = new Uint8Array(this.#engine.memory.buffer);
    }
  }

  /**
   * Copy Node.js Buffer into WASM memory at the RX buffer region. Returns offset written to.
   * @param {Buffer} data
   * @param {number} [offset=0]
   * @returns {number}
   */
  copyToRx(data, offset = 0) {
    this.#refreshMemoryView();
    const rxBase = this.#engine.exports.getRxBufferOffset();
    const rxSize = this.#engine.exports.getRxBufferSize();
    const writeOffset = rxBase + offset;

    if (offset + data.length > rxSize) {
      throw new Error(`Data (${data.length} bytes) exceeds RX buffer capacity at offset ${offset}`);
    }

    this.#wasmMemory.set(data, writeOffset);
    return writeOffset;
  }

  /**
   * Read bytes from WASM TX buffer region into a Node.js Buffer.
   * @param {number} offset
   * @param {number} length
   * @returns {Buffer}
   */
  readFromTx(offset, length) {
    this.#refreshMemoryView();
    const txBase = this.#engine.exports.getTxBufferOffset();
    return Buffer.from(this.#wasmMemory.slice(txBase + offset, txBase + offset + length));
  }

  /**
   * Read bytes from arbitrary WASM memory offset.
   * @param {number} offset
   * @param {number} length
   * @returns {Buffer}
   */
  readMemory(offset, length) {
    this.#refreshMemoryView();
    return Buffer.from(this.#wasmMemory.slice(offset, offset + length));
  }

  /**
   * Copy data to scratch area. Returns WASM pointer.
   * @param {Buffer} data
   * @returns {number}
   */
  copyToScratch(data) {
    this.#refreshMemoryView();
    const ptr = this.#engine.exports.scratchAlloc(data.length);
    if (ptr === 0) throw new Error('WASM scratch area OOM');
    this.#wasmMemory.set(data, ptr);
    return ptr;
  }

  /**
   * Parse a complete TPKT+COTP+S7 frame.
   * @param {Buffer} frame
   * @returns {{ cotpType: number; pdu: ParsedPDU | null }}
   */
  parseFrame(frame) {
    const wasmPtr = this.copyToRx(frame);
    const e = this.#engine.exports;

    const rc = e.frame_parse(wasmPtr, frame.length);
    if (rc !== 0) {
      throw new Error(`Frame parse error: ${rc} (WASM error: ${e.getLastError()})`);
    }

    const cotpType = e.cotp_getPduType();

    // Only DT frames have S7 payload
    if (cotpType !== 0xF0) {
      return { cotpType, pdu: null };
    }

    /** @type {ParsedPDU} */
    const pdu = {
      raw: frame,
      messageType: e.s7_getMessageType(),
      functionCode: e.s7_getFunctionCode(),
      pduRef: e.s7_getPduRef(),
      paramLength: e.s7_getParameterLength(),
      dataLength: e.s7_getDataLength(),
      errorClass: e.s7_getErrorClass(),
      errorCode: e.s7_getErrorCode(),
    };

    return { cotpType, pdu };
  }

  /**
   * Build a COTP Connection Request frame (TPKT + COTP CR).
   * @param {number} srcTsap
   * @param {number} dstTsap
   * @returns {Buffer}
   */
  buildCotpCR(srcTsap, dstTsap) {
    const e = this.#engine.exports;
    this.#refreshMemoryView();

    const txBase = e.getTxBufferOffset();
    const cotpLen = e.cotp_buildCR(srcTsap, dstTsap, txBase + 4);
    e.tpkt_build(cotpLen, txBase);

    const totalLen = 4 + cotpLen;
    return this.readFromTx(0, totalLen);
  }

  /**
   * Build a COTP Connection Confirm frame.
   * @param {number} srcRef
   * @param {number} dstRef
   * @returns {Buffer}
   */
  buildCotpCC(srcRef, dstRef) {
    const e = this.#engine.exports;
    this.#refreshMemoryView();

    const txBase = e.getTxBufferOffset();
    const cotpLen = e.cotp_buildCC(srcRef, dstRef, txBase + 4);
    e.tpkt_build(cotpLen, txBase);

    return this.readFromTx(0, 4 + cotpLen);
  }

  /**
   * Build a COTP Disconnect Request frame.
   * @param {number} srcRef
   * @param {number} dstRef
   * @param {number} [reason=0]
   * @returns {Buffer}
   */
  buildCotpDR(srcRef, dstRef, reason = 0) {
    const e = this.#engine.exports;
    this.#refreshMemoryView();

    const txBase = e.getTxBufferOffset();
    const cotpLen = e.cotp_buildDR(srcRef, dstRef, reason, txBase + 4);
    e.tpkt_build(cotpLen, txBase);

    return this.readFromTx(0, 4 + cotpLen);
  }

  /**
   * Build a complete TPKT+COTP DT+S7 Setup Communication frame.
   * @param {number} maxAmqCalling
   * @param {number} maxAmqCalled
   * @param {number} pduSize
   * @returns {Buffer}
   */
  buildSetupComm(maxAmqCalling, maxAmqCalled, pduSize) {
    const e = this.#engine.exports;
    this.#refreshMemoryView();

    e.scratchReset();
    const scratchPtr = e.scratchAlloc(256);
    const s7Len = e.s7_buildSetupComm(maxAmqCalling, maxAmqCalled, pduSize, scratchPtr);

    const txBase = e.getTxBufferOffset();
    const totalLen = e.frame_build(scratchPtr, s7Len, txBase);

    return this.readFromTx(0, totalLen);
  }

  /**
   * Build S7 Read Var request frame.
   * @param {number} area
   * @param {number} dbNum
   * @param {number} start
   * @param {number} amount
   * @param {number} wordLen
   * @returns {Buffer}
   */
  buildReadRequest(area, dbNum, start, amount, wordLen) {
    const e = this.#engine.exports;
    this.#refreshMemoryView();

    e.scratchReset();
    const scratchPtr = e.scratchAlloc(256);
    const s7Len = e.s7_buildReadRequest(area, dbNum, start, amount, wordLen, scratchPtr);

    const txBase = e.getTxBufferOffset();
    const totalLen = e.frame_build(scratchPtr, s7Len, txBase);

    return this.readFromTx(0, totalLen);
  }

  /**
   * Build S7 Write Var request frame.
   * @param {number} area
   * @param {number} dbNum
   * @param {number} start
   * @param {number} amount
   * @param {number} wordLen
   * @param {Buffer} data
   * @returns {Buffer}
   */
  buildWriteRequest(area, dbNum, start, amount, wordLen, data) {
    const e = this.#engine.exports;
    this.#refreshMemoryView();

    e.scratchReset();
    const dataPtr = this.copyToScratch(data);
    const scratchPtr = e.scratchAlloc(256);
    const s7Len = e.s7_buildWriteRequest(area, dbNum, start, amount, wordLen, dataPtr, data.length, scratchPtr);

    const txBase = e.getTxBufferOffset();
    const totalLen = e.frame_build(scratchPtr, s7Len, txBase);

    return this.readFromTx(0, totalLen);
  }

  /** @returns {WasmExports} */
  get exports() {
    return this.#engine.exports;
  }
}
