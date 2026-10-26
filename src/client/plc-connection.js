// @ts-check
// Outbound connection to a single PLC endpoint
// Handles TCP socket, COTP handshake, S7 Setup Communication

import { Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { FrameAssembler } from '../protocol/frame-assembler.js';
import { WasmBridge } from '../wasm/bridge.js';
import { assertClassicTarget } from '../protocol/production-policy.js';
import { S7_DEFAULT_PORT, CONNTYPE_PG, calcTsap, DEFAULT_PDU_SIZE, DEFAULT_AMQ, COTP_CC, S7_FN_SETUP_COMM, S7_MSG_ACK } from '../protocol/constants.js';

/** @import { PlcEndpoint, PlcConnectionInfo, ParsedPDU } from '../protocol/types.js' */
/** @import { Logger } from '../logging/logger.js' */

const ACK_FOLLOWUP_GRACE_MS = 100;

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
  /** @type {Logger} */
  #logger;

  /** @type {PlcConnectionInfo['state']} */
  #state = 'closed';
  #pduSize = DEFAULT_PDU_SIZE;
  #maxAmqCalling = DEFAULT_AMQ;
  #maxAmqCalled = DEFAULT_AMQ;
  #freeAmqSlots = DEFAULT_AMQ;
  #connectedAt = 0;
  #lastActivityAt = 0;

  /** @type {Map<number, { resolve: (data: Buffer) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout>; ackTimer?: ReturnType<typeof setTimeout>; ackFrame?: Buffer }>} */
  #pendingResponses = new Map();

  /** @type {(() => void) | undefined} */
  #connectResolve;
  /** @type {((err: Error) => void) | undefined} */
  #connectReject;
  /** @type {number} */
  #requestTimeoutMs;
  /** @type {Promise<void> | null} */
  #connectPromise = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #connectTimer;
  /** @type {Promise<void> | null} */
  #disconnectPromise = null;

  /**
   * @param {string} id
   * @param {string} targetId
   * @param {PlcEndpoint} endpoint
   * @param {WasmBridge} bridge
   * @param {Logger} logger
   * @param {number} [requestTimeoutMs=3000]
   */
  constructor(id, targetId, endpoint, bridge, logger, requestTimeoutMs = 3000) {
    super();
    assertClassicTarget(endpoint.ip);
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

  /** Open TCP connection, perform COTP + S7 handshake. @returns {Promise<void>} */
  connect() {
    assertClassicTarget(this.endpoint.ip);
    if (this.#disconnectPromise) return this.#disconnectPromise.then(() => this.connect());
    if (this.#state === 'ready') return Promise.resolve();
    if (this.#connectPromise) return this.#connectPromise;

    this.#state = 'connecting';
    this.#frameAssembler.reset();

    this.#connectPromise = new Promise((resolve, reject) => {
      this.#connectResolve = resolve;
      this.#connectReject = reject;
    });
    const promise = this.#connectPromise;
    const socket = new Socket();
    this.#socket = socket;

    this.#connectTimer = setTimeout(() => {
      this.#failConnection(new Error(`Connection timeout to ${this.endpoint.ip} (state: ${this.#state})`));
    }, this.#requestTimeoutMs * 2);

    socket.on('data', (/** @type {Buffer} */ data) => {
      if (this.#socket === socket) this.#onData(data);
    });
    socket.on('error', (err) => {
      if (this.#socket !== socket) return;
      this.#failConnection(err);
      this.emit('error', err);
    });
    socket.on('close', () => {
      if (this.#socket !== socket) return;
      this.#logger.debug('Socket closed');
      this.#socket = null;
      this.#state = 'closed';
      const err = new Error('Connection closed');
      this.#settleConnect(err);
      this.#rejectAllPending(err);
      this.emit('close');
    });

    try {
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 1000);
      socket.connect(this.endpoint.port ?? S7_DEFAULT_PORT, this.endpoint.ip, () => {
        if (this.#socket !== socket || this.#state !== 'connecting') return;
        this.#logger.debug('TCP connected');
        this.#state = 'cotp';
        this.#connectedAt = Date.now();
        try {
          this.#sendCotpCR();
        } catch (err) {
          this.#failConnection(err instanceof Error ? err : new Error(String(err)));
        }
      });
    } catch (err) {
      this.#failConnection(err instanceof Error ? err : new Error(String(err)));
    }
    return promise;
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
    if (this.#pendingResponses.has(pduRef)) {
      throw new Error(`Duplicate pending PDU reference: ${pduRef}`);
    }

    this.#freeAmqSlots--;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pendingResponses.has(pduRef)) return;
        this.#failConnection(new Error(`Request timeout (pduRef: ${pduRef})`));
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
  disconnect() {
    if (this.#disconnectPromise) return this.#disconnectPromise;
    const socket = this.#socket;
    const wasReady = this.#state === 'ready';
    this.#state = 'closed';
    const err = new Error('Connection closed');
    this.#settleConnect(err);
    this.#rejectAllPending(err);
    if (!socket || socket.destroyed) return Promise.resolve();

    this.#disconnectPromise = new Promise((resolve) => {
      const timer = setTimeout(() => socket.destroy(), 2000);
      socket.once('close', () => {
        clearTimeout(timer);
        this.#disconnectPromise = null;
        resolve();
      });
    });
    try {
      if (wasReady) socket.end(this.#bridge.buildCotpDR(1, 0, 0));
      else socket.destroy();
    } catch (err) {
      this.#logger.error({ err }, 'Disconnect failed');
      socket.destroy();
    }
    return this.#disconnectPromise;
  }

  /** @param {Error} [err] */
  #settleConnect(err) {
    clearTimeout(this.#connectTimer);
    this.#connectTimer = undefined;
    const resolve = this.#connectResolve;
    const reject = this.#connectReject;
    this.#connectResolve = undefined;
    this.#connectReject = undefined;
    this.#connectPromise = null;
    if (err) reject?.(err);
    else resolve?.();
  }

  /** @param {Error} err */
  #failConnection(err) {
    this.#logger.error({ err }, 'PLC connection failed');
    this.#state = 'error';
    this.#settleConnect(err);
    this.#rejectAllPending(err);
    this.#socket?.destroy();
  }

  #sendCotpCR() {
    const srcTsap = calcTsap(CONNTYPE_PG, 0, 0);
    const dstTsap = calcTsap(CONNTYPE_PG, this.endpoint.rack, this.endpoint.slot);
    const frame = this.#bridge.buildCotpCR(srcTsap, dstTsap);
    this.#socket?.write(frame);
  }

  /** @param {Buffer} data */
  #onData(data) {
    try {
      const frames = this.#frameAssembler.feed(data);
      for (const frame of frames) this.#handleFrame(frame);
    } catch (err) {
      this.#failConnection(err instanceof Error ? err : new Error(String(err)));
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
      this.#settleConnect();
      this.emit('ready');
      return;
    }

    if (this.#state === 'ready' && pdu) {
      this.#lastActivityAt = Date.now();

      const pending = this.#pendingResponses.get(pdu.pduRef);
      if (pending) {
        if (pdu.messageType === S7_MSG_ACK) {
          pending.ackFrame = frame;
          if (!pending.ackTimer) {
            pending.ackTimer = setTimeout(() => {
              const ackPending = this.#pendingResponses.get(pdu.pduRef);
              if (!ackPending?.ackFrame) return;

              clearTimeout(ackPending.timer);
              ackPending.ackTimer = undefined;
              this.#pendingResponses.delete(pdu.pduRef);
              this.#freeAmqSlots++;
              ackPending.resolve(ackPending.ackFrame);
            }, Math.min(ACK_FOLLOWUP_GRACE_MS, this.#requestTimeoutMs));
          }
          return;
        }

        clearTimeout(pending.timer);
        if (pending.ackTimer) clearTimeout(pending.ackTimer);
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
      if (pending.ackTimer) clearTimeout(pending.ackTimer);
      pending.reject(err);
    }
    this.#pendingResponses.clear();
    this.#freeAmqSlots = this.#maxAmqCalling;
  }
}
