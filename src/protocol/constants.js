// @ts-check
// S7Comm protocol constants — Node.js side mirror of assembly/constants.ts

// ─── Area Identifiers ───
export const S7AreaPE = 0x81;
export const S7AreaPA = 0x82;
export const S7AreaMK = 0x83;
export const S7AreaDB = 0x84;
export const S7AreaCT = 0x1C;
export const S7AreaTM = 0x1D;

// ─── Word Lengths ───
export const S7WLBit = 0x01;
export const S7WLByte = 0x02;
export const S7WLChar = 0x03;
export const S7WLWord = 0x04;
export const S7WLInt = 0x05;
export const S7WLDWord = 0x06;
export const S7WLDInt = 0x07;
export const S7WLReal = 0x08;
export const S7WLCounter = 0x1C;
export const S7WLTimer = 0x1D;

// ─── Block Types ───
export const BlockOB = 0x38;
export const BlockDB = 0x41;
export const BlockSDB = 0x42;
export const BlockFC = 0x43;
export const BlockSFC = 0x44;
export const BlockFB = 0x45;
export const BlockSFB = 0x46;

// ─── Connection Types ───
export const CONNTYPE_PG = 0x01;
export const CONNTYPE_OP = 0x02;
export const CONNTYPE_BASIC = 0x03;

// ─── TPKT ───
export const TPKT_VERSION = 0x03;
export const TPKT_HEADER_SIZE = 4;

// ─── COTP PDU Types ───
export const COTP_CR = 0xE0;
export const COTP_CC = 0xD0;
export const COTP_DT = 0xF0;
export const COTP_DR = 0x80;

// ─── S7Comm ───
export const S7_PROTOCOL_ID = 0x32;
export const S7_MSG_JOB = 0x01;
export const S7_MSG_ACK = 0x02;
export const S7_MSG_ACK_DATA = 0x03;
export const S7_MSG_USERDATA = 0x07;

// ─── S7 Function Codes ───
export const S7_FN_SETUP_COMM = 0xF0;
export const S7_FN_READ_VAR = 0x04;
export const S7_FN_WRITE_VAR = 0x05;
export const S7_FN_PLC_CONTROL = 0x28;
export const S7_FN_PLC_STOP = 0x29;

// ─── Area name mapping ───
/** @type {Record<number, string>} */
export const AREA_NAMES = {
  [S7AreaPE]: 'PE',
  [S7AreaPA]: 'PA',
  [S7AreaMK]: 'MK',
  [S7AreaDB]: 'DB',
  [S7AreaCT]: 'CT',
  [S7AreaTM]: 'TM',
};

/** @type {Record<string, number>} */
export const AREA_BY_NAME = {
  PE: S7AreaPE,
  PA: S7AreaPA,
  MK: S7AreaMK,
  DB: S7AreaDB,
  CT: S7AreaCT,
  TM: S7AreaTM,
};

/** @type {Record<string, number>} */
export const WORDLEN_BY_NAME = {
  bit: S7WLBit,
  byte: S7WLByte,
  char: S7WLChar,
  word: S7WLWord,
  int: S7WLInt,
  dword: S7WLDWord,
  dint: S7WLDInt,
  real: S7WLReal,
  counter: S7WLCounter,
  timer: S7WLTimer,
};

// Default S7 port
export const S7_DEFAULT_PORT = 102;

// PDU sizes
export const MAX_PDU_SIZE = 960;
export const MIN_PDU_SIZE = 240;
export const DEFAULT_PDU_SIZE = 480;
export const DEFAULT_AMQ = 8;

/**
 * TSAP calculation for rack/slot.
 * @param {number} connType
 * @param {number} rack
 * @param {number} slot
 * @returns {number}
 */
export function calcTsap(connType, rack, slot) {
  return (connType << 8) | ((rack << 5) | slot);
}
