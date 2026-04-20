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
/** @import pino from 'pino' */

export class RestServer {
  /** @type {FastifyInstance} */
  #app;
  /** @type {WebApiConfig} */
  #config;
  /** @type {pino.Logger} */
  #logger;

  /**
   * @param {ConnectionPool} pool
   * @param {DaqEngine} daq
   * @param {Metrics} metrics
   * @param {WebApiConfig} config
   * @param {pino.Logger} logger
   */
  constructor(pool, daq, metrics, config, logger) {
    this.#config = config;
    this.#logger = logger.child({ component: 'rest' });

    this.#app = Fastify({ logger: false });
    this.#setupPromise = this.#setup(pool, daq, metrics);
  }

  /** @type {Promise<void>} */
  #setupPromise;

  /**
   * @param {ConnectionPool} pool
   * @param {DaqEngine} daq
   * @param {Metrics} metrics
   */
  async #setup(pool, daq, metrics) {
    await this.#app.register(cors, {
      origin: this.#config.cors?.origin ?? '*',
    });

    await this.#app.register(rateLimit, {
      max: this.#config.rateLimit?.max ?? 100,
      timeWindow: this.#config.rateLimit?.windowMs ?? 60000,
    });

    registerRoutes(this.#app, pool, daq, metrics);
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
    await this.#app.close();
    this.#logger.info('REST API stopped');
  }

  /** @returns {FastifyInstance} */
  get server() {
    return this.#app;
  }
}
