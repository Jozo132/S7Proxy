// @ts-check
// Outbound connection to a single PLC endpoint
// Handles TCP socket, COTP handshake, S7 Setup Communication

import { Socket } from 'node:net';
import { EventEmitter } from 'eventemitter3';
import { FrameAssembler } from '../protocol/frame-assembler.js';
import { WasmBridge } from '../wasm/bridge.js';
import { S7_DEFAULT_PORT, CONNTYPE_PG, calcTsap, DEFAULT_PDU_SIZE, DEFAULT_AMQ, COTP_CC, S7_FN_SETUP_COMM } from '../protocol/constants.js';

/** @import { PlcEndpoint, PlcConnectionInfo, ParsedPDU } from '../protocol/types.js' */
/** @import pino from 'pino' */

export class PlcConnection extends EventEmitter {
  /** @readonly @type {string} */
  id;
  /** @readonly @type {string} */
  targetId;
  /** @readonly @type {PlcEndpoint} */
  endpoint;

  /** @type {Socket | null} */
  #socket = null;
  #frameAssembler = new FrameAssembler();
  /** @type {WasmBridge} */
  #bridge;
  /** @type {pino.Logger} */
  #logger;

  /** @type {PlcConnectionInfo['state']} */
  #state = 'closed';
  #pduSize = DEFAULT_PDU_SIZE;
  #maxAmqCalling = DEFAULT_AMQ;
  #maxAmqCalled = DEFAULT_AMQ;
  #freeAmqSlots = DEFAULT_AMQ;
  #connectedAt = 0;
  #lastActivityAt = 0;

  /** @type {Map<number, { resolve: (data: Buffer) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>} */
  #pendingResponses = new Map();

  /** @type {(() => void) | undefined} */
  #connectResolve;
  /** @type {((err: Error) => void) | undefined} */
  #connectReject;
  /** @type {number} */
  #requestTimeoutMs;

  /**
   * @param {string} id
   * @param {string} targetId
   * @param {PlcEndpoint} endpoint
   * @param {WasmBridge} bridge
   * @param {pino.Logger} logger
   * @param {number} [requestTimeoutMs=3000]
   */
  constructor(id, targetId, endpoint, bridge, logger, requestTimeoutMs = 3000) {
    super();
    this.id = id;
    this.targetId = targetId;
    this.endpoint = endpoint;
    this.#bridge = bridge;
    this.#logger = logger.child({ component: 'plc-conn', connId: id, target: targetId });
    this.#requestTimeoutMs = requestTimeoutMs;
  }

  get state() { return this.#state; }
  get pduSize() { return this.#pduSize; }
  get maxAmqCalling() { return this.#maxAmqCalling; }
  get freeAmqSlots() { return this.#freeAmqSlots; }
  get connectedAt() { return this.#connectedAt; }

  /** @returns {PlcConnectionInfo} */
  get info() {
    return {
      id: this.id,
      targetId: this.targetId,
      endpoint: this.endpoint,
      state: this.#state,
      pduSize: this.#pduSize,
      maxAmqCalling: this.#maxAmqCalling,
      maxAmqCalled: this.#maxAmqCalled,
      freeAmqSlots: this.#freeAmqSlots,
      connectedAt: this.#connectedAt,
      lastActivityAt: this.#lastActivityAt,
    };
  }

  /** Open TCP connection, perform COTP + S7 handshake. Resolves when ready. */
  async connect() {
    if (this.#state === 'ready') return;

    this.#state = 'connecting';
    this.#frameAssembler.reset();

    return new Promise((resolve, reject) => {
      this.#connectResolve = resolve;
      this.#connectReject = reject;

      const socket = new Socket();
      this.#socket = socket;

      const timeout = setTimeout(() => {
        socket.destroy();
        this.#state = 'error';
        reject(new Error(`Connection timeout to ${this.endpoint.ip}`));
      }, this.#requestTimeoutMs * 2);

      socket.connect(this.endpoint.port ?? S7_DEFAULT_PORT, this.endpoint.ip, () => {
        clearTimeout(timeout);
        this.#logger.debug('TCP connected');
        this.#state = 'cotp';
        this.#connectedAt = Date.now();
        this.#sendCotpCR();
      });

      socket.on('data', (/** @type {Buffer} */ data) => this.#onData(data));

      socket.on('error', (err) => {
        clearTimeout(timeout);
        this.#logger.error({ err }, 'Socket error');
        this.#state = 'error';
        this.#rejectAllPending(err);
        if (this.#connectReject) {
          this.#connectReject(err);
          this.#connectResolve = undefined;
          this.#connectReject = undefined;
        }
        this.emit('error', err);
      });

      socket.on('close', () => {
        this.#logger.debug('Socket closed');
        this.#state = 'closed';
        this.#rejectAllPending(new Error('Connection closed'));
        this.emit('close');
      });
    });
  }

  /**
   * Send a raw S7 PDU frame. Returns the response PDU data.
   * @param {Buffer} frame
   * @param {number} pduRef
   * @returns {Promise<Buffer>}
   */
  async sendRequest(frame, pduRef) {
    if (this.#state !== 'ready' || !this.#socket) {
      throw new Error(`Connection not ready (state: ${this.#state})`);
    }
    if (this.#freeAmqSlots <= 0) {
      throw new Error('No free AMQ slots');
    }

    this.#freeAmqSlots--;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingResponses.delete(pduRef);
        this.#freeAmqSlots++;
        reject(new Error(`Request timeout (pduRef: ${pduRef})`));
      }, this.#requestTimeoutMs);

      this.#pendingResponses.set(pduRef, { resolve, reject, timer });
      this.#socket?.write(frame);
      this.#lastActivityAt = Date.now();
    });
  }

  /**
   * Send raw data directly on the socket (for proxying).
   * @param {Buffer} data
   * @returns {boolean}
   */
  writeRaw(data) {
    if (!this.#socket || this.#socket.destroyed) return false;
    this.#lastActivityAt = Date.now();
    return this.#socket.write(data);
  }

  /** @returns {Promise<void>} */
  async disconnect() {
    if (this.#socket && !this.#socket.destroyed) {
      const dr = this.#bridge.buildCotpDR(1, 0, 0);
      this.#socket.write(dr);

      return new Promise((resolve) => {
        this.#socket?.once('close', resolve);
        this.#socket?.end();
        setTimeout(() => {
          if (this.#socket && !this.#socket.destroyed) {
            this.#socket.destroy();
          }
          resolve();
        }, 2000);
      });
    }
    this.#state = 'closed';
  }

  #sendCotpCR() {
    const srcTsap = calcTsap(CONNTYPE_PG, 0, 0);
    const dstTsap = calcTsap(CONNTYPE_PG, this.endpoint.rack, this.endpoint.slot);
    const frame = this.#bridge.buildCotpCR(srcTsap, dstTsap);
    this.#socket?.write(frame);
  }

  /** @param {Buffer} data */
  #onData(data) {
    const frames = this.#frameAssembler.feed(data);

    for (const frame of frames) {
      try {
        this.#handleFrame(frame);
      } catch (err) {
        this.#logger.error({ err }, 'Frame handling error');
      }
    }
  }

  /** @param {Buffer} frame */
  #handleFrame(frame) {
    const { cotpType, pdu } = this.#bridge.parseFrame(frame);

    if (this.#state === 'cotp' && cotpType === COTP_CC) {
      this.#logger.debug('COTP CC received');
      this.#state = 's7_setup';
      const setupFrame = this.#bridge.buildSetupComm(this.#maxAmqCalling, this.#maxAmqCalled, this.#pduSize);
      this.#socket?.write(setupFrame);
      return;
    }

    if (this.#state === 's7_setup' && pdu && pdu.functionCode === S7_FN_SETUP_COMM) {
      this.#logger.debug('S7 Setup Communication completed');
      this.#state = 'ready';
      this.#freeAmqSlots = this.#maxAmqCalling;
      if (this.#connectResolve) {
        this.#connectResolve();
        this.#connectResolve = undefined;
        this.#connectReject = undefined;
      }
      this.emit('ready');
      return;
    }

    if (this.#state === 'ready' && pdu) {
      this.#lastActivityAt = Date.now();

      const pending = this.#pendingResponses.get(pdu.pduRef);
      if (pending) {
        clearTimeout(pending.timer);
        this.#pendingResponses.delete(pdu.pduRef);
        this.#freeAmqSlots++;
        pending.resolve(frame);
      } else {
        this.emit('data', pdu);
      }
    }
  }

  /** @param {Error} err */
  #rejectAllPending(err) {
    for (const [, pending] of this.#pendingResponses) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.#pendingResponses.clear();
    this.#freeAmqSlots = this.#maxAmqCalling;
  }
}
