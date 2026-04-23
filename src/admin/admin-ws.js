// @ts-check
// Admin-dedicated WebSocket server for real-time UI updates and live data editing

import { WebSocketServer, WebSocket } from 'ws';

/** @import { StructManager } from '../protocol/struct-manager.js' */
/** @import { AdminAuth } from './auth.js' */
/** @import { Logger } from '../logging/logger.js' */

export class AdminWsServer {
  /** @type {WebSocketServer | null} */
  #wss = null;
  /** @type {import('node:http').Server | null} */
  #server = null;
  /** @type {((req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => void) | null} */
  #upgradeHandler = null;
  /** @type {Map<string, WebSocket>} */
  #clients = new Map();
  /** @type {StructManager} */
  #structs;
  /** @type {AdminAuth} */
  #auth;
  /** @type {() => any} */
  #getState;
  /** @type {Logger} */
  #logger;
  #counter = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  #stateTimer = null;

  /**
   * @param {{
   *   structs: StructManager,
   *   auth: AdminAuth,
   *   getState: () => any,
   *   logger: Logger,
   * }} opts
   */
  constructor({ structs, auth, getState, logger }) {
    this.#structs = structs;
    this.#auth = auth;
    this.#getState = getState;
    this.#logger = logger.child({ component: 'admin-ws' });
  }

  /**
   * Attach to an HTTP server on /admin/ws path.
   * @param {import('node:http').Server} server
   */
  attach(server) {
    this.#server = server;
    this.#wss = new WebSocketServer({
      noServer: true,
    });

    // Handle upgrade requests for /admin/ws
    this.#upgradeHandler = (req, socket, head) => {
      const url = new URL(req.url ?? '', 'http://localhost');
      if (url.pathname !== '/admin/ws') return;

      socket.on('error', (err) => {
        this.#logger.debug({ err }, 'Admin WS upgrade socket error');
      });

      const token = url.searchParams.get('token');
      if (!this.#auth.validate(token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      this.#wss?.handleUpgrade(req, socket, head, (ws) => {
        this.#wss?.emit('connection', ws, req);
      });
    };
    server.on('upgrade', this.#upgradeHandler);

    this.#wss.on('connection', (ws) => {
      this.#handleConnection(ws);
    });

    // Forward decoded struct data to admin clients
    this.#structs.on('struct:data', (/** @type {any} */ data) => {
      this.#broadcast({
        type: 'struct-data',
        struct: data.structName,
        values: data.values,
        targetId: data.targetId,
        timestamp: data.timestamp,
      });
    });

    // Broadcast state on struct registration changes
    this.#structs.on('registered', () => this.broadcastState());
    this.#structs.on('unregistered', () => this.broadcastState());

    this.#logger.info('Admin WebSocket server attached at /admin/ws');
  }

  /** @param {WebSocket} ws */
  #handleConnection(ws) {
    const id = `admin-${++this.#counter}`;
    this.#clients.set(id, ws);
    this.#logger.info({ id }, 'Admin WS client connected');

    // Send initial state
    try {
      const st = this.#getState();
      ws.send(JSON.stringify({ type: 'state', ...st }));
    } catch (err) {
      this.#logger.error({ err }, 'Failed to send initial state');
    }

    ws.on('message', async (/** @type {Buffer} */ raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        await this.#handleMessage(ws, msg);
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', error: /** @type {Error} */ (err).message }));
      }
    });

    ws.on('close', () => {
      this.#clients.delete(id);
      this.#logger.info({ id }, 'Admin WS client disconnected');
    });

    ws.on('error', (err) => {
      this.#logger.error({ err, id }, 'Admin WS error');
    });
  }

  /**
   * @param {WebSocket} ws
   * @param {any} msg
   */
  async #handleMessage(ws, msg) {
    switch (msg.type) {
      case 'get-state': {
        try {
          const st = this.#getState();
          ws.send(JSON.stringify({ type: 'state', ...st }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', error: /** @type {Error} */ (err).message }));
        }
        break;
      }

      case 'write-struct': {
        const { name, values } = msg;
        if (!name || !values) {
          ws.send(JSON.stringify({ type: 'error', error: 'name and values required' }));
          return;
        }
        try {
          await this.#structs.write(name, values);
          ws.send(JSON.stringify({ type: 'write-ok', struct: name, timestamp: Date.now() }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', error: /** @type {Error} */ (err).message }));
        }
        break;
      }

      case 'read-struct': {
        const { name: rName, keys: rKeys } = msg;
        if (!rName) {
          ws.send(JSON.stringify({ type: 'error', error: 'name required' }));
          return;
        }
        try {
          const values = await this.#structs.read(rName, rKeys);
          ws.send(JSON.stringify({
            type: 'struct-data',
            struct: rName,
            values,
            timestamp: Date.now(),
          }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', error: /** @type {Error} */ (err).message }));
        }
        break;
      }

      default:
        ws.send(JSON.stringify({ type: 'error', error: `Unknown type: ${msg.type}` }));
    }
  }

  /** @param {any} msg */
  #broadcast(msg) {
    const payload = JSON.stringify(msg);
    for (const ws of this.#clients.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  /** Debounced full-state broadcast to all admin clients. */
  broadcastState() {
    if (this.#stateTimer) return;
    this.#stateTimer = setTimeout(() => {
      this.#stateTimer = null;
      try {
        const st = this.#getState();
        this.#broadcast({ type: 'state', ...st });
      } catch (err) {
        this.#logger.error({ err }, 'Failed to broadcast state');
      }
    }, 100);
  }

  stop() {
    if (this.#stateTimer) {
      clearTimeout(this.#stateTimer);
      this.#stateTimer = null;
    }
    for (const ws of this.#clients.values()) {
      ws.close(1001, 'Server shutdown');
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
}
