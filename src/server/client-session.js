// @ts-check
// Inbound client session — handles COTP/S7 handshake and request proxying

import { EventEmitter } from 'node:events';
import { FrameAssembler } from '../protocol/frame-assembler.js';
import { COTP_CR, COTP_DT, COTP_DR, S7_FN_SETUP_COMM, DEFAULT_PDU_SIZE, DEFAULT_AMQ } from '../protocol/constants.js';

/** @import { Socket } from 'node:net' */
/** @import { SessionState, SessionInfo, ParsedPDU } from '../protocol/types.js' */
/** @import { WasmBridge } from '../wasm/bridge.js' */
/** @import pino from 'pino' */

let sessionCounter = 0;

export class ClientSession extends EventEmitter {
  /** @readonly @type {string} */
  id;
  /** @type {Socket} */
  #socket;
  /** @type {WasmBridge} */
  #bridge;
  /** @type {pino.Logger} */
  #logger;

  /** @type {SessionState} */
  #state = 'COTP_WAIT';
  #frameAssembler = new FrameAssembler();
  #pduSize = DEFAULT_PDU_SIZE;
  #maxAmq = DEFAULT_AMQ;
  #connectedAt = Date.now();
  #lastActivityAt = Date.now();
  /** @type {string | null} */
  #resolvedTarget = null;

  /**
   * @param {Socket} socket
   * @param {WasmBridge} bridge
   * @param {pino.Logger} logger
   */
  constructor(socket, bridge, logger) {
    super();
    this.id = `session-${++sessionCounter}`;
    this.#socket = socket;
    this.#bridge = bridge;
    this.#logger = logger.child({ component: 'session', sessionId: this.id, remote: `${socket.remoteAddress}:${socket.remotePort}` });

    socket.on('data', (/** @type {Buffer} */ data) => this.#onData(data));
    socket.on('close', () => this.#handleClose());
    socket.on('error', (err) => {
      this.#logger.error({ err }, 'Session socket error');
      this.emit('error', err);
    });
  }

  get state() { return this.#state; }
  get resolvedTarget() { return this.#resolvedTarget; }

  /** @returns {SessionInfo} */
  get info() {
    return {
      id: this.id,
      remoteAddress: this.#socket.remoteAddress ?? 'unknown',
      state: this.#state,
      targetId: this.#resolvedTarget,
      connectedAt: this.#connectedAt,
      lastActivityAt: this.#lastActivityAt,
      pduSize: this.#pduSize,
    };
  }

  /** @param {string} targetId */
  setTarget(targetId) {
    this.#resolvedTarget = targetId;
  }

  /**
   * Write response frame back to the client.
   * @param {Buffer} data
   */
  respond(data) {
    if (!this.#socket.destroyed) {
      this.#socket.write(data);
    }
  }

  close() {
    if (!this.#socket.destroyed) {
      this.#socket.end();
    }
    this.#state = 'CLOSED';
  }

  /** @param {Buffer} data */
  #onData(data) {
    this.#lastActivityAt = Date.now();
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

    switch (this.#state) {
      case 'COTP_WAIT':
        if (cotpType === COTP_CR) {
          this.#logger.debug('COTP CR received');
          const cc = this.#bridge.buildCotpCC(1, 0);
          this.#socket.write(cc);
          this.#state = 'S7_WAIT';
          this.emit('cotp:connected');
        } else if (cotpType === COTP_DR) {
          this.close();
        }
        break;

      case 'S7_WAIT':
        if (pdu && pdu.functionCode === S7_FN_SETUP_COMM) {
          this.#logger.debug('S7 Setup Communication received');
          const resp = this.#bridge.buildSetupComm(this.#maxAmq, this.#maxAmq, this.#pduSize);
          this.#socket.write(resp);
          this.#state = 'ACTIVE';
          this.emit('s7:ready');
        }
        break;

      case 'ACTIVE':
        if (cotpType === COTP_DT && pdu) {
          this.emit('request', frame, pdu);
        } else if (cotpType === COTP_DR) {
          this.close();
        }
        break;

      default:
        break;
    }
  }

  #handleClose() {
    this.#state = 'CLOSED';
    this.#logger.debug('Session closed');
    this.emit('close');
  }
}
