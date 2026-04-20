// WASM module entry point — re-exports all public APIs
// This is the main module compiled to s7engine.wasm

// ─── Constants (re-export for host access) ───
export {
  S7AreaPE, S7AreaPA, S7AreaMK, S7AreaDB, S7AreaCT, S7AreaTM,
  S7WLBit, S7WLByte, S7WLWord, S7WLDWord, S7WLReal, S7WLCounter, S7WLTimer,
  BlockOB, BlockDB, BlockSDB, BlockFC, BlockSFC, BlockFB, BlockSFB,
  CONNTYPE_PG, CONNTYPE_OP, CONNTYPE_BASIC,
  TPKT_VERSION, TPKT_HEADER_SIZE,
  COTP_CR, COTP_CC, COTP_DT, COTP_DR,
  S7_PROTOCOL_ID, S7_MSG_JOB, S7_MSG_ACK, S7_MSG_ACK_DATA, S7_MSG_USERDATA,
  S7_FN_SETUP_COMM, S7_FN_READ_VAR, S7_FN_WRITE_VAR,
  MAX_PDU_SIZE, MIN_PDU_SIZE, DEFAULT_PDU_SIZE, MAX_AMQ, DEFAULT_AMQ,
  RX_BUFFER_OFFSET, RX_BUFFER_SIZE, TX_BUFFER_OFFSET, TX_BUFFER_SIZE,
} from './constants';

// ─── Error handling ───
export { getLastError, getErrorText } from './error';

// ─── Memory helpers ───
export {
  scratchAlloc, scratchReset,
  getRxBufferOffset, getTxBufferOffset,
  getRxBufferSize, getTxBufferSize,
} from './memory';

// ─── TPKT codec ───
export {
  tpkt_parse, tpkt_build,
  tpkt_getPayloadOffset, tpkt_getPayloadLength, tpkt_getTotalLength,
} from './tpkt';

// ─── COTP codec ───
export {
  cotp_parse, cotp_buildCR, cotp_buildCC, cotp_buildDT, cotp_buildDR,
  cotp_getPduType, cotp_getHeaderLength,
  cotp_getSrcRef, cotp_getDstRef, cotp_getSrcTsap, cotp_getDstTsap,
  cotp_getTpduSize, cotp_isLastDataUnit, cotp_getReason, cotp_getPayloadOffset,
} from './cotp';

// ─── S7Comm codec ───
export {
  s7_parse, s7_buildSetupComm, s7_buildReadRequest, s7_buildWriteRequest, s7_buildBitWriteRequest,
  s7_buildMultiReadRequest,
  s7_getMessageType, s7_getFunctionCode, s7_getPduRef,
  s7_getParameterLength, s7_getDataLength,
  s7_getErrorClass, s7_getErrorCode,
  s7_getHeaderSize, s7_getParamOffset, s7_getDataOffset,
  s7_resetSeqCounter,
} from './s7comm';

// ─── PDU Splitter ───
export {
  pdu_needsSplit, pdu_maxPayload, pdu_chunkCount,
} from './pdu-splitter';

// ─── Full frame assembly helpers ───

import { tpkt_parse, tpkt_build, tpkt_getPayloadOffset, tpkt_getPayloadLength } from './tpkt';
import { cotp_parse, cotp_buildDT, cotp_getPduType, cotp_getPayloadOffset } from './cotp';
import { COTP_DT } from './constants';
import { s7_parse } from './s7comm';
import { setLastError, ERR_FRAME_TOO_SHORT, ERR_FRAME_PARSE_FAILED, ERR_NONE } from './error';

/** Build a complete TPKT + COTP DT + S7 frame.
 *  Writes to outPtr. Returns total frame length. */
export function frame_build(s7Ptr: usize, s7Len: u32, outPtr: usize): u32 {
  // COTP DT header (3 bytes)
  const cotpLen: u32 = 3;
  const payloadLen: u16 = <u16>(cotpLen + s7Len);

  // TPKT header
  const tpktLen = tpkt_build(payloadLen, outPtr);

  // COTP DT
  cotp_buildDT(true, outPtr + tpktLen);

  // S7 payload
  memory.copy(outPtr + tpktLen + cotpLen, s7Ptr, s7Len);

  return tpktLen + cotpLen + s7Len;
}

/** Parse a complete TPKT + COTP + S7 frame.
 *  Returns 0 on success. After success, use individual getters for parsed fields. */
export function frame_parse(ptr: usize, len: u32): i32 {
  if (len < 7) {
    setLastError(ERR_FRAME_TOO_SHORT);
    return ERR_FRAME_TOO_SHORT;
  }

  // Parse TPKT
  let rc = tpkt_parse(ptr, len);
  if (rc !== 0) return rc;

  const tpktPayloadOff = tpkt_getPayloadOffset();
  const tpktPayloadLen = tpkt_getPayloadLength();

  // Parse COTP
  rc = cotp_parse(ptr + tpktPayloadOff, tpktPayloadLen);
  if (rc !== 0) return rc;

  // If it's a DT frame, parse S7 payload
  if (cotp_getPduType() === COTP_DT) {
    const cotpPayloadOff = cotp_getPayloadOffset();
    const s7Ptr = ptr + tpktPayloadOff + cotpPayloadOff;
    const s7Len = tpktPayloadLen - cotpPayloadOff;

    if (s7Len > 0) {
      rc = s7_parse(s7Ptr, s7Len);
      if (rc !== 0) return rc;
    }
  }

  setLastError(ERR_NONE);
  return 0;
}
