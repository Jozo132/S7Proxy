// @ts-check
// Minimal HTTP app used in place of framework dependencies.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';

const DEFAULT_CORS_HEADERS = 'Content-Type, Authorization';
const DEFAULT_CORS_METHODS = 'GET,POST,PUT,DELETE,OPTIONS';
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'application/javascript; charset=utf-8',
  '.json': JSON_CONTENT_TYPE,
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

/**
 * @typedef {{ origin?: string }} CorsOptions
 * @typedef {{ max?: number, windowMs?: number }} RateLimitOptions
 * @typedef {{ method: string, match: (pathname: string) => Record<string, string> | null, handler: RouteHandler }} RouteEntry
 * @typedef {(request: HttpRequest, reply: HttpReply) => unknown | Promise<unknown>} RouteHandler
 * @typedef {(request: HttpRequest, reply: HttpReply) => unknown | Promise<unknown>} OnRequestHook
 * @typedef {{ method: string, url: string, headers?: Record<string, string>, payload?: any }} InjectOptions
 *
 * @typedef {Object} HttpRequest
 * @property {string} method
 * @property {string} url
 * @property {Record<string, string | string[] | undefined>} headers
 * @property {Record<string, string>} params
 * @property {Record<string, string>} query
 * @property {any} body
 * @property {import('node:http').IncomingMessage} raw
 *
 * @typedef {Object} InjectResponse
 * @property {number} statusCode
 * @property {string} body
 * @property {Record<string, string>} headers
 * @property {() => any} json
 */

class HttpReply {
  /** @type {import('node:http').ServerResponse} */
  #response;
  /** @type {boolean} */
  sent = false;

  /**
   * @param {import('node:http').ServerResponse} response
   */
  constructor(response) {
    this.#response = response;
  }

  /**
   * @param {number} statusCode
   * @returns {HttpReply}
   */
  code(statusCode) {
    this.#response.statusCode = statusCode;
    return this;
  }

  /**
   * @param {string} name
   * @param {string} value
   * @returns {HttpReply}
   */
  header(name, value) {
    this.#response.setHeader(name, value);
    return this;
  }

  /**
   * @param {string} location
   * @param {number} [statusCode]
   * @returns {HttpReply}
   */
  redirect(location, statusCode = 302) {
    this.code(statusCode);
    this.header('Location', location);
    this.send('');
    return this;
  }

  /**
   * @param {unknown} [payload]
   * @returns {HttpReply}
   */
  send(payload) {
    if (this.sent) return this;
    this.sent = true;

    if (payload === undefined) {
      this.#response.end();
      return this;
    }

    if (Buffer.isBuffer(payload)) {
      if (!this.#response.hasHeader('Content-Type')) {
        this.#response.setHeader('Content-Type', 'application/octet-stream');
      }
      this.#response.end(payload);
      return this;
    }

    if (typeof payload === 'string') {
      if (!this.#response.hasHeader('Content-Type')) {
        this.#response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      }
      this.#response.end(payload);
      return this;
    }

    if (!this.#response.hasHeader('Content-Type')) {
      this.#response.setHeader('Content-Type', JSON_CONTENT_TYPE);
    }
    this.#response.end(JSON.stringify(payload));
    return this;
  }
}

/**
 * @param {string} pattern
 * @returns {(pathname: string) => Record<string, string> | null}
 */
function compilePath(pattern) {
  const normalizedPattern = normalizePath(pattern);
  const patternHasTrailingSlash = normalizedPattern.length > 1 && normalizedPattern.endsWith('/');
  const parts = stripTrailingSlash(normalizedPattern).split('/').filter(Boolean);

  return (pathname) => {
    const normalizedPathname = normalizePath(pathname);
    const pathnameHasTrailingSlash = normalizedPathname.length > 1 && normalizedPathname.endsWith('/');

    if (patternHasTrailingSlash !== pathnameHasTrailingSlash) return null;

    const pathParts = stripTrailingSlash(normalizedPathname).split('/').filter(Boolean);

    if (parts.length !== pathParts.length) return null;

    /** @type {Record<string, string>} */
    const params = {};
    for (let index = 0; index < parts.length; index += 1) {
      const patternPart = parts[index];
      const pathPart = pathParts[index];

      if (patternPart.startsWith(':')) {
        params[patternPart.slice(1)] = decodeURIComponent(pathPart);
        continue;
      }

      if (patternPart !== pathPart) return null;
    }

    return params;
  };
}

/**
 * @param {string} path
 * @returns {string}
 */
function stripTrailingSlash(path) {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * @param {string} path
 * @returns {string}
 */
function normalizePath(path) {
  if (!path) return '/';
  return path.startsWith('/') ? path : `/${path}`;
}

/**
 * @param {Record<string, string | string[] | undefined>} headers
 * @returns {boolean}
 */
function isJsonRequest(headers) {
  const contentType = headers['content-type'];
  if (Array.isArray(contentType)) {
    return contentType.some((value) => value.includes('application/json'));
  }
  return typeof contentType === 'string' && contentType.includes('application/json');
}

/**
 * @param {string} pathname
 * @param {string} prefix
 * @returns {string | null}
 */
function getStaticRelativePath(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return null;
  const rawRelative = pathname.slice(prefix.length);
  return rawRelative === '' ? 'index.html' : rawRelative;
}

export class HttpApp {
  /** @type {RouteEntry[]} */
  #routes = [];
  /** @type {OnRequestHook[]} */
  #onRequestHooks = [];
  /** @type {import('node:http').Server} */
  server;
  /** @type {CorsOptions} */
  #cors;
  /** @type {RateLimitOptions | null} */
  #rateLimit;
  /** @type {Map<string, { count: number, startedAt: number }>} */
  #rateLimitState = new Map();
  /** @type {Array<{ prefix: string, root: string }>} */
  #staticDirs = [];
  /** @type {string | null} */
  #injectBaseUrl = null;

  /**
   * @param {{ cors?: CorsOptions, rateLimit?: RateLimitOptions }} [options]
   */
  constructor(options = {}) {
    this.#cors = options.cors ?? {};
    this.#rateLimit = options.rateLimit ?? null;
    this.server = createServer((req, res) => {
      void this.#handle(req, res);
    });
  }

  /** @returns {Promise<void>} */
  async ready() {}

  /**
   * @param {'onRequest'} hookName
   * @param {OnRequestHook} hook
   */
  addHook(hookName, hook) {
    if (hookName !== 'onRequest') {
      throw new Error(`Unsupported hook: ${hookName}`);
    }
    this.#onRequestHooks.push(hook);
  }

  /** @param {string} path @param {RouteHandler} handler */
  get(path, handler) { this.#addRoute('GET', path, handler); }
  /** @param {string} path @param {RouteHandler} handler */
  post(path, handler) { this.#addRoute('POST', path, handler); }
  /** @param {string} path @param {RouteHandler} handler */
  put(path, handler) { this.#addRoute('PUT', path, handler); }
  /** @param {string} path @param {RouteHandler} handler */
  delete(path, handler) { this.#addRoute('DELETE', path, handler); }

  /**
   * @param {string} prefix
   * @param {string} root
   */
  serveStatic(prefix, root) {
    this.#staticDirs.push({ prefix, root: resolve(root) });
  }

  /**
   * @param {{ host?: string, port?: number }} options
   * @returns {Promise<string>}
   */
  async listen(options = {}) {
    const host = options.host ?? '0.0.0.0';
    const port = options.port ?? 0;

    await new Promise((resolvePromise, reject) => {
      const onError = (/** @type {Error} */ err) => {
        this.server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        this.server.off('error', onError);
        resolvePromise(undefined);
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(port, host);
    });

    const address = this.server.address();
    if (typeof address === 'object' && address) {
      return `http://${address.address}:${address.port}`;
    }
    return String(address ?? '');
  }

  /** @returns {Promise<void>} */
  async close() {
    this.#injectBaseUrl = null;
    if (!this.server.listening) return;
    await new Promise((resolvePromise, reject) => {
      this.server.close((err) => {
        if (err) reject(err);
        else resolvePromise(undefined);
      });
    });
  }

  /**
   * @param {InjectOptions} options
   * @returns {Promise<InjectResponse>}
   */
  async inject(options) {
    const baseUrl = await this.#ensureInjectBaseUrl();
    const headers = { ...(options.headers ?? {}) };
    /** @type {RequestInit} */
    const request = { method: options.method, headers };

    if (options.payload !== undefined) {
      if (Buffer.isBuffer(options.payload) || typeof options.payload === 'string') {
        request.body = Buffer.isBuffer(options.payload)
          ? new Uint8Array(options.payload)
          : options.payload;
      } else {
        headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
        request.body = JSON.stringify(options.payload);
      }
    }

    const response = await fetch(`${baseUrl}${options.url}`, request);
    const body = await response.text();
    const responseHeaders = Object.fromEntries(response.headers.entries());
    return {
      statusCode: response.status,
      body,
      headers: responseHeaders,
      json() {
        return body ? JSON.parse(body) : null;
      },
    };
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {RouteHandler} handler
   */
  #addRoute(method, path, handler) {
    this.#routes.push({ method, match: compilePath(path), handler });
  }

  /**
   * @returns {Promise<string>}
   */
  async #ensureInjectBaseUrl() {
    if (this.#injectBaseUrl) return this.#injectBaseUrl;
    if (!this.server.listening) {
      await this.listen({ host: '127.0.0.1', port: 0 });
    }
    const address = this.server.address();
    const port = typeof address === 'object' && address ? address.port : address;
    this.#injectBaseUrl = `http://127.0.0.1:${port}`;
    return this.#injectBaseUrl;
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async #handle(req, res) {
    const requestUrl = new URL(req.url ?? '/', 'http://localhost');
    const pathname = requestUrl.pathname;

    this.#applyCors(res);
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (this.#isRateLimited(req, res)) return;

    const body = await this.#readBody(req);
    const request = {
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: req.headers,
      params: {},
      query: Object.fromEntries(requestUrl.searchParams.entries()),
      body: isJsonRequest(req.headers) && body.length > 0 ? JSON.parse(body.toString('utf-8')) : body.length > 0 ? body.toString('utf-8') : undefined,
      raw: req,
    };
    const reply = new HttpReply(res);

    try {
      for (const hook of this.#onRequestHooks) {
        await hook(request, reply);
        if (reply.sent) return;
      }

      for (const route of this.#routes) {
        if (route.method !== request.method) continue;
        const params = route.match(pathname);
        if (!params) continue;
        request.params = params;
        const result = await route.handler(request, reply);
        if (!reply.sent && result !== undefined) {
          reply.send(result);
        } else if (!reply.sent) {
          reply.send();
        }
        return;
      }

      if (await this.#serveStatic(pathname, reply)) return;

      reply.code(404).send({ error: 'Not found' });
    } catch (err) {
      if (reply.sent) return;
      reply.code(500).send({ error: /** @type {Error} */ (err).message });
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @returns {Promise<Buffer>}
   */
  async #readBody(req) {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  /**
   * @param {import('node:http').ServerResponse} res
   */
  #applyCors(res) {
    const origin = this.#cors.origin ?? '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', DEFAULT_CORS_HEADERS);
    res.setHeader('Access-Control-Allow-Methods', DEFAULT_CORS_METHODS);
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @returns {boolean}
   */
  #isRateLimited(req, res) {
    if (!this.#rateLimit?.max || !this.#rateLimit?.windowMs) return false;

    const key = req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const existing = this.#rateLimitState.get(key);
    if (!existing || now - existing.startedAt >= this.#rateLimit.windowMs) {
      this.#rateLimitState.set(key, { count: 1, startedAt: now });
      return false;
    }

    existing.count += 1;
    if (existing.count <= this.#rateLimit.max) return false;

    res.statusCode = 429;
    res.setHeader('Content-Type', JSON_CONTENT_TYPE);
    res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
    return true;
  }

  /**
   * @param {string} pathname
   * @param {HttpReply} reply
   * @returns {Promise<boolean>}
   */
  async #serveStatic(pathname, reply) {
    for (const entry of this.#staticDirs) {
      const relativePath = getStaticRelativePath(pathname, entry.prefix);
      if (relativePath === null) continue;

      const safeTarget = resolve(entry.root, relativePath);
      if (safeTarget !== entry.root && !safeTarget.startsWith(`${entry.root}${sep}`)) {
        reply.code(403).send({ error: 'Forbidden' });
        return true;
      }

      try {
        const file = await readFile(safeTarget);
        reply.header('Content-Type', /** @type {Record<string, string>} */ (CONTENT_TYPES)[extname(safeTarget)] ?? 'application/octet-stream');
        reply.send(file);
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }
}

/**
 * @param {{ cors?: CorsOptions, rateLimit?: RateLimitOptions }} [options]
 * @returns {HttpApp}
 */
export function createHttpApp(options) {
  return new HttpApp(options);
}