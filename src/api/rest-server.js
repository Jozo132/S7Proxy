// @ts-check
// REST API server (Fastify)

import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { registerRoutes } from './rest-routes.js';

/** @import { FastifyInstance } from 'fastify' */
/** @import { WebApiConfig } from '../protocol/types.js' */
/** @import { ConnectionPool } from '../client/connection-pool.js' */
/** @import { DaqEngine } from '../daq/daq-engine.js' */
/** @import { Metrics } from '../metrics/metrics.js' */
/** @import { StructManager } from '../protocol/struct-manager.js' */
/** @import { Socket } from 'node:net' */
/** @import pino from 'pino' */

export class RestServer {
  /** @type {FastifyInstance} */
  #app;
  /** @type {WebApiConfig} */
  #config;
  /** @type {pino.Logger} */
  #logger;
  /** @type {ConnectionPool | null} */
  #pool;
  /** @type {DaqEngine | null} */
  #daq;
  /** @type {Set<Socket>} */
  #sockets = new Set();

  /**
   * @param {ConnectionPool | null} pool
   * @param {DaqEngine | null} daq
   * @param {Metrics} metrics
   * @param {WebApiConfig} config
   * @param {pino.Logger} logger
   * @param {StructManager} [structs]
   */
  constructor(pool, daq, metrics, config, logger, structs) {
    this.#config = config;
    this.#logger = logger.child({ component: 'rest' });
    this.#pool = pool;
    this.#daq = daq;

    this.#app = Fastify({ logger: false });
    this.#app.server.on('connection', (socket) => {
      this.#sockets.add(socket);
      socket.on('close', () => {
        this.#sockets.delete(socket);
      });
    });
    this.#setupPromise = this.#setup(metrics, structs);
  }

  /** @type {Promise<void>} */
  #setupPromise;

  /**
   * @param {Metrics} metrics
   * @param {StructManager} [structs]
   */
  async #setup(metrics, structs) {
    await this.#app.register(cors, {
      origin: this.#config.cors?.origin ?? '*',
    });

    await this.#app.register(rateLimit, {
      max: this.#config.rateLimit?.max ?? 100,
      timeWindow: this.#config.rateLimit?.windowMs ?? 60000,
    });

    registerRoutes(this.#app, () => this.#pool, () => this.#daq, metrics, structs);
  }

  /**
   * Update the runtime objects used by the REST routes.
   * @param {ConnectionPool | null} pool
   * @param {DaqEngine | null} daq
   */
  bindRuntime(pool, daq) {
    this.#pool = pool;
    this.#daq = daq;
  }

  async start() {
    await this.#setupPromise;
    const address = await this.#app.listen({
      host: this.#config.host ?? '0.0.0.0',
      port: this.#config.port ?? 8080,
    });
    this.#logger.info({ address }, 'REST API started');
  }

  async stop() {
    const closePromise = this.#app.close();
    for (const socket of this.#sockets) {
      socket.destroy();
    }
    await closePromise;
    this.#sockets.clear();
    this.#logger.info('REST API stopped');
  }

  /** @returns {FastifyInstance} */
  get server() {
    return this.#app;
  }
}
