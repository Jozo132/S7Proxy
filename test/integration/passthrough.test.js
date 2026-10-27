// @ts-check
import { createServer, connect } from 'node:net';
import { once } from 'node:events';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { PassthroughRouter } from '../../src/router/passthrough-router.js';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/logging/logger.js';
import { Metrics } from '../../src/metrics/metrics.js';
import { ProxyServer } from '../../src/proxy-server.js';
import { S7CommPlusClient } from '../../src/client/s7commplus-client.js';
import { fixture } from '../s7commplus-fixture.js';

const cr = Buffer.from('0300001611e00000000100c1020100c2020102c0010a', 'hex');

/** @param {number} targetPort @param {(config:import('../../src/protocol/types.js').S7ProxyConfig)=>void} [configure] */
async function startProxy(targetPort, configure = () => {}) {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Missing port reservation');
  await new Promise(resolve => reservation.close(resolve));
  const config = loadConfig('/nonexistent/passthrough.json');
  config.listen = { ip: '127.0.0.1', port: address.port, mode: 'passthrough' };
  config.webApi.enabled = false;
  config.logging.level = 'silent';
  config.targets = [{ id: 'loopback', primary: { ip: '127.0.0.1', port: targetPort, rack: 0, slot: 1 }, maxConnections: 2 }];
  configure(config);
  const proxy = new ProxyServer(config);
  await proxy.start();
  return { proxy, port: address.port };
}

/** @param {import('node:net').Socket} socket @param {number} length */
function receiveBytes(socket, length) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let received = 0;
    const timer = setTimeout(() => { cleanup(); reject(new Error('Fixture receive timeout')); }, 2000);
    const cleanup = () => { clearTimeout(timer); socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose); };
    const onError = (/** @type {Error} */ error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error('Fixture closed before receiving expected bytes')); };
    const onData = (/** @type {Buffer} */ bytes) => {
      chunks.push(bytes); received += bytes.length;
      if (received >= length) { cleanup(); resolve(Buffer.concat(chunks)); }
    };
    socket.on('data', onData); socket.on('error', onError); socket.on('close', onClose);
  });
}

/** @param {import('node:net').Socket} socket */
function closed(socket) {
  socket.on('error', () => {});
  return new Promise(resolve => socket.once('close', resolve));
}

describe('transparent S7CommPlus proxy (loopback only)', () => {
  let directory = '';
  /** @type {{key:Buffer,cert:Buffer}} */
  let credentials;
  let certificateSha256 = '';
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 's7proxy-pass-through-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-keyout', join(directory, 'key.pem'),
      '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
    credentials = { key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')) };
    certificateSha256 = new X509Certificate(credentials.cert).fingerprint256.replaceAll(':', '').toLowerCase();
  });
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

  it.each([false, true])('completes actual Plus discovery/read through ProxyServer with TLS=%s', async tls => {
    const target = await fixture(tls ? { tls: credentials } : {});
    const { proxy, port } = await startProxy(target.port);
    const client = new S7CommPlusClient({ host: '127.0.0.1', port,
      ...(tls ? { securityMode: /** @type {const} */ ('tls'), tls: { ca: credentials.cert, servername: 'localhost', certificateSha256 } } : {}) });
    try {
      expect(target.cotpRequests).toHaveLength(0);
      await client.connect();
      const sample = await client.readSymbolic({ accessArea: 0x8A0E0001, lids: [1] });
      expect(sample.value.value).toBe(42);
      expect(client.report.failure).toBeNull();
      if (tls) expect(client.report.securityMode).toBe('TLS_VERIFIED');
      expect(target.cotpRequests).toHaveLength(1);
      expect(target.cotpRequests[0].includes(Buffer.from('SIMATIC-ROOT-HMI'))).toBe(true);
      expect(target.errors).toEqual([]);
    } finally { await client.disconnect(); await proxy.stop(); await target.close(); }
  });

  it('does not terminate TLS or mask an upstream certificate pin mismatch', async () => {
    const target = await fixture({ tls: credentials });
    const { proxy, port } = await startProxy(target.port);
    const client = new S7CommPlusClient({ host: '127.0.0.1', port, securityMode: 'tls',
      tls: { ca: credentials.cert, servername: 'localhost', certificateSha256: '00'.repeat(32) } });
    try {
      await expect(client.connect()).rejects.toMatchObject({ code: 'CERTIFICATE_PIN_MISMATCH' });
      expect(target.requests.map(request => request.functionCode)).toEqual([0x05B3]);
    } finally { await client.disconnect(); await proxy.stop(); await target.close(); }
  });

  it('preserves independent client streams and large payloads with backpressure', async () => {
    const upstream = createServer(socket => { socket.on('error', () => {}); socket.pipe(socket); });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const { proxy, port } = await startProxy(address.port);
    const clients = [connect(port, '127.0.0.1'), connect(port, '127.0.0.1')];
    try {
      await Promise.all(clients.map(client => once(client, 'connect')));
      await Promise.all(clients.map(async (client, index) => {
        const payload = Buffer.concat([cr, Buffer.alloc(1048576, index + 1)]);
        const response = receiveBytes(client, payload.length);
        client.write(payload);
        expect(await response).toEqual(payload);
      }));
      clients[0].destroy();
      const response = receiveBytes(clients[1], 3); clients[1].write(Buffer.from([0x72, 0xFE, 0x33]));
      expect(await response).toEqual(Buffer.from([0x72, 0xFE, 0x33]));
      const ending = closed(clients[1]); await proxy.stop(); await ending;
    } finally { clients.forEach(client => client.destroy()); await proxy.stop(); await new Promise(resolve => upstream.close(resolve)); }
  });

  it('applies destination TSAP routing and deny filters before opening an upstream stream', async () => {
    const target = await fixture();
    const { proxy, port } = await startProxy(target.port, config => {
      config.targets.unshift({ ...config.targets[0], id: 'wrong', primary: { ip: '127.0.0.1', port: 1, rack: 0, slot: 1 } });
      config.routing = [{ dstTsap: 0x0102, targetId: 'loopback' }];
    });
    const client = connect(port, '127.0.0.1');
    try {
      await once(client, 'connect');
      const reply = receiveBytes(client, 14); client.write(cr); await reply;
      expect(target.cotpRequests).toHaveLength(1);
    } finally { client.destroy(); await proxy.stop(); await target.close(); }
    const deniedTarget = await fixture();
    const denied = await startProxy(deniedTarget.port, config => { config.filters = [{ action: 'deny', srcIp: '127.0.0.1' }]; });
    const blocked = connect(denied.port, '127.0.0.1');
    try {
      await once(blocked, 'connect'); const ended = closed(blocked); blocked.write(cr); await ended;
      expect(deniedTarget.cotpRequests).toHaveLength(0);
    } finally { blocked.destroy(); await denied.proxy.stop(); await deniedTarget.close(); }
  });

  it('enforces production raw-forwarding policy without an upstream attempt', async () => {
    vi.stubEnv('S7PROXY_PRODUCTION_HOST', '192.0.2.10');
    const { proxy, port } = await startProxy(1, config => { config.targets[0].primary.ip = '192.0.2.10'; });
    const client = connect(port, '127.0.0.1');
    try {
      await once(client, 'connect'); const ended = closed(client); client.write(cr); await ended;
    } finally { client.destroy(); await proxy.stop(); vi.unstubAllEnvs(); }
  });
  it('forwards server-initiated data and closes the owned stream when its target is removed', async () => {
    const upstream = createServer(socket => { socket.on('error', () => {}); socket.pipe(socket); });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const { proxy, port } = await startProxy(address.port, config => { config.routing = [{ dstTsap: 0x0102, targetId: 'loopback' }]; });
    const client = connect(port, '127.0.0.1');
    /** @type {import('node:net').Socket|undefined} */
    let serverSocket;
    try {
      await once(client, 'connect');
      const accepted = once(upstream, 'connection');
      const echo = receiveBytes(client, cr.length); client.write(cr);
      [serverSocket] = await accepted;
      expect(await echo).toEqual(cr);
      const bytes = Buffer.from('0300000b02f08072fe3300', 'hex');
      const pushed = receiveBytes(client, bytes.length); serverSocket?.write(bytes);
      expect(await pushed).toEqual(bytes);
      const clientClosed = closed(client);
      const upstreamClosed = serverSocket ? closed(serverSocket) : Promise.resolve();
      await proxy.removeTarget('loopback');
      await Promise.all([clientClosed, upstreamClosed]);
    } finally { client.destroy(); serverSocket?.destroy(); await proxy.stop(); await new Promise(resolve => upstream.close(resolve)); }
  });
  it('rejects excess target connections without disturbing the existing stream', async () => {
    const target = await fixture();
    const { proxy, port } = await startProxy(target.port, config => { config.targets[0].maxConnections = 1; });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port });
    const excess = connect(port, '127.0.0.1');
    try {
      await once(excess, 'connect');
      await client.connect();
      const rejected = closed(excess); excess.write(cr); await rejected;
      expect(target.cotpRequests).toHaveLength(1);
      expect((await client.readSymbolic({ accessArea: 0x8A0E0001, lids: [1] })).value.value).toBe(42);
    } finally { excess.destroy(); await client.disconnect(); await proxy.stop(); await target.close(); }
  });
  it('closes on an upstream connect error or malformed handshake without retry', async () => {
    const { proxy, port } = await startProxy(1);
    const client = connect(port, '127.0.0.1');
    try {
      await once(client, 'connect'); const ended = closed(client); client.write(cr); await ended;
      const malformed = connect(port, '127.0.0.1');
      await once(malformed, 'connect'); const rejected = closed(malformed); malformed.write(Buffer.from('00000004', 'hex')); await rejected;
    } finally { client.destroy(); await proxy.stop(); }
  });
  it('drains a final large response before normal upstream close', async () => {
    const payload = Buffer.alloc(4194304, 0x72);
    const upstream = createServer(socket => {
      socket.on('error', () => {});
      socket.once('data', () => socket.end(payload));
    });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const { proxy, port } = await startProxy(address.port);
    const client = connect(port, '127.0.0.1');
    try {
      await once(client, 'connect');
      client.pause(); client.write(cr);
      await new Promise(resolve => setImmediate(resolve));
      const received = receiveBytes(client, payload.length);
      const ending = closed(client);
      client.resume();
      expect(await received).toEqual(payload);
      await ending;
    } finally { client.destroy(); await proxy.stop(); await new Promise(resolve => upstream.close(resolve)); }
  });
  it('rejects unknown modes and uninspectable filters before opening a listener', async () => {
    const config = loadConfig('/nonexistent/passthrough.json');
    config.listen.mode = /** @type {'passthrough'} */ ('typo');
    await expect(new ProxyServer(config).start()).rejects.toThrow(/listen.mode/);
    config.listen.mode = 'passthrough';
    config.filters = [{ action: 'deny', dbNumber: 1 }];
    await expect(new ProxyServer(config).start()).rejects.toThrow(/connection-level/);
  });
  it('forwards original fragmented COTP and opaque Plus/TLS bytes bidirectionally', async () => {
    const upstream = createServer(socket => socket.pipe(socket));
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const config = loadConfig('/nonexistent/passthrough.json');
    config.targets = [{ id: 'loopback', primary: { ip: '127.0.0.1', port: address.port, rack: 0, slot: 1 }, maxConnections: 2 }];
    const router = new PassthroughRouter(config, createLogger({ level: 'silent' }), new Metrics());
    const listener = createServer(socket => router.handleConnection(socket));
    listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const proxyAddress = listener.address();
    if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('Missing proxy address');
    const client = connect(proxyAddress.port, '127.0.0.1');
    /** @type {Buffer[]} */
    const data = [];
    client.on('data', bytes => data.push(Buffer.from(bytes)));
    try {
      await once(client, 'connect');
      const received = once(client, 'data');
      client.write(cr.subarray(0, 3));
      client.write(cr.subarray(3));
      await received;
      expect(Buffer.concat(data)).toEqual(cr);
      data.length = 0;
      const opaque = Buffer.from('0300001202f0807202000731000005b3000016030300050102030405', 'hex');
      const echoed = once(client, 'data'); client.write(opaque); await echoed;
      expect(Buffer.concat(data)).toEqual(opaque);
    } finally {
      client.destroy(); router.close();
      await new Promise(resolve => listener.close(resolve));
      await new Promise(resolve => upstream.close(resolve));
    }
  });
});