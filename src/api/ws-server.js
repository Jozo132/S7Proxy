// @ts-check
// WebSocket server for real-time DAQ streaming

import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';

/** @import { Server as HttpServer } from 'node:http' */
/** @import { DaqEngine } from '../daq/daq-engine.js' */
/** @import { DaqConfig } from '../protocol/types.js' */
/** @import { Metrics } from '../metrics/metrics.js' */
/** @import { StructManager } from '../protocol/struct-manager.js' */
/** @import { Logger } from '../logging/logger.js' */

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
  /** @type {HttpServer | null} */
  #server = null;
  /** @type {((req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => void) | null} */
  #upgradeHandler = null;
  /** @type {Map<string, WsClient>} */
  #clients = new Map();
  /** @type {DaqEngine} */
  #daq;
  /** @type {DaqConfig} */
  #config;
  /** @type {Metrics} */
  #metrics;
  /** @type {Logger} */
  #logger;
  /** @type {StructManager | null} */
  #structs;
  #clientCounter = 0;

  /**
   * @param {DaqEngine} daq
   * @param {DaqConfig} config
   * @param {Metrics} metrics
   * @param {Logger} logger
   * @param {StructManager} [structs]
   */
  constructor(daq, config, metrics, logger, structs) {
    super();
    this.#daq = daq;
    this.#config = config;
    this.#metrics = metrics;
    this.#logger = logger.child({ component: 'ws' });
    this.#structs = structs ?? null;
  }

  /**
  * Attach to an existing HTTP server.
   * @param {HttpServer} server
   */
  attach(server) {
    this.#server = server;
    this.#wss = new WebSocketServer({ noServer: true });

    this.#upgradeHandler = (req, socket, head) => {
      const url = new URL(req.url ?? '', 'http://localhost');
      if (url.pathname !== '/ws') return;

      socket.on('error', (err) => {
        this.#logger.debug({ err }, 'WebSocket upgrade socket error');
      });

      this.#wss?.handleUpgrade(req, socket, head, (ws) => {
        this.#wss?.emit('connection', ws, req);
      });
    };
    server.on('upgrade', this.#upgradeHandler);

    this.#wss.on('connection', (ws) => {
      this.#handleConnection(ws);
    });

    this.#logger.info('WebSocket server attached');

    this.#daq.on('subscription:data', (/** @type {string} */ subId, /** @type {any} */ data) => {
      this.#broadcastToSubscribers(subId, data);
    });

    // Broadcast decoded struct data to WS clients
    if (this.#structs) {
      this.#structs.on('struct:data', (/** @type {any} */ data) => {
        this.#broadcastStructData(data);
      });
    }
  }

  stop() {
    for (const client of this.#clients.values()) {
      client.ws.close(1001, 'Server shutdown');
    }
    this.#clients.clear();

    if (this.#server && this.#upgradeHandler) {
      this.#server.removeListener('upgrade', this.#upgradeHandler);
      this.#upgradeHandler = null;
      this.#server = null;
    }

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

      case 'register-struct': {
        if (!this.#structs) {
          client.ws.send(JSON.stringify({ error: 'Structs not enabled' }));
          return;
        }
        const { name, db, offset, items } = msg;
        if (!name || db === undefined || !items) {
          client.ws.send(JSON.stringify({ error: 'name, db, and items are required' }));
          return;
        }
        if (this.#structs.has(name)) {
          client.ws.send(JSON.stringify({ error: `Struct "${name}" already registered` }));
          return;
        }
        const struct = this.#structs.register({ name, db, offset: offset ?? 0, items });
        client.ws.send(JSON.stringify({
          type: 'struct-registered',
          name: struct.name, db: struct.db, offset: struct.offset, size: struct.size,
          fields: struct.items.map((i) => i.name),
        }));
        break;
      }

      case 'subscribe-struct': {
        if (!this.#structs) {
          client.ws.send(JSON.stringify({ error: 'Structs not enabled' }));
          return;
        }
        const { name: sName, targetId: sTgt, intervalMs: sInt } = msg;
        if (!sName || !sTgt || !sInt) {
          client.ws.send(JSON.stringify({ error: 'name, targetId, and intervalMs required' }));
          return;
        }
        try {
          const subId = this.#structs.subscribe(sName, sTgt, sInt);
          client.subscriptionIds.push(subId);
          client.ws.send(JSON.stringify({
            type: 'struct-subscribed',
            subscriptionId: subId,
            struct: sName,
          }));
        } catch (err) {
          client.ws.send(JSON.stringify({ error: /** @type {Error} */ (err).message }));
        }
        break;
      }

      case 'read-struct': {
        if (!this.#structs) {
          client.ws.send(JSON.stringify({ error: 'Structs not enabled' }));
          return;
        }
        const { name: rName, keys: rKeys } = msg;
        if (!rName) {
          client.ws.send(JSON.stringify({ error: 'name required' }));
          return;
        }
        this.#structs.read(rName, rKeys).then((values) => {
          client.ws.send(JSON.stringify({ type: 'struct-data', struct: rName, values, timestamp: Date.now() }));
        }).catch((err) => {
          client.ws.send(JSON.stringify({ error: /** @type {Error} */ (err).message }));
        });
        break;
      }

      case 'write-struct': {
        if (!this.#structs) {
          client.ws.send(JSON.stringify({ error: 'Structs not enabled' }));
          return;
        }
        const { name: wName, values: wValues } = msg;
        if (!wName || !wValues) {
          client.ws.send(JSON.stringify({ error: 'name and values required' }));
          return;
        }
        this.#structs.write(wName, wValues).then(() => {
          client.ws.send(JSON.stringify({ type: 'struct-written', struct: wName, timestamp: Date.now() }));
        }).catch((err) => {
          client.ws.send(JSON.stringify({ error: /** @type {Error} */ (err).message }));
        });
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
            this.#logger.warn({ clientId: client.id }, 'Slow consumer - disconnecting');
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

  /**
   * Broadcast decoded struct data to clients subscribed to that struct's DAQ subscription.
   * @param {any} data
   */
  #broadcastStructData(data) {
    const payload = JSON.stringify({
      type: 'struct-data',
      struct: data.structName,
      subscriptionId: data.subscriptionId,
      targetId: data.targetId,
      values: data.values,
      timestamp: data.timestamp,
    });

    for (const client of this.#clients.values()) {
      if (!client.subscriptionIds.includes(data.subscriptionId)) continue;
      if (client.ws.readyState !== WebSocket.OPEN) continue;

      if (client.ws.bufferedAmount > (this.#config.slowClient?.maxSendBufferBytes ?? 65536)) {
        client.droppedFrames++;
        continue;
      }

      client.ws.send(payload);
    }
  }
}
