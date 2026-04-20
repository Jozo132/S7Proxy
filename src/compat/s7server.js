// @ts-check
// Drop-in replacement for node-snap7 S7Server — backed by Node.js TCP + S7Proxy WASM engine
// Supports custom port via SetParam(S7Server.LocalPort, port) or StartTo(ip, callback)

import { createServer } from 'node:net';
import { EventEmitter } from 'eventemitter3';
import { FrameAssembler } from '../protocol/frame-assembler.js';
import { WasmBridge } from '../wasm/bridge.js';
import { loadWasmEngine } from '../wasm/loader.js';
import {
  TPKT_HEADER_SIZE, COTP_CR, COTP_DT, COTP_DR,
  S7_FN_SETUP_COMM, S7_FN_READ_VAR, S7_FN_WRITE_VAR,
  S7AreaPE, S7AreaPA, S7AreaMK, S7AreaDB, S7AreaCT, S7AreaTM,
  S7WLBit, S7WLByte,
  S7_PROTOCOL_ID, S7_MSG_ACK_DATA,
  DEFAULT_PDU_SIZE, DEFAULT_AMQ,
} from '../protocol/constants.js';

/**
 * @typedef {Object} ServerEvent
 * @property {Date}   EvtTime
 * @property {string} EvtSender
 * @property {number} EvtCode
 * @property {number} EvtRetCode
 * @property {number} EvtParam1
 * @property {number} EvtParam2
 * @property {number} EvtParam3
 * @property {number} EvtParam4
 */

/**
 * @typedef {Object} ReadWriteTag
 * @property {number} Area
 * @property {number} DBNumber
 * @property {number} Start
 * @property {number} Size
 * @property {number} WordLen
 */

// ─── S7 area code → server area code mapping ───
const s7AreaToSrvArea = {
  [S7AreaPE]: 0,
  [S7AreaPA]: 1,
  [S7AreaMK]: 2,
  [S7AreaCT]: 3,
  [S7AreaTM]: 4,
  [S7AreaDB]: 5,
};

// ─── Server area code → S7 area code ───
const srvAreaToS7Area = {
  0: S7AreaPE,
  1: S7AreaPA,
  2: S7AreaMK,
  3: S7AreaCT,
  4: S7AreaTM,
  5: S7AreaDB,
};

export class S7Server extends EventEmitter {
  // ─── Static constants ───
  static srvAreaPE = 0;
  static srvAreaPA = 1;
  static srvAreaMK = 2;
  static srvAreaCT = 3;
  static srvAreaTM = 4;
  static srvAreaDB = 5;

  static LocalPort = 1;
  static WorkInterval = 6;
  static PDURequest = 10;
  static MaxClients = 11;

  static SrvStopped = 0x00;
  static SrvRunning = 0x01;
  static SrvError = 0x02;

  // Event mask constants
  static evcAll = 0xFFFFFFFF;
  static evcNone = 0x00000000;
  static evcServerStarted = 0x00000001;
  static evcServerStopped = 0x00000002;
  static evcListenerCannotStart = 0x00000004;
  static evcClientAdded = 0x00000008;
  static evcClientRejected = 0x00000010;
  static evcClientNoRoom = 0x00000020;
  static evcClientException = 0x00000040;
  static evcClientDisconnected = 0x00000080;
  static evcClientTerminated = 0x00000100;
  static evcClientsDropped = 0x00000200;
  static evcPDUincoming = 0x00010000;
  static evcDataRead = 0x00020000;
  static evcDataWrite = 0x00040000;
  static evcNegotiatePDU = 0x00080000;
  static evcReadSZL = 0x00100000;
  static evcClock = 0x00200000;
  static evcUpload = 0x00400000;
  static evcDownload = 0x00800000;
  static evcDirectory = 0x01000000;
  static evcSecurity = 0x02000000;
  static evcControl = 0x04000000;

  static operationRead = 0x00;
  static operationWrite = 0x01;

  // Instance aliases (node-snap7 exposes these on both static and instance)
  srvAreaPE = S7Server.srvAreaPE;
  srvAreaPA = S7Server.srvAreaPA;
  srvAreaMK = S7Server.srvAreaMK;
  srvAreaCT = S7Server.srvAreaCT;
  srvAreaTM = S7Server.srvAreaTM;
  srvAreaDB = S7Server.srvAreaDB;
  operationRead = S7Server.operationRead;
  operationWrite = S7Server.operationWrite;

  /** @type {import('node:net').Server | null} */
  #server = null;
  /** @type {WasmBridge | null} */
  #bridge = null;
  /** @type {number} */
  #status = S7Server.SrvStopped;
  /** @type {number} */
  #lastError = 0;
  /** @type {number} */
  #eventMask = S7Server.evcAll;
  /** @type {number} */
  #cpuStatus = 0x08; // S7CpuStatusRun
  /** @type {number} */
  #maxClients = 32;
  /** @type {number} */
  #localPort = 102;
  /** @type {number} */
  #pduSize = DEFAULT_PDU_SIZE;
  /** @type {boolean} */
  #resourceless = false;

  /** @type {Map<number, Map<number, Buffer>>} area code → (index → Buffer) */
  #areas = new Map();

  /** @type {Set<import('node:net').Socket>} */
  #clients = new Set();

  /** @type {Map<number, any>} */
  #params = new Map();

  constructor() {
    super();
    // Initialize area maps
    for (let i = 0; i <= 5; i++) {
      this.#areas.set(i, new Map());
    }
  }

  // ═══════════════════════════════════════════════
  //  Admin
  // ═══════════════════════════════════════════════

  /**
   * Start the server on 0.0.0.0 (default port from params).
   * @param {((err: number) => void)} [callback]
   * @returns {boolean | void}
   */
  Start(callback) {
    return this.StartTo('0.0.0.0', callback);
  }

  /**
   * Start the server on a specific IP.
   * @param {string} ip
   * @param {((err: number) => void)} [callback]
   * @returns {boolean | void}
   */
  StartTo(ip, callback) {
    const op = this.#startAsync(ip);

    if (callback) {
      op.then(() => callback(0)).catch(() => callback(this.#lastError));
      return;
    }
    // Sync stub
    op.catch(() => {});
    return this.#status === S7Server.SrvRunning;
  }

  /**
   * Stop the server.
   * @param {((err: number) => void)} [callback]
   * @returns {boolean | void}
   */
  Stop(callback) {
    const op = this.#stopAsync();

    if (callback) {
      op.then(() => callback(0)).catch(() => callback(this.#lastError));
      return;
    }
    op.catch(() => {});
    return true;
  }

  /**
   * @param {number} paramNumber
   * @param {any} value
   * @returns {boolean}
   */
  SetParam(paramNumber, value) {
    this.#params.set(paramNumber, value);
    if (paramNumber === S7Server.LocalPort) this.#localPort = value;
    if (paramNumber === S7Server.MaxClients) this.#maxClients = value;
    if (paramNumber === S7Server.PDURequest) this.#pduSize = value;
    return true;
  }

  /**
   * @param {number} paramNumber
   * @returns {any}
   */
  GetParam(paramNumber) {
    if (paramNumber === S7Server.LocalPort) return this.#localPort;
    if (paramNumber === S7Server.MaxClients) return this.#maxClients;
    if (paramNumber === S7Server.PDURequest) return this.#pduSize;
    return this.#params.get(paramNumber) ?? false;
  }

  /**
   * @param {boolean} value
   * @returns {boolean}
   */
  SetResourceless(value) {
    this.#resourceless = value;
    return true;
  }

  // ═══════════════════════════════════════════════
  //  Memory areas
  // ═══════════════════════════════════════════════

  /**
   * Register a memory area.
   * For DB areas: RegisterArea(srvAreaDB, dbNumber, buffer)
   * For other areas: RegisterArea(areaCode, buffer)
   * @param {number} areaCode
   * @param {number | Buffer} indexOrBuffer
   * @param {Buffer} [buffer]
   * @returns {boolean}
   */
  RegisterArea(areaCode, indexOrBuffer, buffer) {
    const areaMap = this.#areas.get(areaCode);
    if (!areaMap) return false;

    if (Buffer.isBuffer(indexOrBuffer)) {
      // Non-DB: RegisterArea(areaCode, buffer)
      areaMap.set(0, indexOrBuffer);
    } else {
      // DB: RegisterArea(srvAreaDB, index, buffer)
      if (!buffer) return false;
      areaMap.set(indexOrBuffer, buffer);
    }
    return true;
  }

  /**
   * Unregister a memory area.
   * @param {number} areaCode
   * @param {number} [index=0]
   * @returns {boolean}
   */
  UnregisterArea(areaCode, index = 0) {
    const areaMap = this.#areas.get(areaCode);
    if (!areaMap) return false;
    return areaMap.delete(index);
  }

  /**
   * Get area buffer.
   * @param {number} areaCode
   * @param {number} [index=0]
   * @returns {Buffer}
   */
  GetArea(areaCode, index = 0) {
    const areaMap = this.#areas.get(areaCode);
    return areaMap?.get(index) ?? Buffer.alloc(0);
  }

  /**
   * Set (replace) area buffer.
   * @param {number} areaCode
   * @param {number | Buffer} indexOrBuffer
   * @param {Buffer} [buffer]
   */
  SetArea(areaCode, indexOrBuffer, buffer) {
    const areaMap = this.#areas.get(areaCode);
    if (!areaMap) return;

    if (Buffer.isBuffer(indexOrBuffer)) {
      areaMap.set(0, indexOrBuffer);
    } else if (buffer) {
      areaMap.set(indexOrBuffer, buffer);
    }
  }

  /**
   * Lock area (no-op in JS, provided for API compatibility).
   * @param {number} _areaCode
   * @param {number} [_index]
   */
  LockArea(_areaCode, _index) {}

  /**
   * Unlock area (no-op in JS).
   * @param {number} _areaCode
   * @param {number} [_index]
   */
  UnlockArea(_areaCode, _index) {}

  // ═══════════════════════════════════════════════
  //  Event mask / Status
  // ═══════════════════════════════════════════════

  /** @returns {number} */
  GetEventMask() { return this.#eventMask; }

  /** @param {number} mask */
  SetEventMask(mask) { this.#eventMask = mask; }

  /** @returns {number} */
  ServerStatus() { return this.#status; }

  /** @returns {number} */
  ClientsCount() { return this.#clients.size; }

  /** @returns {number} */
  GetCpuStatus() { return this.#cpuStatus; }

  /** @param {number} status */
  SetCpuStatus(status) { this.#cpuStatus = status; }

  /** @returns {number} */
  LastError() { return this.#lastError; }

  /**
   * Get human-readable event text.
   * @param {ServerEvent} event
   * @returns {string}
   */
  EventText(event) {
    const ts = event.EvtTime.toISOString();
    const sender = event.EvtSender || '0.0.0.0';
    const code = event.EvtCode;

    if (code & S7Server.evcServerStarted) return `${ts} [${sender}] Server started`;
    if (code & S7Server.evcServerStopped) return `${ts} [${sender}] Server stopped`;
    if (code & S7Server.evcClientAdded) return `${ts} [${sender}] Client added`;
    if (code & S7Server.evcClientDisconnected) return `${ts} [${sender}] Client disconnected`;
    if (code & S7Server.evcDataRead) return `${ts} [${sender}] Read request`;
    if (code & S7Server.evcDataWrite) return `${ts} [${sender}] Write request`;
    if (code & S7Server.evcNegotiatePDU) return `${ts} [${sender}] PDU negotiation`;
    if (code & S7Server.evcListenerCannotStart) return `${ts} [${sender}] Listener cannot start`;
    if (code & S7Server.evcClientRejected) return `${ts} [${sender}] Client rejected`;
    return `${ts} [${sender}] Event code: 0x${code.toString(16)}`;
  }

  /**
   * Get human-readable error text.
   * @param {number} errNum
   * @returns {string}
   */
  ErrorText(errNum) {
    if (errNum === 0) return 'OK';
    return `Server error (0x${errNum.toString(16)})`;
  }

  // ═══════════════════════════════════════════════
  //  Internal server implementation
  // ═══════════════════════════════════════════════

  async #startAsync(ip) {
    if (this.#status === S7Server.SrvRunning) return;

    try {
      const engine = await loadWasmEngine();
      this.#bridge = new WasmBridge(engine);

      await new Promise((resolve, reject) => {
        this.#server = createServer((socket) => this.#handleClient(socket));

        this.#server.on('error', (err) => {
          this.#lastError = 1;
          this.#status = S7Server.SrvError;
          this.#emitEvent(ip, S7Server.evcListenerCannotStart);
          reject(err);
        });

        this.#server.listen(this.#localPort, ip, () => {
          this.#status = S7Server.SrvRunning;
          // Capture the actual port (useful when #localPort was 0)
          const addr = this.#server?.address();
          if (addr && typeof addr === 'object') {
            this.#localPort = addr.port;
          }
          this.#emitEvent(ip, S7Server.evcServerStarted);
          resolve(undefined);
        });
      });
    } catch (err) {
      this.#lastError = 1;
      this.#status = S7Server.SrvError;
      throw err;
    }
  }

  async #stopAsync() {
    if (!this.#server) return;

    // Disconnect all clients
    for (const socket of this.#clients) {
      socket.destroy();
    }
    this.#clients.clear();

    await new Promise((resolve) => {
      this.#server?.close(() => {
        this.#status = S7Server.SrvStopped;
        this.#emitEvent('0.0.0.0', S7Server.evcServerStopped);
        resolve(undefined);
      });
    });
    this.#server = null;
  }

  /**
   * @param {string} sender
   * @param {number} code
   * @param {number} [retCode=0]
   * @param {number} [p1=0]
   * @param {number} [p2=0]
   */
  #emitEvent(sender, code, retCode = 0, p1 = 0, p2 = 0) {
    if (!(this.#eventMask & code)) return;

    /** @type {ServerEvent} */
    const event = {
      EvtTime: new Date(),
      EvtSender: sender,
      EvtCode: code,
      EvtRetCode: retCode,
      EvtParam1: p1,
      EvtParam2: p2,
      EvtParam3: 0,
      EvtParam4: 0,
    };
    this.emit('event', event);
  }

  /**
   * Handle an incoming TCP client.
   * @param {import('node:net').Socket} socket
   */
  #handleClient(socket) {
    if (this.#clients.size >= this.#maxClients) {
      this.#emitEvent(socket.remoteAddress ?? '', S7Server.evcClientRejected);
      socket.destroy();
      return;
    }

    this.#clients.add(socket);
    const sender = socket.remoteAddress ?? '0.0.0.0';
    this.#emitEvent(sender, S7Server.evcClientAdded);

    const assembler = new FrameAssembler();
    let clientConnected = false;

    socket.on('data', (/** @type {Buffer} */ data) => {
      const frames = assembler.feed(data);
      for (const frame of frames) {
        try {
          this.#handleFrame(socket, frame, sender);
          clientConnected = true;
        } catch (err) {
          this.#emitEvent(sender, S7Server.evcClientException);
        }
      }
    });

    socket.on('error', () => {
      this.#emitEvent(sender, S7Server.evcClientException);
    });

    socket.on('close', () => {
      this.#clients.delete(socket);
      this.#emitEvent(sender, S7Server.evcClientDisconnected);
    });
  }

  /**
   * @param {import('node:net').Socket} socket
   * @param {Buffer} frame
   * @param {string} sender
   */
  #handleFrame(socket, frame, sender) {
    if (!this.#bridge) return;

    const { cotpType, pdu } = this.#bridge.parseFrame(frame);

    // COTP Connection Request → reply with CC
    if (cotpType === COTP_CR) {
      const srcRef = this.#bridge.exports.cotp_getSrcRef();
      const cc = this.#bridge.buildCotpCC(srcRef, 1);
      socket.write(cc);
      return;
    }

    // COTP Disconnect Request → close
    if (cotpType === COTP_DR) {
      socket.end();
      return;
    }

    // COTP DT with S7 payload
    if (cotpType === COTP_DT && pdu) {
      this.#emitEvent(sender, S7Server.evcPDUincoming);

      if (pdu.functionCode === S7_FN_SETUP_COMM) {
        this.#handleSetupComm(socket, frame, pdu, sender);
      } else if (pdu.functionCode === S7_FN_READ_VAR) {
        this.#handleReadVar(socket, frame, pdu, sender);
      } else if (pdu.functionCode === S7_FN_WRITE_VAR) {
        this.#handleWriteVar(socket, frame, pdu, sender);
      }
    }
  }

  /**
   * Handle S7 Setup Communication request.
   * @param {import('node:net').Socket} socket
   * @param {Buffer} _frame
   * @param {import('../protocol/types.js').ParsedPDU} pdu
   * @param {string} sender
   */
  #handleSetupComm(socket, _frame, pdu, sender) {
    this.#emitEvent(sender, S7Server.evcNegotiatePDU);

    // Build Setup Comm response:
    // TPKT(4) + COTP DT(3) + S7 header(12) + params(8) = 27 bytes
    const resp = Buffer.alloc(27);

    // TPKT
    resp[0] = 0x03; resp[1] = 0x00;
    resp.writeUInt16BE(27, 2);

    // COTP DT
    resp[4] = 0x02; resp[5] = 0xF0; resp[6] = 0x80;

    // S7 Header
    resp[7] = S7_PROTOCOL_ID;          // 0x32
    resp[8] = S7_MSG_ACK_DATA;         // 0x03
    resp.writeUInt16BE(0, 9);          // reserved
    resp.writeUInt16BE(pdu.pduRef, 11); // pduRef echo
    resp.writeUInt16BE(8, 13);         // param length
    resp.writeUInt16BE(0, 15);         // data length
    resp[17] = 0; resp[18] = 0;       // error class, error code

    // Params
    resp[19] = S7_FN_SETUP_COMM;       // function code
    resp[20] = 0;                      // reserved
    resp.writeUInt16BE(DEFAULT_AMQ, 21);   // maxAmqCalling
    resp.writeUInt16BE(DEFAULT_AMQ, 23);   // maxAmqCalled
    resp.writeUInt16BE(this.#pduSize, 25); // pduSize

    socket.write(resp);
  }

  /**
   * Handle S7 Read Var request.
   * @param {import('node:net').Socket} socket
   * @param {Buffer} frame
   * @param {import('../protocol/types.js').ParsedPDU} pdu
   * @param {string} sender
   */
  #handleReadVar(socket, frame, pdu, sender) {
    // Parse S7 read request items from the frame.
    // JOB messages have a 10-byte S7 header (no error class/code)
    // After TPKT(4)+COTP DT(3)+S7 JOB header(10) = offset 17
    //   param[0] = functionCode (0x04)
    //   param[1] = itemCount
    //   param[2..] = item specs, each 12 bytes:
    //     [0] = varSpec (0x12), [1] = addrLen (0x0A), [2] = syntaxId (0x10),
    //     [3] = transportSize/wordLen, [4-5] = amount(BE), [6-7] = dbNumber(BE),
    //     [8] = area, [9-11] = start address (3 bytes BE, in bits)

    const paramOffset = 17;
    const itemCount = frame[paramOffset + 1];

    /** @type {{ area: number, dbNum: number, start: number, amount: number, wordLen: number }[]} */
    const items = [];

    for (let i = 0; i < itemCount; i++) {
      const base = paramOffset + 2 + (i * 12);
      const wordLen = frame[base + 3];
      const amount = frame.readUInt16BE(base + 4);
      const dbNum = frame.readUInt16BE(base + 6);
      const area = frame[base + 8];
      const startBits = (frame[base + 9] << 16) | (frame[base + 10] << 8) | frame[base + 11];
      const start = wordLen === S7WLBit ? startBits : Math.floor(startBits / 8);

      items.push({ area, dbNum, start, amount, wordLen });
    }

    // Build response
    /** @type {Buffer[]} */
    const dataItems = [];
    let totalDataLen = 0;

    for (const item of items) {
      const byteLen = this.#resolveByteLength(item.wordLen, item.amount);
      const srvAreaCode = s7AreaToSrvArea[item.area];
      const areaMap = srvAreaCode !== undefined ? this.#areas.get(srvAreaCode) : undefined;
      const index = item.area === S7AreaDB ? item.dbNum : 0;
      const areaBuf = areaMap?.get(index);

      if (this.#resourceless) {
        // In resourceless mode, emit readWrite event
        /** @type {ReadWriteTag} */
        const tag = { Area: item.area, DBNumber: item.dbNum, Start: item.start, Size: byteLen, WordLen: item.wordLen };
        const dataBuf = Buffer.alloc(byteLen);

        this.#emitEvent(sender, S7Server.evcDataRead, 0, item.area, item.dbNum);
        this.emit('readWrite', sender, S7Server.operationRead, tag, dataBuf, (/** @type {Buffer} */ result) => {
          // result written into dataBuf by user callback
        });

        const itemBuf = Buffer.alloc(4 + byteLen + (byteLen % 2));
        itemBuf[0] = 0xFF; // return code = success
        itemBuf[1] = 0x04; // transport size = byte
        itemBuf.writeUInt16BE(byteLen * 8, 2); // bit length
        dataBuf.copy(itemBuf, 4);
        dataItems.push(itemBuf);
        totalDataLen += itemBuf.length;
        continue;
      }

      if (!areaBuf || item.start + byteLen > areaBuf.length) {
        // Area not found or out of range
        const errItem = Buffer.alloc(4);
        errItem[0] = 0x0A; // return code = not yet available / not found
        errItem[1] = 0x00;
        errItem.writeUInt16BE(0, 2);
        dataItems.push(errItem);
        totalDataLen += 4;

        this.#emitEvent(sender, S7Server.evcDataRead, 0x0A, item.area, item.dbNum);
        continue;
      }

      // Read data from area
      const data = areaBuf.subarray(item.start, item.start + byteLen);
      const paddedLen = byteLen + (byteLen % 2 !== 0 && items.length > 1 ? 1 : 0); // Pad for multi-item
      const itemBuf = Buffer.alloc(4 + paddedLen);
      itemBuf[0] = 0xFF; // return code = success
      itemBuf[1] = 0x04; // transport size = byte
      itemBuf.writeUInt16BE(byteLen * 8, 2);
      data.copy(itemBuf, 4);
      dataItems.push(itemBuf);
      totalDataLen += itemBuf.length;

      this.#emitEvent(sender, S7Server.evcDataRead, 0, item.area, item.dbNum);
    }

    // Assemble response frame
    // TPKT(4) + COTP DT(3) + S7 header(12) + params(2) + data
    const respLen = 4 + 3 + 12 + 2 + totalDataLen;
    const resp = Buffer.alloc(respLen);

    // TPKT
    resp[0] = 0x03; resp[1] = 0x00;
    resp.writeUInt16BE(respLen, 2);

    // COTP DT
    resp[4] = 0x02; resp[5] = 0xF0; resp[6] = 0x80;

    // S7 Header (ack_data)
    resp[7] = S7_PROTOCOL_ID;
    resp[8] = S7_MSG_ACK_DATA;
    resp.writeUInt16BE(0, 9);
    resp.writeUInt16BE(pdu.pduRef, 11);
    resp.writeUInt16BE(2, 13);  // param length
    resp.writeUInt16BE(totalDataLen, 15); // data length
    resp[17] = 0; resp[18] = 0; // no error

    // Params
    resp[19] = S7_FN_READ_VAR;
    resp[20] = itemCount;

    // Data items
    let offset = 21;
    for (const item of dataItems) {
      item.copy(resp, offset);
      offset += item.length;
    }

    socket.write(resp);
  }

  /**
   * Handle S7 Write Var request.
   * @param {import('node:net').Socket} socket
   * @param {Buffer} frame
   * @param {import('../protocol/types.js').ParsedPDU} pdu
   * @param {string} sender
   */
  #handleWriteVar(socket, frame, pdu, sender) {
    // Parse write request: JOB messages have 10-byte S7 header
    const paramOffset = 17;
    const itemCount = frame[paramOffset + 1];
    const paramEnd = paramOffset + 2 + (itemCount * 12);

    /** @type {{ area: number, dbNum: number, start: number, amount: number, wordLen: number }[]} */
    const items = [];

    for (let i = 0; i < itemCount; i++) {
      const base = paramOffset + 2 + (i * 12);
      const wordLen = frame[base + 3];
      const amount = frame.readUInt16BE(base + 4);
      const dbNum = frame.readUInt16BE(base + 6);
      const area = frame[base + 8];
      const startBits = (frame[base + 9] << 16) | (frame[base + 10] << 8) | frame[base + 11];
      const start = wordLen === S7WLBit ? startBits : Math.floor(startBits / 8);

      items.push({ area, dbNum, start, amount, wordLen });
    }

    // Parse data items
    let dataOffset = paramEnd;
    /** @type {number[]} */
    const returnCodes = [];

    for (const item of items) {
      // data item header: returnCode(1) + transportSize(1) + bitLength(2) + data bytes
      if (dataOffset + 4 > frame.length) {
        returnCodes.push(0x03); // access fault
        continue;
      }

      // const dataReturnCode = frame[dataOffset];
      const dataTransportSize = frame[dataOffset + 1];
      const bitLength = frame.readUInt16BE(dataOffset + 2);
      const byteLen = dataTransportSize === 0x03 || dataTransportSize === 0x04
        ? Math.ceil(bitLength / 8)
        : bitLength; // transport size of bit → already byte count?

      const writeData = frame.subarray(dataOffset + 4, dataOffset + 4 + byteLen);
      dataOffset += 4 + byteLen;
      // Pad to even
      if (byteLen % 2 !== 0) dataOffset++;

      const srvAreaCode = s7AreaToSrvArea[item.area];
      const areaMap = srvAreaCode !== undefined ? this.#areas.get(srvAreaCode) : undefined;
      const index = item.area === S7AreaDB ? item.dbNum : 0;
      const areaBuf = areaMap?.get(index);

      if (this.#resourceless) {
        /** @type {ReadWriteTag} */
        const tag = { Area: item.area, DBNumber: item.dbNum, Start: item.start, Size: byteLen, WordLen: item.wordLen };
        this.emit('readWrite', sender, S7Server.operationWrite, tag, writeData, () => {});
        returnCodes.push(0xFF);
        this.#emitEvent(sender, S7Server.evcDataWrite, 0, item.area, item.dbNum);
        continue;
      }

      if (!areaBuf || item.start + byteLen > areaBuf.length) {
        returnCodes.push(0x0A);
        this.#emitEvent(sender, S7Server.evcDataWrite, 0x0A, item.area, item.dbNum);
        continue;
      }

      writeData.copy(areaBuf, item.start);
      returnCodes.push(0xFF);
      this.#emitEvent(sender, S7Server.evcDataWrite, 0, item.area, item.dbNum);
    }

    // Build write response
    // TPKT(4) + COTP DT(3) + S7 header(12) + params(2) + data(itemCount bytes)
    const respLen = 4 + 3 + 12 + 2 + itemCount;
    const resp = Buffer.alloc(respLen);

    resp[0] = 0x03; resp[1] = 0x00;
    resp.writeUInt16BE(respLen, 2);

    resp[4] = 0x02; resp[5] = 0xF0; resp[6] = 0x80;

    resp[7] = S7_PROTOCOL_ID;
    resp[8] = S7_MSG_ACK_DATA;
    resp.writeUInt16BE(0, 9);
    resp.writeUInt16BE(pdu.pduRef, 11);
    resp.writeUInt16BE(2, 13);
    resp.writeUInt16BE(itemCount, 15);
    resp[17] = 0; resp[18] = 0;

    resp[19] = S7_FN_WRITE_VAR;
    resp[20] = itemCount;

    for (let i = 0; i < itemCount; i++) {
      resp[21 + i] = returnCodes[i];
    }

    socket.write(resp);
  }

  /**
   * Convert wordLen + amount to byte count.
   * @param {number} wordLen
   * @param {number} amount
   * @returns {number}
   */
  #resolveByteLength(wordLen, amount) {
    switch (wordLen) {
      case 0x01: return Math.ceil(amount / 8); // Bit
      case 0x02: return amount;                 // Byte
      case 0x04: return amount * 2;             // Word
      case 0x06: return amount * 4;             // DWord
      case 0x08: return amount * 4;             // Real
      case 0x1C: return amount * 2;             // Counter
      case 0x1D: return amount * 2;             // Timer
      default:   return amount;
    }
  }
}
