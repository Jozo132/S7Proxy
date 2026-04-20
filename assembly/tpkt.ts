// TPKT (RFC 1006) codec
// Header: Version (1 byte) | Reserved (1 byte) | Length (2 bytes, big-endian)
// Length includes the 4-byte TPKT header itself

import { TPKT_VERSION, TPKT_HEADER_SIZE } from './constants';
import { ERR_TPKT_INVALID_VERSION, ERR_TPKT_TOO_SHORT, ERR_TPKT_LENGTH_MISMATCH, setLastError, ERR_NONE } from './error';

// Parse result stored in module-level state for zero-alloc access
let _payloadOffset: u32 = 0;
let _payloadLength: u32 = 0;
let _totalLength: u32 = 0;

/** Parse a TPKT header from the buffer at `ptr` with `len` bytes available.
 *  Returns 0 on success, negative error code on failure.
 *  After success, use tpkt_getPayloadOffset/Length to read results. */
export function tpkt_parse(ptr: usize, len: u32): i32 {
  if (len < <u32>TPKT_HEADER_SIZE) {
    setLastError(ERR_TPKT_TOO_SHORT);
    return ERR_TPKT_TOO_SHORT;
  }

  const version = load<u8>(ptr);
  if (version !== TPKT_VERSION) {
    setLastError(ERR_TPKT_INVALID_VERSION);
    return ERR_TPKT_INVALID_VERSION;
  }

  // Length is big-endian u16 at offset 2
  const lenHi = load<u8>(ptr + 2);
  const lenLo = load<u8>(ptr + 3);
  const totalLen = (<u32>lenHi << 8) | <u32>lenLo;

  if (totalLen > len) {
    setLastError(ERR_TPKT_LENGTH_MISMATCH);
    return ERR_TPKT_LENGTH_MISMATCH;
  }

  _payloadOffset = <u32>TPKT_HEADER_SIZE;
  _payloadLength = totalLen - <u32>TPKT_HEADER_SIZE;
  _totalLength = totalLen;

  setLastError(ERR_NONE);
  return 0;
}

/** Build a TPKT header for a payload of `payloadLen` bytes.
 *  Writes 4 bytes to `outPtr`. Returns 4 (bytes written). */
export function tpkt_build(payloadLen: u16, outPtr: usize): u32 {
  const totalLen: u16 = payloadLen + <u16>TPKT_HEADER_SIZE;
  store<u8>(outPtr, TPKT_VERSION);
  store<u8>(outPtr + 1, 0x00); // Reserved
  store<u8>(outPtr + 2, <u8>(totalLen >> 8));
  store<u8>(outPtr + 3, <u8>(totalLen & 0xFF));
  return <u32>TPKT_HEADER_SIZE;
}

export function tpkt_getPayloadOffset(): u32 {
  return _payloadOffset;
}

export function tpkt_getPayloadLength(): u32 {
  return _payloadLength;
}

export function tpkt_getTotalLength(): u32 {
  return _totalLength;
}
