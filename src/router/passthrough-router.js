// @ts-check
import { Socket } from 'node:net';
import { assertClassicTarget } from '../protocol/production-policy.js';

/** @import { S7ProxyConfig } from '../protocol/types.js' */
/** @import { Logger } from '../logging/logger.js' */
/** @import { Metrics } from '../metrics/metrics.js' */

export class PassthroughRouter {
  #config;
  #logger;
  #metrics;
  /** @type {Set<{client:Socket,upstream:Socket|null,targetId:string|null,close:()=>void}>} */
  #sessions = new Set();
  #closed = false;

  /** @param {S7ProxyConfig} config @param {Logger} logger @param {Metrics} metrics */
  constructor(config, logger, metrics) {
    this.#config = structuredClone(config);
    this.#logger = logger.child({ component: 'passthrough-router' });
    this.#metrics = metrics;
    if ((config.filters ?? []).some(filter => !['allow', 'deny'].includes(filter.action))) throw new Error('Invalid pass-through filter action');
    if ((config.filters ?? []).some(filter => filter.functionCode !== undefined || filter.area !== undefined || filter.dbNumber !== undefined)) {
      throw new Error('Pass-through supports connection-level filters only; encrypted/function/area/DB filtering is unavailable');
    }
    for (const target of config.targets) {
      if (!Number.isInteger(target.primary.port ?? 102) || (target.primary.port ?? 102) < 1 || (target.primary.port ?? 102) > 65535) throw new Error('Invalid pass-through target port');
      if (!Number.isSafeInteger(target.maxConnections) || target.maxConnections < 1 || target.maxConnections > 1024
        || !Number.isSafeInteger(target.requestTimeoutMs ?? 3000) || (target.requestTimeoutMs ?? 3000) < 1 || (target.requestTimeoutMs ?? 3000) > 60000) {
        throw new Error('Invalid pass-through connection count or connect timeout');
      }
    }
    if (new Set(config.targets.map(target => target.id)).size !== config.targets.length
      || (config.routing ?? []).some(rule => !config.targets.some(target => target.id === rule.targetId)
        || (rule.dstTsap !== undefined && (!Number.isInteger(rule.dstTsap) || rule.dstTsap < 0 || rule.dstTsap > 65535)))) {
      throw new Error('Invalid pass-through routing target or destination TSAP');
    }
  }

  /** @param {Socket} client */
  handleConnection(client) {
    if (this.#closed || this.#sessions.size >= 256) { client.destroy(); return; }
    client.setNoDelay(true);
    client.setKeepAlive(true, 1000);
    /** @type {Buffer} */
    let pending = Buffer.alloc(0);
    let closed = false;
    let timer = setTimeout(() => close(), 3000);
    const session = { client, upstream: /** @type {Socket|null} */ (null), targetId: /** @type {string|null} */ (null), close: () => close() };
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      client.removeListener('data', onHandshake);
      client.destroy();
      session.upstream?.destroy();
      this.#sessions.delete(session);
      this.#metrics.clientConnectionsActive.dec();
    };
    /** @param {Error} error */
    const failed = error => { this.#logger.warn({ error: error.message, targetId: session.targetId }, 'Pass-through closed'); close(); };
    /** @param {Buffer} bytes */
    const onHandshake = bytes => {
      try {
        if (pending.length + bytes.length > 131072) throw new Error('Pass-through handshake buffer exceeded');
        pending = Buffer.concat([pending, bytes]);
        if (pending.length < 4) return;
        const length = pending.readUInt16BE(2);
        if (pending[0] !== 3 || pending[1] !== 0 || length < 11 || length > 1024) throw new Error('Expected bounded TPKT/COTP connection request');
        if (pending.length < length) return;
        const request = pending.subarray(0, length);
        if (request[5] !== 0xE0 || request[10] !== 0 || length !== 5 + request[4]) throw new Error('Expected class-0 COTP connection request');
        /** @type {number|undefined} */
        let dstTsap;
        let tsapSeen = false;
        for (let offset = 11; offset < length;) {
          if (offset + 2 > length || offset + 2 + request[offset + 1] > length) throw new Error('Truncated COTP parameter');
          const code = request[offset];
          const size = request[offset + 1];
          if (code === 0xC2) {
            if (tsapSeen) throw new Error('Duplicate destination TSAP');
            tsapSeen = true;
            if (size === 2) dstTsap = request.readUInt16BE(offset + 2);
          }
          offset += size + 2;
        }
        const remote = client.remoteAddress ?? '';
        const route = (this.#config.routing ?? []).find(rule => (!rule.srcIp || rule.srcIp === remote)
          && (rule.dstTsap === undefined || rule.dstTsap === dstTsap));
        const target = route ? this.#config.targets.find(candidate => candidate.id === route.targetId) : this.#config.targets[0];
        if (!target) throw new Error('No pass-through route');
        const filters = (this.#config.filters ?? []).filter(filter => !filter.targetId || filter.targetId === target.id);
        const matches = (/** @type {typeof filters[number]} */ filter) => !filter.srcIp || filter.srcIp === remote;
        if (filters.some(filter => filter.action === 'deny' && matches(filter))
          || (filters.some(filter => filter.action === 'allow') && !filters.some(filter => filter.action === 'allow' && matches(filter)))) {
          throw new Error('Pass-through connection filtered');
        }
        assertClassicTarget(target.primary.ip);
        if ([...this.#sessions].filter(candidate => candidate.targetId === target.id).length >= target.maxConnections) throw new Error('Pass-through target connection budget exhausted');
        session.targetId = target.id;
        client.pause();
        client.removeListener('data', onHandshake);
        clearTimeout(timer);
        timer = setTimeout(() => close(), target.requestTimeoutMs ?? 3000);
        const upstream = new Socket();
        session.upstream = upstream;
        upstream.setNoDelay(true);
        upstream.setKeepAlive(true, 1000);
        upstream.on('error', failed);
        upstream.on('close', () => {
          if (!closed && upstream.readableEnded) client.end();
          else close();
        });
        upstream.connect(target.primary.port ?? 102, target.primary.ip, () => {
          if (closed) return;
          clearTimeout(timer);
          upstream.pipe(client);
          const ready = upstream.write(pending);
          pending = Buffer.alloc(0);
          const start = () => { if (!closed) client.pipe(upstream); };
          if (ready) start(); else upstream.once('drain', start);
          this.#logger.info({ targetId: target.id, remote }, 'Transparent stream connected');
        });
      } catch (error) { failed(error instanceof Error ? error : new Error(String(error))); }
    };
    this.#sessions.add(session);
    this.#metrics.clientConnectionsTotal.inc();
    this.#metrics.clientConnectionsActive.inc();
    client.on('error', failed);
    client.on('close', close);
    client.on('data', onHandshake);
  }

  close() {
    this.#closed = true;
    for (const session of this.#sessions) session.close();
  }
}