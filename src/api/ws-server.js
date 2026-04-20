// @ts-check
// WebSocket server for real-time DAQ streaming

import { EventEmitter } from 'eventemitter3';
import { WebSocketServer, WebSocket } from 'ws';

/** @import { Server as HttpServer } from 'node:http' */
/** @import { DaqEngine } from '../daq/daq-engine.js' */
/** @import { DaqConfig } from '../protocol/types.js' */
/** @import { Metrics } from '../metrics/metrics.js' */
/** @import pino from 'pino' */

/**
 * @typedef {Object} WsClient
 * @property {WebSocket} ws
 * @property {string} id
 * @property {string[]} subscriptionIds
 * @property {number} droppedFrames
 * @property {number} droppedSince
 */

export class WsServer extends EventEmitter {
  /** @type {WebSocketServer | null} */
  #wss = null;
  /** @type {Map<string, WsClient>} */
  #clients = new Map();
  /** @type {DaqEngine} */
  #daq;
  /** @type {DaqConfig} */
  #config;
  /** @type {Metrics} */
  #metrics;
  /** @type {pino.Logger} */
  #logger;
  #clientCounter = 0;

  /**
   * @param {DaqEngine} daq
   * @param {DaqConfig} config
   * @param {Metrics} metrics
   * @param {pino.Logger} logger
   */
  constructor(daq, config, metrics, logger) {
    super();
    this.#daq = daq;
    this.#config = config;
    this.#metrics = metrics;
    this.#logger = logger.child({ component: 'ws' });
  }

  /**
   * Attach to an existing HTTP server (from Fastify).
   * @param {HttpServer} server
   */
  attach(server) {
    this.#wss = new WebSocketServer({ server, path: '/ws' });

    this.#wss.on('connection', (ws) => {
      this.#handleConnection(ws);
    });

    this.#logger.info('WebSocket server attached');

    this.#daq.on('subscription:data', (/** @type {string} */ subId, /** @type {any} */ data) => {
      this.#broadcastToSubscribers(subId, data);
    });
  }

  stop() {
    for (const client of this.#clients.values()) {
      client.ws.close(1001, 'Server shutdown');
    }
    this.#clients.clear();

    if (this.#wss) {
      this.#wss.close();
      this.#wss = null;
    }
  }

  /** @param {WebSocket} ws */
  #handleConnection(ws) {
    const clientId = `ws-${++this.#clientCounter}`;
    /** @type {WsClient} */
    const client = {
      ws,
      id: clientId,
      subscriptionIds: [],
      droppedFrames: 0,
      droppedSince: Date.now(),
    };
    this.#clients.set(clientId, client);
    this.#metrics.wsClientsActive.set(this.#clients.size);
    this.#logger.info({ clientId }, 'WebSocket client connected');

    ws.on('message', (/** @type {Buffer} */ raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.#handleMessage(client, msg);
      } catch {
        ws.send(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });

    ws.on('close', () => {
      for (const subId of client.subscriptionIds) {
        this.#daq.unsubscribe(subId);
      }
      this.#clients.delete(clientId);
      this.#metrics.wsClientsActive.set(this.#clients.size);
      this.#logger.info({ clientId }, 'WebSocket client disconnected');
    });

    ws.on('error', (err) => {
      this.#logger.error({ err, clientId }, 'WebSocket error');
    });
  }

  /**
   * @param {WsClient} client
   * @param {any} msg
   */
  #handleMessage(client, msg) {
    switch (msg.type) {
      case 'subscribe': {
        if (!msg.targetId || !msg.tags || !msg.intervalMs) {
          client.ws.send(JSON.stringify({ error: 'targetId, tags, and intervalMs required' }));
          return;
        }

        const tagDefs = msg.tags.map((/** @type {any} */ t) => ({
          name: t.name,
          area: t.area,
          start: t.start ?? t.offset ?? 0,
          dbNum: t.dbNum ?? 0,
          amount: t.amount ?? 1,
          wordLen: t.wordLen ?? 0x02,
          target: msg.targetId,
          scanIntervalMs: msg.intervalMs,
        }));

        const subId = this.#daq.subscribe({
          targetId: msg.targetId,
          tags: tagDefs,
          intervalMs: msg.intervalMs,
          clientId: client.id,
        });

        client.subscriptionIds.push(subId);
        client.ws.send(JSON.stringify({
          type: 'subscribed',
          subscriptionId: subId,
          tags: msg.tags.length,
        }));
        break;
      }

      case 'unsubscribe': {
        if (msg.subscriptionId) {
          this.#daq.unsubscribe(msg.subscriptionId);
          client.subscriptionIds = client.subscriptionIds.filter((id) => id !== msg.subscriptionId);
          client.ws.send(JSON.stringify({ type: 'unsubscribed', subscriptionId: msg.subscriptionId }));
        }
        break;
      }

      default:
        client.ws.send(JSON.stringify({ error: `Unknown message type: ${msg.type}` }));
    }
  }

  /**
   * @param {string} subId
   * @param {any} data
   */
  #broadcastToSubscribers(subId, data) {
    const payload = JSON.stringify({
      type: 'data',
      subscriptionId: subId,
      ...data,
      timestamp: Date.now(),
    });

    for (const client of this.#clients.values()) {
      if (!client.subscriptionIds.includes(subId)) continue;
      if (client.ws.readyState !== WebSocket.OPEN) continue;

      // Slow consumer protection
      if (client.ws.bufferedAmount > (this.#config.slowClient?.maxSendBufferBytes ?? 65536)) {
        client.droppedFrames++;
        this.#metrics.wsDroppedFrames.inc({ client: client.id });

        const maxDropped = this.#config.slowClient?.maxDroppedFrames ?? 100;
        const dropWindow = this.#config.slowClient?.dropWindowMs ?? 10000;

        if (client.droppedFrames >= maxDropped) {
          const elapsed = Date.now() - client.droppedSince;
          if (elapsed < dropWindow) {
            this.#logger.warn({ clientId: client.id }, 'Slow consumer — disconnecting');
            this.#metrics.wsSlowConsumerDisconnects.inc();
            client.ws.close(4000, 'Slow consumer');
            continue;
          }
          client.droppedFrames = 0;
          client.droppedSince = Date.now();
        }
        continue;
      }

      client.ws.send(payload);
    }
  }
}
