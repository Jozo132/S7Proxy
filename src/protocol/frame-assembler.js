// @ts-check
// TCP stream → TPKT frame assembler
// Buffers incoming TCP data and emits complete TPKT frames

import { TPKT_HEADER_SIZE } from './constants.js';

export class FrameAssembler {
  /** @type {Buffer} */
  #buffer = Buffer.alloc(0);

  /**
   * Feed incoming TCP data and extract complete TPKT frames.
   * @param {Buffer} data
   * @returns {Buffer[]}
   */
  feed(data) {
    this.#buffer = this.#buffer.length === 0
      ? data
      : Buffer.concat([this.#buffer, data]);

    /** @type {Buffer[]} */
    const frames = [];

    while (this.#buffer.length >= TPKT_HEADER_SIZE) {
      // Validate TPKT version
      if (this.#buffer[0] !== 0x03) {
        // Invalid TPKT — skip one byte and retry
        this.#buffer = this.#buffer.subarray(1);
        continue;
      }

      const tpktLen = this.#buffer.readUInt16BE(2);

      if (tpktLen < TPKT_HEADER_SIZE) {
        // Malformed — skip
        this.#buffer = this.#buffer.subarray(1);
        continue;
      }

      if (this.#buffer.length < tpktLen) {
        // Incomplete frame — wait for more data
        break;
      }

      frames.push(this.#buffer.subarray(0, tpktLen));
      this.#buffer = this.#buffer.subarray(tpktLen);
    }

    return frames;
  }

  reset() {
    this.#buffer = Buffer.alloc(0);
  }

  get pendingBytes() {
    return this.#buffer.length;
  }
}
