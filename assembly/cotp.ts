// COTP (ISO 8073 / RFC 905) codec
// Handles CR (Connection Request), CC (Connection Confirm), DT (Data), DR (Disconnect)

import {
  COTP_CR, COTP_CC, COTP_DT, COTP_DR,
  COTP_PARAM_TPDU_SIZE, COTP_PARAM_SRC_TSAP, COTP_PARAM_DST_TSAP,
} from './constants';
import {
  ERR_COTP_TOO_SHORT, ERR_COTP_UNKNOWN_TYPE, ERR_COTP_INVALID_LENGTH,
  ERR_NONE, setLastError,
} from './error';

// ─── Parse state ───
let _pduType: u8 = 0;
let _headerLength: u8 = 0;
let _srcRef: u16 = 0;
let _dstRef: u16 = 0;
let _srcTsap: u16 = 0;
let _dstTsap: u16 = 0;
let _tpduSize: u8 = 0;
let _lastDataUnit: bool = false;
let _reason: u8 = 0;
let _payloadOffset: u32 = 0;

/** Parse a COTP TPDU from buffer at `ptr` with `len` bytes.
 *  Returns 0 on success, negative on error. */
export function cotp_parse(ptr: usize, len: u32): i32 {
  if (len < 2) {
    setLastError(ERR_COTP_TOO_SHORT);
    return ERR_COTP_TOO_SHORT;
  }

  const headerLen = load<u8>(ptr);     // Length indicator (bytes following this byte)
  const pduTypeRaw = load<u8>(ptr + 1);
  const pduType = pduTypeRaw & 0xF0;  // High nibble is the PDU type

  if (<u32>(headerLen + 1) > len) {
    setLastError(ERR_COTP_INVALID_LENGTH);
    return ERR_COTP_INVALID_LENGTH;
  }

  _headerLength = headerLen;
  _pduType = pduType;
  _srcTsap = 0;
  _dstTsap = 0;
  _tpduSize = 0;
  _srcRef = 0;
  _dstRef = 0;
  _lastDataUnit = false;
  _reason = 0;
  _payloadOffset = <u32>(headerLen + 1);

  if (pduType === COTP_CR || pduType === COTP_CC) {
    // CR/CC: Length(1) | Type(1) | DstRef(2) | SrcRef(2) | Class(1) | [params...]
    if (len < 7) {
      setLastError(ERR_COTP_TOO_SHORT);
      return ERR_COTP_TOO_SHORT;
    }
    _dstRef = (<u16>load<u8>(ptr + 2) << 8) | <u16>load<u8>(ptr + 3);
    _srcRef = (<u16>load<u8>(ptr + 4) << 8) | <u16>load<u8>(ptr + 5);

    // Parse variable parameters starting at offset 7
    let paramOff: u32 = 7;
    const paramEnd: u32 = <u32>(headerLen + 1);
    while (paramOff + 2 < paramEnd) {
      const paramCode = load<u8>(ptr + paramOff);
      const paramLen = load<u8>(ptr + paramOff + 1);
      if (paramOff + 2 + <u32>paramLen > paramEnd) break;

      if (paramCode === COTP_PARAM_SRC_TSAP && paramLen >= 2) {
        _srcTsap = (<u16>load<u8>(ptr + paramOff + 2) << 8) | <u16>load<u8>(ptr + paramOff + 3);
      } else if (paramCode === COTP_PARAM_DST_TSAP && paramLen >= 2) {
        _dstTsap = (<u16>load<u8>(ptr + paramOff + 2) << 8) | <u16>load<u8>(ptr + paramOff + 3);
      } else if (paramCode === COTP_PARAM_TPDU_SIZE && paramLen >= 1) {
        _tpduSize = load<u8>(ptr + paramOff + 2);
      }
      paramOff += 2 + <u32>paramLen;
    }
  } else if (pduType === COTP_DT) {
    // DT: Length(1=2) | Type+Nr(1) | [payload]
    // The last data unit flag is bit 7 of the second byte
    _lastDataUnit = (pduTypeRaw & 0x80) !== 0;
    // DT header is typically 2 bytes (length indicator = 2, meaning 2 bytes follow the LI)
    // Actually: LI = 0x02, then PDU type byte (0xF0 | EOT), then TPDU-NR byte
    if (headerLen >= 2) {
      _payloadOffset = <u32>(headerLen + 1);
    }
  } else if (pduType === COTP_DR) {
    // DR: Length(1) | Type(1) | DstRef(2) | SrcRef(2) | Reason(1)
    if (len < 7) {
      setLastError(ERR_COTP_TOO_SHORT);
      return ERR_COTP_TOO_SHORT;
    }
    _dstRef = (<u16>load<u8>(ptr + 2) << 8) | <u16>load<u8>(ptr + 3);
    _srcRef = (<u16>load<u8>(ptr + 4) << 8) | <u16>load<u8>(ptr + 5);
    _reason = load<u8>(ptr + 6);
  } else {
    setLastError(ERR_COTP_UNKNOWN_TYPE);
    return ERR_COTP_UNKNOWN_TYPE;
  }

  setLastError(ERR_NONE);
  return 0;
}

/** Build a COTP Connection Request (CR) TPDU.
 *  Returns bytes written. */
export function cotp_buildCR(srcTsap: u16, dstTsap: u16, outPtr: usize): u32 {
  // CR: LI | 0xE0 | DstRef(0x0000) | SrcRef(0x0001) | Class(0x00) | Params
  const LI_POS = outPtr;
  let off: usize = outPtr + 1;

  store<u8>(off, COTP_CR); off += 1;            // PDU type
  store<u8>(off, 0x00); store<u8>(off + 1, 0x00); off += 2; // DstRef = 0
  store<u8>(off, 0x00); store<u8>(off + 1, 0x01); off += 2; // SrcRef = 1
  store<u8>(off, 0x00); off += 1;                // Class 0, no extended formats

  // Param: TPDU size (0xC0) — request 1024 bytes
  store<u8>(off, COTP_PARAM_TPDU_SIZE); off += 1;
  store<u8>(off, 0x01); off += 1;               // param length = 1
  store<u8>(off, 0x0A); off += 1;               // 2^10 = 1024

  // Param: Src TSAP (0xC1)
  store<u8>(off, COTP_PARAM_SRC_TSAP); off += 1;
  store<u8>(off, 0x02); off += 1;
  store<u8>(off, <u8>(srcTsap >> 8)); off += 1;
  store<u8>(off, <u8>(srcTsap & 0xFF)); off += 1;

  // Param: Dst TSAP (0xC2)
  store<u8>(off, COTP_PARAM_DST_TSAP); off += 1;
  store<u8>(off, 0x02); off += 1;
  store<u8>(off, <u8>(dstTsap >> 8)); off += 1;
  store<u8>(off, <u8>(dstTsap & 0xFF)); off += 1;

  const totalLen = <u32>(off - outPtr - 1);
  store<u8>(LI_POS, <u8>totalLen);  // Length indicator = bytes after LI

  return <u32>(off - outPtr);
}

/** Build a COTP Connection Confirm (CC) TPDU. */
export function cotp_buildCC(srcRef: u16, dstRef: u16, outPtr: usize): u32 {
  const LI_POS = outPtr;
  let off: usize = outPtr + 1;

  store<u8>(off, COTP_CC); off += 1;
  store<u8>(off, <u8>(dstRef >> 8)); store<u8>(off + 1, <u8>(dstRef & 0xFF)); off += 2;
  store<u8>(off, <u8>(srcRef >> 8)); store<u8>(off + 1, <u8>(srcRef & 0xFF)); off += 2;
  store<u8>(off, 0x00); off += 1;  // Class 0

  // TPDU size param
  store<u8>(off, COTP_PARAM_TPDU_SIZE); off += 1;
  store<u8>(off, 0x01); off += 1;
  store<u8>(off, 0x0A); off += 1;  // 1024

  const totalLen = <u32>(off - outPtr - 1);
  store<u8>(LI_POS, <u8>totalLen);

  return <u32>(off - outPtr);
}

/** Build a COTP Data Transfer (DT) header.
 *  Returns 3 (bytes written). Payload follows after. */
export function cotp_buildDT(lastUnit: bool, outPtr: usize): u32 {
  store<u8>(outPtr, 0x02);  // LI = 2
  store<u8>(outPtr + 1, 0xF0);  // PDU type: DT (always 0xF0)
  store<u8>(outPtr + 2, lastUnit ? 0x80 : 0x00);  // EOT flag (bit 7) + TPDU-NR
  return 3;
}

/** Build a COTP Disconnect Request (DR). */
export function cotp_buildDR(srcRef: u16, dstRef: u16, reason: u8, outPtr: usize): u32 {
  store<u8>(outPtr, 0x06);  // LI = 6
  store<u8>(outPtr + 1, COTP_DR);
  store<u8>(outPtr + 2, <u8>(dstRef >> 8));
  store<u8>(outPtr + 3, <u8>(dstRef & 0xFF));
  store<u8>(outPtr + 4, <u8>(srcRef >> 8));
  store<u8>(outPtr + 5, <u8>(srcRef & 0xFF));
  store<u8>(outPtr + 6, reason);
  return 7;
}

// ─── Getters ───
export function cotp_getPduType(): u8 { return _pduType; }
export function cotp_getHeaderLength(): u8 { return _headerLength; }
export function cotp_getSrcRef(): u16 { return _srcRef; }
export function cotp_getDstRef(): u16 { return _dstRef; }
export function cotp_getSrcTsap(): u16 { return _srcTsap; }
export function cotp_getDstTsap(): u16 { return _dstTsap; }
export function cotp_getTpduSize(): u8 { return _tpduSize; }
export function cotp_isLastDataUnit(): bool { return _lastDataUnit; }
export function cotp_getReason(): u8 { return _reason; }
export function cotp_getPayloadOffset(): u32 { return _payloadOffset; }
