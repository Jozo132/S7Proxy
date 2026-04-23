// @ts-check
// TCP listener — accepts incoming S7 client connections

import { createServer } from 'node:net';
import { EventEmitter } from 'node:events';

/** @import { Server, Socket } from 'node:net' */
/** @import { Logger } from '../logging/logger.js' */

export class TcpListener extends EventEmitter {
  /** @type {Logger} */
  #logger;
  /** @type {number} */
  #port;
  /** @type {string} */
  #host;
  /** @type {Server | null} */
  #server = null;
  /** @type {Set<Socket>} */
  #sockets = new Set();

  /**
   * @param {number} port
   * @param {string} host
   * @param {Logger} logger
   */
  constructor(port, host, logger) {
    super();
    this.#port = port;
    this.#host = host;
    this.#logger = logger.child({ component: 'tcp-listener' });
  }

  get port() { return this.#port; }
  get host() { return this.#host; }

  /** @returns {Promise<void>} */
  async start() {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => {
        this.#sockets.add(socket);
        socket.on('close', () => {
          this.#sockets.delete(socket);
        });
        this.#logger.debug({ remote: `${socket.remoteAddress}:${socket.remotePort}` }, 'New client connection');
        this.emit('connection', socket);
      });

      server.on('error', (err) => {
        this.#logger.error({ err }, 'TCP server error');
        this.emit('error', err);
        reject(err);
      });

      server.listen(this.#port, this.#host, () => {
        this.#logger.info({ port: this.#port, host: this.#host }, 'TCP listener started');
        resolve();
      });

      this.#server = server;
    });
  }

  /** @returns {Promise<void>} */
  async stop() {
    if (!this.#server) return;
    return new Promise((resolve) => {
      for (const socket of this.#sockets) {
        socket.destroy();
      }
      this.#server?.close(() => {
        this.#logger.info('TCP listener stopped');
        this.#server = null;
        this.#sockets.clear();
        resolve();
      });
    });
  }
}
