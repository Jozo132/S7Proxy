// Error code definitions for S7 protocol engine

export const ERR_NONE: i32 = 0;
export const ERR_TPKT_INVALID_VERSION: i32 = -1;
export const ERR_TPKT_TOO_SHORT: i32 = -2;
export const ERR_TPKT_LENGTH_MISMATCH: i32 = -3;
export const ERR_COTP_TOO_SHORT: i32 = -10;
export const ERR_COTP_UNKNOWN_TYPE: i32 = -11;
export const ERR_COTP_INVALID_LENGTH: i32 = -12;
export const ERR_S7_INVALID_PROTOCOL_ID: i32 = -20;
export const ERR_S7_TOO_SHORT: i32 = -21;
export const ERR_S7_INVALID_MSG_TYPE: i32 = -22;
export const ERR_S7_DATA_TOO_LONG: i32 = -23;
export const ERR_FRAME_TOO_SHORT: i32 = -30;
export const ERR_FRAME_PARSE_FAILED: i32 = -31;
export const ERR_BUFFER_OVERFLOW: i32 = -40;
export const ERR_INVALID_ARGUMENT: i32 = -41;

let lastError: i32 = ERR_NONE;

export function setLastError(code: i32): void {
  lastError = code;
}

export function getLastError(): i32 {
  return lastError;
}

export function getErrorText(code: i32): string {
  switch (code) {
    case ERR_NONE: return "No error";
    case ERR_TPKT_INVALID_VERSION: return "TPKT: Invalid version (expected 0x03)";
    case ERR_TPKT_TOO_SHORT: return "TPKT: Buffer too short for header";
    case ERR_TPKT_LENGTH_MISMATCH: return "TPKT: Length field exceeds buffer";
    case ERR_COTP_TOO_SHORT: return "COTP: Buffer too short";
    case ERR_COTP_UNKNOWN_TYPE: return "COTP: Unknown PDU type";
    case ERR_COTP_INVALID_LENGTH: return "COTP: Invalid length indicator";
    case ERR_S7_INVALID_PROTOCOL_ID: return "S7: Invalid protocol ID (expected 0x32)";
    case ERR_S7_TOO_SHORT: return "S7: Buffer too short for header";
    case ERR_S7_INVALID_MSG_TYPE: return "S7: Unknown message type";
    case ERR_S7_DATA_TOO_LONG: return "S7: Data exceeds PDU size";
    case ERR_FRAME_TOO_SHORT: return "Frame: Buffer too short";
    case ERR_FRAME_PARSE_FAILED: return "Frame: Full frame parse failed";
    case ERR_BUFFER_OVERFLOW: return "Buffer overflow";
    case ERR_INVALID_ARGUMENT: return "Invalid argument";
    default: return "Unknown error";
  }
}
