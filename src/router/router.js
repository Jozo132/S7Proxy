// @ts-check
// Proxy router — maps inbound client sessions to outbound PLC connections

import { EventEmitter } from 'node:events';

/** @import { ClientSession } from '../server/client-session.js' */
/** @import { ConnectionPool } from '../client/connection-pool.js' */
/** @import { RoutingRule, FilterRule, S7ProxyConfig, PlcTarget, ParsedPDU } from '../protocol/types.js' */
/** @import { Metrics } from '../metrics/metrics.js' */
/** @import pino from 'pino' */

export class ProxyRouter extends EventEmitter {
  /** @type {ConnectionPool} */
  #pool;
  /** @type {RoutingRule[]} */
  #routes;
  /** @type {FilterRule[]} */
  #filters;
  /** @type {Map<string, PlcTarget>} */
  #targets;
  /** @type {pino.Logger} */
  #logger;
  /** @type {Metrics} */
  #metrics;

  /**
   * @param {ConnectionPool} pool
   * @param {S7ProxyConfig} config
   * @param {pino.Logger} logger
   * @param {Metrics} metrics
   */
  constructor(pool, config, logger, metrics) {
    super();
    this.#pool = pool;
    this.#routes = config.routing ?? [];
    this.#filters = config.filters ?? [];
    this.#targets = new Map(config.targets.map((t) => [t.id, t]));
    this.#logger = logger.child({ component: 'router' });
    this.#metrics = metrics;
  }

  /**
   * Handle a new client session — determine target, set up proxying.
   * @param {ClientSession} session
   */
  handleSession(session) {
    this.#metrics.clientConnectionsTotal.inc();
    this.#metrics.clientConnectionsActive.inc();

    session.on('cotp:connected', () => {
      const targetId = this.#resolveTarget(session);

      if (!targetId) {
        this.#logger.warn({ sessionId: session.id }, 'No route found');
        this.emit('session:blocked', session.id, 'no_route');
        session.close();
        return;
      }

      session.setTarget(targetId);

      if (this.#isFiltered(session, targetId)) {
        this.#logger.warn({ sessionId: session.id, targetId }, 'Connection filtered');
        this.emit('session:blocked', session.id, 'filtered');
        session.close();
        return;
      }

      this.#logger.info({ sessionId: session.id, targetId }, 'Session routed');
      this.emit('session:routed', session.id, targetId);
    });

    session.on('request', (/** @type {Buffer} */ frame, /** @type {ParsedPDU} */ pdu) => {
      this.#forwardRequest(session, frame, pdu);
    });

    session.on('close', () => {
      this.#metrics.clientConnectionsActive.dec();
      this.#logger.debug({ sessionId: session.id }, 'Session closed');
    });
  }

  /**
   * @param {ClientSession} session
   * @returns {string | null}
   */
  #resolveTarget(session) {
    for (const rule of this.#routes) {
      if (this.#matchRoute(rule, session)) {
        return rule.targetId;
      }
    }
    if (this.#targets.size > 0) {
      return this.#targets.keys().next().value ?? null;
    }
    return null;
  }

  /**
   * @param {RoutingRule} rule
   * @param {ClientSession} session
   * @returns {boolean}
   */
  #matchRoute(rule, session) {
    if (rule.srcIp && session.info.remoteAddress !== rule.srcIp) return false;
    return true;
  }

  /**
   * @param {ClientSession} session
   * @param {string} targetId
   * @returns {boolean}
   */
  #isFiltered(session, targetId) {
    for (const filter of this.#filters) {
      if (filter.targetId && filter.targetId !== targetId) continue;
      if (filter.action === 'deny') {
        if (this.#matchFilter(filter, session)) return true;
      }
    }
    return false;
  }

  /**
   * @param {FilterRule} filter
   * @param {ClientSession} session
   * @returns {boolean}
   */
  #matchFilter(filter, session) {
    if (filter.srcIp && session.info.remoteAddress !== filter.srcIp) return false;
    return true;
  }

  /**
   * @param {ClientSession} session
   * @param {Buffer} frame
   * @param {ParsedPDU} pdu
   */
  async #forwardRequest(session, frame, pdu) {
    if (!session.resolvedTarget) return;

    try {
      this.#metrics.pdusIn.inc({ direction: 'client' });
      const conn = this.#pool.acquire();
      if (!conn) {
        this.#logger.error({ sessionId: session.id }, 'No available connection');
        return;
      }

      const response = await conn.sendRequest(frame, pdu.pduRef);
      this.#metrics.pdusOut.inc({ direction: 'client' });
      session.respond(response);
    } catch (err) {
      this.#logger.error({ err, sessionId: session.id, target: session.resolvedTarget }, 'Forward failed');
    }
  }
}
