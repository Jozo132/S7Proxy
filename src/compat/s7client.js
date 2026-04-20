// @ts-check
// Drop-in replacement for node-snap7 S7Client — backed by S7Proxy's WASM engine + PlcConnection

import { EventEmitter } from 'eventemitter3';
import { PlcConnection } from '../client/plc-connection.js';
import { WasmBridge } from '../wasm/bridge.js';
import { loadWasmEngine, resetWasmCache } from '../wasm/loader.js';
import {
  S7AreaPE, S7AreaPA, S7AreaMK, S7AreaDB, S7AreaCT, S7AreaTM,
  S7WLBit, S7WLByte, S7WLWord, S7WLDWord, S7WLReal, S7WLCounter, S7WLTimer,
  S7_DEFAULT_PORT, CONNTYPE_PG, CONNTYPE_OP, CONNTYPE_BASIC,
  BlockOB, BlockDB, BlockSDB, BlockFC, BlockSFC, BlockFB, BlockSFB,
  calcTsap, DEFAULT_PDU_SIZE, DEFAULT_AMQ,
  S7_MSG_ACK_DATA, S7_FN_READ_VAR, S7_FN_WRITE_VAR,
} from '../protocol/constants.js';

/**
 * @typedef {Object} MultiVarRead
 * @property {number} Area
 * @property {number} WordLen
 * @property {number} DBNumber
 * @property {number} Start
 * @property {number} Amount
 */

/**
 * @typedef {Object} MultiVarWrite
 * @property {number} Area
 * @property {number} WordLen
 * @property {number} DBNumber
 * @property {number} Start
 * @property {number} Amount
 * @property {Buffer} Data
 */

/**
 * @typedef {Object} MultiVarReadResult
 * @property {number} Result
 * @property {Buffer} Data
 */

/**
 * @typedef {Object} MultiVarWriteResult
 * @property {number} Result
 */

// ─── S7 Error Codes ───
const errTCPConnectionFailed = 0x0001;
const errNegotiatingPDU = 0x00100000;
const errCliNotConnected = 0x0007;
const errCliSendingPDU = 0x00300000;
const errCliDataRead = 0x00400000;
const errCliDataWrite = 0x00500000;

/** @type {Record<number, string>} */
const ERROR_TEXTS = {
  0x0000: 'OK',
  0x0001: 'TCP Connection failed',
  0x0002: 'TCP Connection reset',
  0x0003: 'TCP Data send error',
  0x0004: 'TCP Data receive error',
  0x0005: 'TCP Data receive timeout',
  0x0006: 'TCP Connection dropped',
  0x0007: 'Client not connected',
  0x00100000: 'Error negotiating PDU length',
  0x00200000: 'Error on ISO connect',
  0x00300000: 'Error sending PDU',
  0x00400000: 'Error reading data',
  0x00500000: 'Error writing data',
};

/**
 * Extract S7 read-response payload data from a raw response frame.
 *
 * Response frame layout (after TPKT=4 + COTP DT=3):
 *   S7 Header: 12 bytes (protocol, msgType, reserved, pduRef, paramLen, dataLen, errClass, errCode)
 *   Param:     2 bytes (functionCode, itemCount)
 *   Data:      for each item → 1 byte returnCode + 1 byte transportSize + 2 bytes dataLen(bits) + data bytes
 *
 * @param {Buffer} frame - Complete TPKT+COTP+S7 frame
 * @returns {{ returnCode: number, data: Buffer }}
 */
function extractReadData(frame) {
  // TPKT(4) + COTP DT(3) + S7 header(12) + params(2) = offset 21
  const dataStart = 21;
  if (frame.length < dataStart + 4) {
    return { returnCode: 0x0A, data: Buffer.alloc(0) }; // 0x0A = not yet available
  }
  const returnCode = frame[dataStart];     // 0xFF = success
  // const transportSize = frame[dataStart + 1];
  const bitLength = frame.readUInt16BE(dataStart + 2);
  const byteLength = Math.ceil(bitLength / 8);
  const data = frame.subarray(dataStart + 4, dataStart + 4 + byteLength);
  return { returnCode, data: Buffer.from(data) };
}

/**
 * Extract S7 write-response return code.
 * @param {Buffer} frame
 * @returns {number}
 */
function extractWriteResult(frame) {
  // TPKT(4) + COTP DT(3) + S7 header(12) + params(2) = offset 21
  const dataStart = 21;
  if (frame.length < dataStart + 1) return 0x0A;
  return frame[dataStart]; // 0xFF = success
}

/**
 * Compute byte size for a given wordLen and amount.
 * @param {number} wordLen
 * @param {number} amount
 * @returns {number}
 */
function wordLenToBytes(wordLen, amount) {
  switch (wordLen) {
    case S7WLBit:     return Math.ceil(amount / 8);
    case S7WLByte:    return amount;
    case S7WLWord:    return amount * 2;
    case S7WLDWord:   return amount * 4;
    case S7WLReal:    return amount * 4;
    case S7WLCounter: return amount * 2;
    case S7WLTimer:   return amount * 2;
    default:          return amount;
  }
}

export class S7Client extends EventEmitter {
  // ─── Static constants (mirror node-snap7) ───
  static S7AreaPE = S7AreaPE;
  static S7AreaPA = S7AreaPA;
  static S7AreaMK = S7AreaMK;
  static S7AreaDB = S7AreaDB;
  static S7AreaCT = S7AreaCT;
  static S7AreaTM = S7AreaTM;

  static S7WLBit = S7WLBit;
  static S7WLByte = S7WLByte;
  static S7WLWord = S7WLWord;
  static S7WLDWord = S7WLDWord;
  static S7WLReal = S7WLReal;
  static S7WLCounter = S7WLCounter;
  static S7WLTimer = S7WLTimer;

  static CONNTYPE_PG = CONNTYPE_PG;
  static CONNTYPE_OP = CONNTYPE_OP;
  static CONNTYPE_BASIC = CONNTYPE_BASIC;

  static Block_OB = BlockOB;
  static Block_DB = BlockDB;
  static Block_SDB = BlockSDB;
  static Block_FC = BlockFC;
  static Block_SFC = BlockSFC;
  static Block_FB = BlockFB;
  static Block_SFB = BlockSFB;

  static SubBlk_OB = 0x08;
  static SubBlk_DB = 0x0A;
  static SubBlk_SDB = 0x0B;
  static SubBlk_FC = 0x0C;
  static SubBlk_SFC = 0x0D;
  static SubBlk_FB = 0x0E;
  static SubBlk_SFB = 0x0F;

  static BlockLangAWL = 0x01;
  static BlockLangKOP = 0x02;
  static BlockLangFUP = 0x03;
  static BlockLangSCL = 0x04;
  static BlockLangDB = 0x05;
  static BlockLangGRAPH = 0x06;

  static S7CpuStatusUnknown = 0x00;
  static S7CpuStatusRun = 0x08;
  static S7CpuStatusStop = 0x04;

  static RemotePort = 2;
  static PingTimeout = 3;
  static SendTimeout = 4;
  static RecvTimeout = 5;
  static SrcRef = 7;
  static DstRef = 8;
  static SrcTSap = 9;
  static PDURequest = 10;

  /** @type {WasmBridge | null} */
  #bridge = null;
  /** @type {PlcConnection | null} */
  #conn = null;
  /** @type {string} */
  #ip = '';
  /** @type {number} */
  #rack = 0;
  /** @type {number} */
  #slot = 0;
  /** @type {number} */
  #connectionType = CONNTYPE_PG;
  /** @type {number} */
  #localTSAP = 0;
  /** @type {number} */
  #remoteTSAP = 0;
  /** @type {boolean} */
  #useTsapOverride = false;
  /** @type {number} */
  #lastError = 0;
  /** @type {number} */
  #execTime = 0;
  /** @type {Map<number, any>} */
  #params = new Map();
  /** @type {number} */
  #requestTimeoutMs = 3000;
  /** @type {boolean} */
  #connected = false;

  constructor() {
    super();
  }

  // ═══════════════════════════════════════════════
  //  Connection
  // ═══════════════════════════════════════════════

  /**
   * Connect to a PLC by IP, rack, and slot.
   * @param {string} ip
   * @param {number} rack
   * @param {number} slot
   * @param {((err: number) => void)} [callback]
   * @returns {boolean | void}
   */
  ConnectTo(ip, rack, slot, callback) {
    this.#ip = ip;
    this.#rack = rack;
    this.#slot = slot;
    this.#useTsapOverride = false;

    if (callback) {
      this.#doConnect().then(() => callback(0)).catch(() => callback(this.#lastError));
      return;
    }
    try {
      // Blocking-style: we can't truly block in Node.js, but we return false synchronously
      // and the user should use the callback form for proper async support.
      this.#doConnect().catch(() => {});
      return this.#connected;
    } catch {
      return false;
    }
  }

  /**
   * Set custom TSAP parameters.
   * @param {string} ip
   * @param {number} localTSAP
   * @param {number} remoteTSAP
   * @returns {boolean}
   */
  SetConnectionParams(ip, localTSAP, remoteTSAP) {
    this.#ip = ip;
    this.#localTSAP = localTSAP;
    this.#remoteTSAP = remoteTSAP;
    this.#useTsapOverride = true;
    return true;
  }

  /**
   * Set the connection type (PG, OP, BASIC).
   * @param {number} type
   */
  SetConnectionType(type) {
    this.#connectionType = type;
  }

  /**
   * Connect using previously set params (SetConnectionParams or ConnectTo + rack/slot).
   * @param {((err: number) => void)} [callback]
   * @returns {boolean | void}
   */
  Connect(callback) {
    if (callback) {
      this.#doConnect().then(() => callback(0)).catch(() => callback(this.#lastError));
      return;
    }
    try {
      this.#doConnect().catch(() => {});
      return this.#connected;
    } catch {
      return false;
    }
  }

  /**
   * Disconnect from the PLC.
   * @returns {boolean}
   */
  Disconnect() {
    if (this.#conn) {
      this.#conn.disconnect().catch(() => {});
      this.#conn = null;
    }
    this.#connected = false;
    return true;
  }

  /**
   * @returns {boolean}
   */
  Connected() {
    return this.#connected && this.#conn?.state === 'ready';
  }

  // ═══════════════════════════════════════════════
  //  Parameters
  // ═══════════════════════════════════════════════

  /**
   * @param {number} paramNumber
   * @param {any} value
   * @returns {boolean}
   */
  SetParam(paramNumber, value) {
    this.#params.set(paramNumber, value);
    if (paramNumber === S7Client.RecvTimeout || paramNumber === S7Client.SendTimeout) {
      this.#requestTimeoutMs = value;
    }
    return true;
  }

  /**
   * @param {number} paramNumber
   * @returns {any}
   */
  GetParam(paramNumber) {
    if (paramNumber === S7Client.PDURequest) return this.#conn?.pduSize ?? DEFAULT_PDU_SIZE;
    return this.#params.get(paramNumber) ?? false;
  }

  // ═══════════════════════════════════════════════
  //  Data I/O
  // ═══════════════════════════════════════════════

  /**
   * Read data from a PLC area.
   * @param {number} area
   * @param {number} dbNumber
   * @param {number} start
   * @param {number} amount
   * @param {number} wordLen
   * @param {((err: number, data?: Buffer) => void)} [callback]
   * @returns {Buffer | false | void}
   */
  ReadArea(area, dbNumber, start, amount, wordLen, callback) {
    if (!this.Connected()) {
      this.#lastError = errCliNotConnected;
      if (callback) { callback(this.#lastError); return; }
      return false;
    }

    const op = this.#readAreaAsync(area, dbNumber, start, amount, wordLen);

    if (callback) {
      op.then(buf => callback(0, buf)).catch(() => callback(this.#lastError));
      return;
    }
    // Synchronous-style: cannot truly block, return false
    return false;
  }

  /**
   * Write data to a PLC area.
   * @param {number} area
   * @param {number} dbNumber
   * @param {number} start
   * @param {number} amount
   * @param {number} wordLen
   * @param {Buffer} buffer
   * @param {((err: number) => void)} [callback]
   * @returns {boolean | void}
   */
  WriteArea(area, dbNumber, start, amount, wordLen, buffer, callback) {
    if (!this.Connected()) {
      this.#lastError = errCliNotConnected;
      if (callback) { callback(this.#lastError); return; }
      return false;
    }

    const op = this.#writeAreaAsync(area, dbNumber, start, amount, wordLen, buffer);

    if (callback) {
      op.then(() => callback(0)).catch(() => callback(this.#lastError));
      return;
    }
    return false;
  }

  // ─── Lean data functions ───

  /** @param {number} dbNumber @param {number} start @param {number} size @param {((err: number, data?: Buffer) => void)} [callback] */
  DBRead(dbNumber, start, size, callback) {
    return this.ReadArea(S7AreaDB, dbNumber, start, size, S7WLByte, callback);
  }

  /** @param {number} dbNumber @param {number} start @param {number} size @param {Buffer} buffer @param {((err: number) => void)} [callback] */
  DBWrite(dbNumber, start, size, buffer, callback) {
    return this.WriteArea(S7AreaDB, dbNumber, start, size, S7WLByte, buffer, callback);
  }

  /** @param {number} start @param {number} size @param {((err: number, data?: Buffer) => void)} [callback] */
  ABRead(start, size, callback) {
    return this.ReadArea(S7AreaPA, 0, start, size, S7WLByte, callback);
  }

  /** @param {number} start @param {number} size @param {Buffer} buffer @param {((err: number) => void)} [callback] */
  ABWrite(start, size, buffer, callback) {
    return this.WriteArea(S7AreaPA, 0, start, size, S7WLByte, buffer, callback);
  }

  /** @param {number} start @param {number} size @param {((err: number, data?: Buffer) => void)} [callback] */
  EBRead(start, size, callback) {
    return this.ReadArea(S7AreaPE, 0, start, size, S7WLByte, callback);
  }

  /** @param {number} start @param {number} size @param {Buffer} buffer @param {((err: number) => void)} [callback] */
  EBWrite(start, size, buffer, callback) {
    return this.WriteArea(S7AreaPE, 0, start, size, S7WLByte, buffer, callback);
  }

  /** @param {number} start @param {number} size @param {((err: number, data?: Buffer) => void)} [callback] */
  MBRead(start, size, callback) {
    return this.ReadArea(S7AreaMK, 0, start, size, S7WLByte, callback);
  }

  /** @param {number} start @param {number} size @param {Buffer} buffer @param {((err: number) => void)} [callback] */
  MBWrite(start, size, buffer, callback) {
    return this.WriteArea(S7AreaMK, 0, start, size, S7WLByte, buffer, callback);
  }

  /** @param {number} start @param {number} amount @param {((err: number, data?: Buffer) => void)} [callback] */
  TMRead(start, amount, callback) {
    return this.ReadArea(S7AreaTM, 0, start, amount, S7WLTimer, callback);
  }

  /** @param {number} start @param {number} amount @param {Buffer} buffer @param {((err: number) => void)} [callback] */
  TMWrite(start, amount, buffer, callback) {
    return this.WriteArea(S7AreaTM, 0, start, amount, S7WLTimer, buffer, callback);
  }

  /** @param {number} start @param {number} amount @param {((err: number, data?: Buffer) => void)} [callback] */
  CTRead(start, amount, callback) {
    return this.ReadArea(S7AreaCT, 0, start, amount, S7WLCounter, callback);
  }

  /** @param {number} start @param {number} amount @param {Buffer} buffer @param {((err: number) => void)} [callback] */
  CTWrite(start, amount, buffer, callback) {
    return this.WriteArea(S7AreaCT, 0, start, amount, S7WLCounter, buffer, callback);
  }

  // ─── Multi Var ───

  /**
   * Read multiple variables in a single PDU.
   * @param {MultiVarRead[]} items
   * @param {((err: number, data?: MultiVarReadResult[]) => void)} [callback]
   * @returns {MultiVarReadResult[] | false | void}
   */
  ReadMultiVars(items, callback) {
    if (!this.Connected()) {
      this.#lastError = errCliNotConnected;
      if (callback) { callback(this.#lastError); return; }
      return false;
    }

    const op = this.#readMultiAsync(items);
    if (callback) {
      op.then(res => callback(0, res)).catch(() => callback(this.#lastError));
      return;
    }
    return false;
  }

  /**
   * Write multiple variables in a single PDU.
   * @param {MultiVarWrite[]} items
   * @param {((err: number, data?: MultiVarWriteResult[]) => void)} [callback]
   * @returns {MultiVarWriteResult[] | false | void}
   */
  WriteMultiVars(items, callback) {
    if (!this.Connected()) {
      this.#lastError = errCliNotConnected;
      if (callback) { callback(this.#lastError); return; }
      return false;
    }

    const op = this.#writeMultiAsync(items);
    if (callback) {
      op.then(res => callback(0, res)).catch(() => callback(this.#lastError));
      return;
    }
    return false;
  }

  // ═══════════════════════════════════════════════
  //  Info / Status functions
  // ═══════════════════════════════════════════════

  /**
   * Get PDU length negotiated with the PLC.
   * @returns {number | false}
   */
  PduLength() {
    return this.#conn?.pduSize ?? false;
  }

  /**
   * Get requested PDU size.
   * @returns {number | false}
   */
  PduRequested() {
    return DEFAULT_PDU_SIZE;
  }

  /**
   * Get last execution time in ms.
   * @returns {number | false}
   */
  ExecTime() {
    return this.#execTime || false;
  }

  /**
   * Get last error code.
   * @returns {number}
   */
  LastError() {
    return this.#lastError;
  }

  /**
   * @param {((err: number, status?: number) => void)} [callback]
   * @returns {number | false | void}
   */
  PlcStatus(callback) {
    const status = this.Connected() ? S7Client.S7CpuStatusRun : S7Client.S7CpuStatusUnknown;
    if (callback) { callback(0, status); return; }
    return status;
  }

  /**
   * Get CPU info.
   * @param {((err: number, data?: object) => void)} [callback]
   * @returns {object | false | void}
   */
  GetCpuInfo(callback) {
    const info = {
      ModuleTypeName: 'S7Proxy Virtual CPU',
      SerialNumber: '000000000000',
      ASName: 'S7Proxy',
      Copyright: 'S7Proxy',
      ModuleName: 'S7Proxy',
    };
    if (callback) { callback(0, info); return; }
    return info;
  }

  /**
   * Get CP info.
   * @param {((err: number, data?: object) => void)} [callback]
   * @returns {object | false | void}
   */
  GetCpInfo(callback) {
    const info = {
      MaxPduLength: this.#conn?.pduSize ?? DEFAULT_PDU_SIZE,
      MaxConnections: DEFAULT_AMQ,
      MaxMpiRate: 0,
      MaxBusRate: 0,
    };
    if (callback) { callback(0, info); return; }
    return info;
  }

  /**
   * Get order code.
   * @param {((err: number, data?: object) => void)} [callback]
   * @returns {object | false | void}
   */
  GetOrderCode(callback) {
    const info = { Code: 'S7Proxy-WASM', V1: 1, V2: 0, V3: 0 };
    if (callback) { callback(0, info); return; }
    return info;
  }

  /**
   * Get error text for an error code.
   * @param {number} errNum
   * @returns {string}
   */
  ErrorText(errNum) {
    return ERROR_TEXTS[errNum] ?? `Unknown error (0x${errNum.toString(16)})`;
  }

  // ═══════════════════════════════════════════════
  //  Stubs for full API compatibility
  // ═══════════════════════════════════════════════

  /** @param {((err: number) => void)} [callback] @returns {boolean | void} */
  PlcHotStart(callback) { if (callback) { callback(0); return; } return true; }
  /** @param {((err: number) => void)} [callback] @returns {boolean | void} */
  PlcColdStart(callback) { if (callback) { callback(0); return; } return true; }
  /** @param {((err: number) => void)} [callback] @returns {boolean | void} */
  PlcStop(callback) { if (callback) { callback(0); return; } return true; }

  /** @param {((err: number, data?: Date) => void)} [callback] @returns {Date | false | void} */
  GetPlcDateTime(callback) {
    const dt = new Date();
    if (callback) { callback(0, dt); return; }
    return dt;
  }

  /** @param {Date | object} _dateTime @param {((err: number) => void)} [callback] @returns {boolean | void} */
  SetPlcDateTime(_dateTime, callback) { if (callback) { callback(0); return; } return true; }
  /** @param {((err: number) => void)} [callback] @returns {boolean | void} */
  SetPlcSystemDateTime(callback) { if (callback) { callback(0); return; } return true; }

  /** @param {number} _id @param {number} _index @param {((err: number, data?: Buffer) => void)} [callback] @returns {Buffer | false | void} */
  ReadSZL(_id, _index, callback) {
    if (callback) { callback(0, Buffer.alloc(0)); return; }
    return Buffer.alloc(0);
  }

  /** @param {((err: number, data?: number[]) => void)} [callback] @returns {number[] | false | void} */
  ReadSZLList(callback) {
    if (callback) { callback(0, []); return; }
    return [];
  }

  /** @param {((err: number, data?: object) => void)} [callback] @returns {object | false | void} */
  GetProtection(callback) {
    const prot = { sch_schal: 0, sch_par: 0, sch_rel: 0, bart_sch: 1, anl_sch: 0 };
    if (callback) { callback(0, prot); return; }
    return prot;
  }

  /** @param {string} _password @param {((err: number) => void)} [callback] @returns {boolean | void} */
  SetSessionPassword(_password, callback) { if (callback) { callback(0); return; } return true; }
  /** @param {((err: number) => void)} [callback] @returns {boolean | void} */
  ClearSessionPassword(callback) { if (callback) { callback(0); return; } return true; }

  /** @param {((err: number, data?: object) => void)} [callback] @returns {object | false | void} */
  ListBlocks(callback) {
    const result = { OBCount: 0, FBCount: 0, FCCount: 0, SFBCount: 0, SFCCount: 0, DBCount: 0, SDBCount: 0 };
    if (callback) { callback(0, result); return; }
    return result;
  }

  /** @param {number} _blockType @param {((err: number, data?: number[]) => void)} [callback] @returns {number[] | false | void} */
  ListBlocksOfType(_blockType, callback) {
    if (callback) { callback(0, []); return; }
    return [];
  }

  /** @param {number} _blockType @param {number} _blockNum @param {((err: number, data?: object) => void)} [callback] @returns {object | false | void} */
  GetAgBlockInfo(_blockType, _blockNum, callback) {
    if (callback) { callback(0, {}); return; }
    return {};
  }

  /** @param {Buffer} _buffer @returns {object | false} */
  GetPgBlockInfo(_buffer) { return {}; }

  /** @param {number} _blockType @param {number} _blockNum @param {((err: number, data?: Buffer) => void)} [callback] @returns {Buffer | false | void} */
  Upload(_blockType, _blockNum, callback) {
    if (callback) { callback(0, Buffer.alloc(0)); return; }
    return Buffer.alloc(0);
  }

  /** @param {number} _blockType @param {number} _blockNum @param {number} _size @param {((err: number, data?: Buffer) => void)} [callback] @returns {Buffer | false | void} */
  FullUpload(_blockType, _blockNum, _size, callback) {
    if (callback) { callback(0, Buffer.alloc(0)); return; }
    return Buffer.alloc(0);
  }

  /** @param {number} _blockNum @param {Buffer} _buffer @param {((err: number) => void)} [callback] @returns {boolean | void} */
  Download(_blockNum, _buffer, callback) { if (callback) { callback(0); return; } return true; }

  /** @param {number} _blockType @param {number} _blockNum @param {((err: number) => void)} [callback] @returns {boolean | void} */
  Delete(_blockType, _blockNum, callback) { if (callback) { callback(0); return; } return true; }

  /** @param {number} _dbNumber @param {((err: number, data?: Buffer) => void)} [callback] @returns {Buffer | false | void} */
  DBGet(_dbNumber, callback) {
    if (callback) { callback(0, Buffer.alloc(0)); return; }
    return Buffer.alloc(0);
  }

  /** @param {number} _dbNumber @param {number} _fillChar @param {((err: number) => void)} [callback] @returns {boolean | void} */
  DBFill(_dbNumber, _fillChar, callback) { if (callback) { callback(0); return; } return true; }

  /** @param {number} _timeout @param {((err: number) => void)} [callback] @returns {boolean | void} */
  CopyRamToRom(_timeout, callback) { if (callback) { callback(0); return; } return true; }
  /** @param {number} _timeout @param {((err: number) => void)} [callback] @returns {boolean | void} */
  Compress(_timeout, callback) { if (callback) { callback(0); return; } return true; }

  // ═══════════════════════════════════════════════
  //  Internal async operations
  // ═══════════════════════════════════════════════

  async #doConnect() {
    const startTime = Date.now();
    try {
      if (!this.#bridge) {
        const engine = await loadWasmEngine();
        this.#bridge = new WasmBridge(engine);
      }

      const srcTsap = this.#useTsapOverride
        ? this.#localTSAP
        : calcTsap(this.#connectionType, 0, 0);
      const dstTsap = this.#useTsapOverride
        ? this.#remoteTSAP
        : calcTsap(this.#connectionType, this.#rack, this.#slot);

      // PlcConnection handles COTP CR using its own TSAP computation from the endpoint,
      // but we override by providing the correct rack/slot in the endpoint.
      const connId = `s7cli-${Date.now().toString(36)}`;
      const port = this.#params.get(S7Client.RemotePort) ?? S7_DEFAULT_PORT;
      const endpoint = { ip: this.#ip, rack: this.#rack, slot: this.#slot, port };

      // Create a silent logger
      const logger = { child: () => logger, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {} };

      this.#conn = new PlcConnection(
        connId, 'snap7-compat', endpoint,
        this.#bridge, /** @type {any} */ (logger), this.#requestTimeoutMs
      );

      await this.#conn.connect();
      this.#connected = true;
      this.#lastError = 0;
      this.#execTime = Date.now() - startTime;
    } catch (err) {
      this.#lastError = errTCPConnectionFailed;
      this.#connected = false;
      this.#execTime = Date.now() - startTime;
      throw err;
    }
  }

  /**
   * @param {number} area
   * @param {number} dbNumber
   * @param {number} start
   * @param {number} amount
   * @param {number} wordLen
   * @returns {Promise<Buffer>}
   */
  async #readAreaAsync(area, dbNumber, start, amount, wordLen) {
    const startTime = Date.now();
    try {
      const frame = this.#bridge?.buildReadRequest(area, dbNumber, start, amount, wordLen);
      if (!frame || !this.#conn) throw new Error('Not connected');

      const pduRef = frame.readUInt16BE(11);
      const response = await this.#conn.sendRequest(frame, pduRef);

      const { returnCode, data } = extractReadData(response);
      this.#execTime = Date.now() - startTime;

      if (returnCode !== 0xFF) {
        this.#lastError = errCliDataRead;
        throw new Error(`Read failed: return code 0x${returnCode.toString(16)}`);
      }

      this.#lastError = 0;
      return data;
    } catch (err) {
      if (this.#lastError === 0) this.#lastError = errCliDataRead;
      this.#execTime = Date.now() - startTime;
      throw err;
    }
  }

  /**
   * @param {number} area
   * @param {number} dbNumber
   * @param {number} start
   * @param {number} amount
   * @param {number} wordLen
   * @param {Buffer} data
   * @returns {Promise<void>}
   */
  async #writeAreaAsync(area, dbNumber, start, amount, wordLen, data) {
    const startTime = Date.now();
    try {
      const frame = this.#bridge?.buildWriteRequest(area, dbNumber, start, amount, wordLen, data);
      if (!frame || !this.#conn) throw new Error('Not connected');

      const pduRef = frame.readUInt16BE(11);
      const response = await this.#conn.sendRequest(frame, pduRef);

      const returnCode = extractWriteResult(response);
      this.#execTime = Date.now() - startTime;

      if (returnCode !== 0xFF) {
        this.#lastError = errCliDataWrite;
        throw new Error(`Write failed: return code 0x${returnCode.toString(16)}`);
      }

      this.#lastError = 0;
    } catch (err) {
      if (this.#lastError === 0) this.#lastError = errCliDataWrite;
      this.#execTime = Date.now() - startTime;
      throw err;
    }
  }

  /**
   * @param {MultiVarRead[]} items
   * @returns {Promise<MultiVarReadResult[]>}
   */
  async #readMultiAsync(items) {
    const startTime = Date.now();
    try {
      /** @type {MultiVarReadResult[]} */
      const results = [];

      // Execute each item as an individual read (multi-read in WASM doesn't return data in a single frame)
      for (const item of items) {
        try {
          const data = await this.#readAreaAsync(item.Area, item.DBNumber, item.Start, item.Amount, item.WordLen);
          results.push({ Result: 0, Data: data });
        } catch {
          results.push({ Result: errCliDataRead, Data: Buffer.alloc(wordLenToBytes(item.WordLen, item.Amount)) });
        }
      }

      this.#execTime = Date.now() - startTime;
      this.#lastError = 0;
      return results;
    } catch (err) {
      this.#execTime = Date.now() - startTime;
      this.#lastError = errCliSendingPDU;
      throw err;
    }
  }

  /**
   * @param {MultiVarWrite[]} items
   * @returns {Promise<MultiVarWriteResult[]>}
   */
  async #writeMultiAsync(items) {
    const startTime = Date.now();
    try {
      /** @type {MultiVarWriteResult[]} */
      const results = [];

      for (const item of items) {
        try {
          await this.#writeAreaAsync(item.Area, item.DBNumber, item.Start, item.Amount, item.WordLen, item.Data);
          results.push({ Result: 0 });
        } catch {
          results.push({ Result: errCliDataWrite });
        }
      }

      this.#execTime = Date.now() - startTime;
      this.#lastError = 0;
      return results;
    } catch (err) {
      this.#execTime = Date.now() - startTime;
      this.#lastError = errCliSendingPDU;
      throw err;
    }
  }
}
