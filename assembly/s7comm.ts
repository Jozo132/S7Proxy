// S7Comm protocol codec
// Header: ProtocolID(1) | MsgType(1) | Reserved(2) | PDURef(2) | ParamLen(2) | DataLen(2)
// For AckData: additional ErrorClass(1) | ErrorCode(1) before params

import {
  S7_PROTOCOL_ID, S7_MSG_JOB, S7_MSG_ACK, S7_MSG_ACK_DATA, S7_MSG_USERDATA,
  S7_FN_SETUP_COMM, S7_FN_READ_VAR, S7_FN_WRITE_VAR,
  S7_TRANSPORT_SIZE_BIT, S7_TRANSPORT_SIZE_BYTE, S7_TRANSPORT_SIZE_INT,
  S7_TRANSPORT_SIZE_REAL, S7_TRANSPORT_SIZE_OCTET,
  S7WLBit, S7WLChar, S7WLInt, S7WLDInt, S7WLReal, S7WLCounter, S7WLTimer,
  S7AreaDB,
} from './constants';
import {
  ERR_S7_INVALID_PROTOCOL_ID, ERR_S7_TOO_SHORT, ERR_S7_INVALID_MSG_TYPE,
  ERR_NONE, setLastError,
} from './error';

// ─── Parse state ───
let _msgType: u8 = 0;
let _reserved: u16 = 0;
let _pduRef: u16 = 0;
let _paramLength: u16 = 0;
let _dataLength: u16 = 0;
let _errorClass: u8 = 0;
let _errorCode: u8 = 0;
let _functionCode: u8 = 0;
let _headerSize: u32 = 0;
let _paramOffset: u32 = 0;
let _dataOffset: u32 = 0;

function getWriteDataTransportSize(wordLen: u8): u8 {
  switch (wordLen) {
    case S7WLBit:
      return S7_TRANSPORT_SIZE_BIT;
    case S7WLInt:
    case S7WLDInt:
      return S7_TRANSPORT_SIZE_INT;
    case S7WLReal:
      return S7_TRANSPORT_SIZE_REAL;
    case S7WLChar:
    case S7WLCounter:
    case S7WLTimer:
      return S7_TRANSPORT_SIZE_OCTET;
    default:
      return S7_TRANSPORT_SIZE_BYTE;
  }
}

function writeDataLengthUsesBytes(transportSize: u8): bool {
  return transportSize === S7_TRANSPORT_SIZE_OCTET
    || transportSize === S7_TRANSPORT_SIZE_REAL
    || transportSize === S7_TRANSPORT_SIZE_BIT;
}

/** Parse S7Comm header from buffer at `ptr` with `len` bytes.
 *  Returns 0 on success, negative on error. */
export function s7_parse(ptr: usize, len: u32): i32 {
  if (len < 10) {
    setLastError(ERR_S7_TOO_SHORT);
    return ERR_S7_TOO_SHORT;
  }

  const protocolId = load<u8>(ptr);
  if (protocolId !== S7_PROTOCOL_ID) {
    setLastError(ERR_S7_INVALID_PROTOCOL_ID);
    return ERR_S7_INVALID_PROTOCOL_ID;
  }

  _msgType = load<u8>(ptr + 1);
  _reserved = (<u16>load<u8>(ptr + 2) << 8) | <u16>load<u8>(ptr + 3);
  _pduRef = (<u16>load<u8>(ptr + 4) << 8) | <u16>load<u8>(ptr + 5);
  _paramLength = (<u16>load<u8>(ptr + 6) << 8) | <u16>load<u8>(ptr + 7);
  _dataLength = (<u16>load<u8>(ptr + 8) << 8) | <u16>load<u8>(ptr + 9);

  _errorClass = 0;
  _errorCode = 0;
  _functionCode = 0;

  if (_msgType === S7_MSG_ACK_DATA || _msgType === S7_MSG_ACK) {
    // Ack/AckData have 2 extra bytes (error class + error code) after the main header
    if (len < 12) {
      setLastError(ERR_S7_TOO_SHORT);
      return ERR_S7_TOO_SHORT;
    }
    _errorClass = load<u8>(ptr + 10);
    _errorCode = load<u8>(ptr + 11);
    _headerSize = 12;
  } else if (_msgType === S7_MSG_JOB || _msgType === S7_MSG_USERDATA) {
    _headerSize = 10;
  } else {
    setLastError(ERR_S7_INVALID_MSG_TYPE);
    return ERR_S7_INVALID_MSG_TYPE;
  }

  _paramOffset = _headerSize;
  _dataOffset = _headerSize + <u32>_paramLength;

  // Extract function code from first byte of parameters (if params exist)
  if (_paramLength > 0 && _headerSize < len) {
    _functionCode = load<u8>(ptr + _headerSize);
  }

  setLastError(ERR_NONE);
  return 0;
}

// ─── PDU Builders ───

let _seqCounter: u16 = 1;

function nextPduRef(): u16 {
  const ref = _seqCounter;
  _seqCounter = (_seqCounter + 1) & 0xFFFF;
  if (_seqCounter === 0) _seqCounter = 1;
  return ref;
}

/** Build S7 Setup Communication request PDU.
 *  Returns bytes written to outPtr. */
export function s7_buildSetupComm(
  maxAmqCalling: u16, maxAmqCalled: u16, pduSize: u16, outPtr: usize
): u32 {
  const pduRef = nextPduRef();

  // S7 Header (10 bytes for Job)
  store<u8>(outPtr, S7_PROTOCOL_ID);      // Protocol ID
  store<u8>(outPtr + 1, S7_MSG_JOB);      // Message type: Job
  store<u8>(outPtr + 2, 0x00);            // Reserved
  store<u8>(outPtr + 3, 0x00);
  store<u8>(outPtr + 4, <u8>(pduRef >> 8));  // PDU reference
  store<u8>(outPtr + 5, <u8>(pduRef & 0xFF));
  // Parameter length = 8 (function code + reserved + AMQ calling + AMQ called + PDU size)
  store<u8>(outPtr + 6, 0x00);
  store<u8>(outPtr + 7, 0x08);
  // Data length = 0
  store<u8>(outPtr + 8, 0x00);
  store<u8>(outPtr + 9, 0x00);

  // Parameters (8 bytes)
  store<u8>(outPtr + 10, S7_FN_SETUP_COMM);  // Function code
  store<u8>(outPtr + 11, 0x00);               // Reserved
  store<u8>(outPtr + 12, <u8>(maxAmqCalling >> 8));
  store<u8>(outPtr + 13, <u8>(maxAmqCalling & 0xFF));
  store<u8>(outPtr + 14, <u8>(maxAmqCalled >> 8));
  store<u8>(outPtr + 15, <u8>(maxAmqCalled & 0xFF));
  store<u8>(outPtr + 16, <u8>(pduSize >> 8));
  store<u8>(outPtr + 17, <u8>(pduSize & 0xFF));

  return 18; // 10 header + 8 params
}

/** Build S7 Read Var request PDU (single item).
 *  Returns bytes written. */
export function s7_buildReadRequest(
  area: u8, dbNum: u16, start: u32, amount: u16, wordLen: u8, outPtr: usize
): u32 {
  const pduRef = nextPduRef();

  // S7 Header (10 bytes)
  store<u8>(outPtr, S7_PROTOCOL_ID);
  store<u8>(outPtr + 1, S7_MSG_JOB);
  store<u8>(outPtr + 2, 0x00);
  store<u8>(outPtr + 3, 0x00);
  store<u8>(outPtr + 4, <u8>(pduRef >> 8));
  store<u8>(outPtr + 5, <u8>(pduRef & 0xFF));
  // Parameter length = 14 (function + item count + 12 byte item spec)
  store<u8>(outPtr + 6, 0x00);
  store<u8>(outPtr + 7, 0x0E);
  // Data length = 0 (reads have no data in the request)
  store<u8>(outPtr + 8, 0x00);
  store<u8>(outPtr + 9, 0x00);

  // Parameters
  store<u8>(outPtr + 10, S7_FN_READ_VAR);     // Function
  store<u8>(outPtr + 11, 0x01);                // Item count = 1

  // Item specification (12 bytes)
  store<u8>(outPtr + 12, 0x12);                // Var spec type = "any"
  store<u8>(outPtr + 13, 0x0A);                // Length of rest = 10
  store<u8>(outPtr + 14, 0x10);                // Syntax ID = S7ANY
  store<u8>(outPtr + 15, wordLen);             // Transport size
  store<u8>(outPtr + 16, <u8>(amount >> 8));
  store<u8>(outPtr + 17, <u8>(amount & 0xFF));
  store<u8>(outPtr + 18, <u8>(dbNum >> 8));
  store<u8>(outPtr + 19, <u8>(dbNum & 0xFF));
  store<u8>(outPtr + 20, area);

  // Byte address (3 bytes, big-endian) — for bit addressing, start is bit address
  // For byte addressing: start * 8
  const bitAddr: u32 = wordLen === 0x01 ? start : start * 8;
  store<u8>(outPtr + 21, <u8>((bitAddr >> 16) & 0xFF));
  store<u8>(outPtr + 22, <u8>((bitAddr >> 8) & 0xFF));
  store<u8>(outPtr + 23, <u8>(bitAddr & 0xFF));

  return 24; // 10 header + 14 params
}

/** Build S7 Write Var request PDU (single item).
 *  Returns bytes written. */
export function s7_buildWriteRequest(
  area: u8, dbNum: u16, start: u32, amount: u16, wordLen: u8,
  dataPtr: usize, dataLen: u32, outPtr: usize
): u32 {
  const pduRef = nextPduRef();
  const dataTransportSize = getWriteDataTransportSize(wordLen);

  // Data portion: return code (1) + transport size (1) + length (2) + data
  const dataPayloadLen: u16 = <u16>dataLen;
  const totalDataLen: u16 = 4 + dataPayloadLen;

  // S7 Header (10 bytes)
  store<u8>(outPtr, S7_PROTOCOL_ID);
  store<u8>(outPtr + 1, S7_MSG_JOB);
  store<u8>(outPtr + 2, 0x00);
  store<u8>(outPtr + 3, 0x00);
  store<u8>(outPtr + 4, <u8>(pduRef >> 8));
  store<u8>(outPtr + 5, <u8>(pduRef & 0xFF));
  // Parameter length = 14
  store<u8>(outPtr + 6, 0x00);
  store<u8>(outPtr + 7, 0x0E);
  // Data length
  store<u8>(outPtr + 8, <u8>(totalDataLen >> 8));
  store<u8>(outPtr + 9, <u8>(totalDataLen & 0xFF));

  // Parameters (same as read)
  store<u8>(outPtr + 10, S7_FN_WRITE_VAR);
  store<u8>(outPtr + 11, 0x01);  // Item count = 1

  // Item specification (12 bytes)
  store<u8>(outPtr + 12, 0x12);
  store<u8>(outPtr + 13, 0x0A);
  store<u8>(outPtr + 14, 0x10);
  store<u8>(outPtr + 15, wordLen);
  store<u8>(outPtr + 16, <u8>(amount >> 8));
  store<u8>(outPtr + 17, <u8>(amount & 0xFF));
  store<u8>(outPtr + 18, <u8>(dbNum >> 8));
  store<u8>(outPtr + 19, <u8>(dbNum & 0xFF));
  store<u8>(outPtr + 20, area);
  const bitAddr: u32 = wordLen === 0x01 ? start : start * 8;
  store<u8>(outPtr + 21, <u8>((bitAddr >> 16) & 0xFF));
  store<u8>(outPtr + 22, <u8>((bitAddr >> 8) & 0xFF));
  store<u8>(outPtr + 23, <u8>(bitAddr & 0xFF));

  // Data portion
  store<u8>(outPtr + 24, 0x00);   // Return code (reserved for request)
  store<u8>(outPtr + 25, dataTransportSize);
  const encodedLength: u16 = writeDataLengthUsesBytes(dataTransportSize)
    ? dataPayloadLen
    : <u16>(dataPayloadLen * 8);
  store<u8>(outPtr + 26, <u8>(encodedLength >> 8));
  store<u8>(outPtr + 27, <u8>(encodedLength & 0xFF));

  // Copy data
  memory.copy(outPtr + 28, dataPtr, dataLen);

  return 28 + dataLen;
}

/** Build S7 Write Var request PDU for a single atomic bit write.
 *  `byteOffset` is the DB byte index and `bitOffset` is the bit inside that byte.
 *  Returns bytes written. */
export function s7_buildBitWriteRequest(
  area: u8, dbNum: u16, byteOffset: u32, bitOffset: u8, value: u8, outPtr: usize
): u32 {
  const bitAddress: u32 = (byteOffset * 8) + <u32>(bitOffset & 0x07);
  store<u8>(outPtr + 28, value !== 0 ? 1 : 0);
  return s7_buildWriteRequest(area, dbNum, bitAddress, 1, S7WLBit, outPtr + 28, 1, outPtr);
}

/** Build S7 Multi-Read (ReadMultiVars) request PDU.
 *  `itemsPtr` points to an array of 12-byte item specs (packed).
 *  Returns bytes written. */
export function s7_buildMultiReadRequest(itemsPtr: usize, itemCount: u32, outPtr: usize): u32 {
  const pduRef = nextPduRef();
  const paramLen: u16 = <u16>(2 + itemCount * 12);  // fn + count + items

  // S7 Header
  store<u8>(outPtr, S7_PROTOCOL_ID);
  store<u8>(outPtr + 1, S7_MSG_JOB);
  store<u8>(outPtr + 2, 0x00);
  store<u8>(outPtr + 3, 0x00);
  store<u8>(outPtr + 4, <u8>(pduRef >> 8));
  store<u8>(outPtr + 5, <u8>(pduRef & 0xFF));
  store<u8>(outPtr + 6, <u8>(paramLen >> 8));
  store<u8>(outPtr + 7, <u8>(paramLen & 0xFF));
  store<u8>(outPtr + 8, 0x00);
  store<u8>(outPtr + 9, 0x00);

  // Parameters
  store<u8>(outPtr + 10, S7_FN_READ_VAR);
  store<u8>(outPtr + 11, <u8>itemCount);

  // Copy item specs
  memory.copy(outPtr + 12, itemsPtr, itemCount * 12);

  return 12 + itemCount * 12;
}

// ─── Getters ───
export function s7_getMessageType(): u8 { return _msgType; }
export function s7_getFunctionCode(): u8 { return _functionCode; }
export function s7_getPduRef(): u16 { return _pduRef; }
export function s7_getParameterLength(): u16 { return _paramLength; }
export function s7_getDataLength(): u16 { return _dataLength; }
export function s7_getErrorClass(): u8 { return _errorClass; }
export function s7_getErrorCode(): u8 { return _errorCode; }
export function s7_getHeaderSize(): u32 { return _headerSize; }
export function s7_getParamOffset(): u32 { return _paramOffset; }
export function s7_getDataOffset(): u32 { return _dataOffset; }
export function s7_resetSeqCounter(): void { _seqCounter = 1; }
