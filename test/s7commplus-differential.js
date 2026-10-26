// @ts-check
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, X509Certificate } from 'node:crypto';
import { fixture, REFERENCE_CREATE_OBJECT, normalizedReferenceCreate, encodeTestUInt64 } from './s7commplus-fixture.js';
import { S7CommPlusClient } from '../src/client/s7commplus-client.js';

const python = process.env.S7PROXY_REFERENCE_PYTHON;
if (!python) throw new Error('Set S7PROXY_REFERENCE_PYTHON to an isolated interpreter containing pinned s7commplus 245350ea0ca6327234e5032e781a99782334bc8f');
const execute = promisify(execFile);
const referenceCode = `
import json, logging, sys
from s7commplus.connection import S7CommPlusConnection
from s7commplus.vlq import decode_uint64_vlq
logging.disable(logging.CRITICAL)
value, consumed = decode_uint64_vlq(bytes.fromhex('${encodeTestUInt64(0x8000000000008001n).toString('hex')}'), 0)
assert value == 0x8000000000008001 and consumed == 9
connection = S7CommPlusConnection('127.0.0.1', int(sys.argv[1]))
try:
    tls_options = {'use_tls': True, 'tls_ca': sys.argv[2], 'tls_cert_fingerprint': sys.argv[3]} if len(sys.argv) > 2 else {'use_tls': False}
    connection.connect(timeout=2, legacy_session_key_refresh_interval=None, **tls_options)
    print(json.dumps({'established': connection._session_setup_ok, 'version': connection._protocol_version, 'sessionId': connection._session_id, 'protection': connection._protection_level, 'returnValue': hex(value), 'returnValueBytes': consumed}))
except Exception as error:
    print(json.dumps({'established': False, 'error': type(error).__name__, 'message': str(error), 'returnValue': hex(value), 'returnValueBytes': consumed}))
finally:
    connection._iso_conn.disconnect()
`;

const directory = await mkdtemp(join(tmpdir(), 's7plus-differential-'));
try {
assert.equal(createHash('sha256').update(Buffer.from(REFERENCE_CREATE_OBJECT.hex, 'hex')).digest('hex'), REFERENCE_CREATE_OBJECT.sha256);
await execute('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')]);
const credentials = { key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')) };
const certificateSha256 = new X509Certificate(credentials.cert).fingerprint256.replaceAll(':', '').toLowerCase();
for (const scenario of ['success', 'createRejected', 'compositeRejected', 'tlsSuccess', 'tlsWrongPin']) {
  const secure = scenario.startsWith('tls');
  const expectedSuccess = scenario === 'success' || scenario === 'tlsSuccess';
  const pin = scenario === 'tlsWrongPin' ? '00'.repeat(32) : certificateSha256;
  /** @type {import('./s7commplus-fixture.js').FixtureOptions} */
  const options = scenario === 'createRejected' ? { reject: 'createSession' } : { compositeReject: scenario === 'compositeRejected' };
  if (secure) options.tls = credentials;
  const own = await fixture(options);
  const client = new S7CommPlusClient({ host: '127.0.0.1', port: own.port, securityMode: secure ? 'tls' : 'legacy',
    tls: secure ? { ca: credentials.cert, servername: 'localhost', certificateSha256: pin } : undefined });
  /** @type {any} */
  let ownResult;
  try { await client.connect(); ownResult = { established: client.report.sessionEstablished, version: client.report.protocolVersion, protection: client.report.effectiveProtectionLevel }; }
  catch (error) { ownResult = { established: false, code: /** @type {any} */ (error).code }; }
  finally { await client.disconnect(); await own.close(); }
  const independent = await fixture({ ...options, reference: true });
  /** @type {any} */
  let referenceResult;
  try {
    const result = await execute(/** @type {string} */ (python), ['-I', '-c', referenceCode, String(independent.port), ...(secure ? [join(directory, 'cert.pem'), pin] : [])], { timeout: 10000, windowsHide: true });
    referenceResult = JSON.parse(result.stdout.trim());
  } finally { await independent.close(); }
  assert.deepEqual(own.errors, []);
  assert.deepEqual(independent.errors, []);
  assert.equal(referenceResult.established, expectedSuccess);
  assert.equal(ownResult.established, referenceResult.established);
  assert.equal(own.cotpRequests.length, 1);
  assert.equal(independent.cotpRequests.length, 1);
  assert.deepEqual(own.requests[0].frame, independent.requests[0].frame, 'InitSSL bytes');
  if (scenario === 'tlsWrongPin') {
    assert.equal(own.requests.length, 1, 'No own CreateObject after pin rejection');
    assert.equal(independent.requests.length, 1, 'No reference CreateObject after pin rejection');
    assert.equal(ownResult.code, 'CERTIFICATE_PIN_MISMATCH');
    assert.equal(referenceResult.error, 'S7CertificateError');
  } else assert.deepEqual(own.requests[1].frame, normalizedReferenceCreate(independent.requests[1].frame), 'Every CreateObject byte, excluding only four declared identity strings and their lengths');
  if (expectedSuccess) {
    assert.deepEqual(own.requests[2].frame, independent.requests[2].frame, 'Session setup bytes including version echo');
    assert.equal(referenceResult.protection, ownResult.protection);
    assert.equal(referenceResult.version, ownResult.version);
  }
  console.log(JSON.stringify({ scenario, own: ownResult, reference: referenceResult, ownRequests: own.requests.length, referenceRequests: independent.requests.length,
    referenceCommit: '245350ea0ca6327234e5032e781a99782334bc8f',
    cotpRequestBytesEqual: own.cotpRequests[0].equals(independent.cotpRequests[0]),
    ownCotpRequestHex: own.cotpRequests[0].toString('hex'), referenceCotpRequestHex: independent.cotpRequests[0].toString('hex'),
    initBytesEqual: true, createBytesEqualExceptDeclaredIdentity: scenario !== 'tlsWrongPin', setupBytesEqual: expectedSuccess ? true : null,
    referenceCreateHex: independent.requests[1]?.frame.toString('hex') ?? null,
    referenceCreateSha256: independent.requests[1] ? createHash('sha256').update(independent.requests[1].frame).digest('hex') : null }));
}
const serverCode = `
import json, logging, sys
from s7commplus.server import S7CommPlusServer
from s7commplus.protocol import ProtocolVersion
logging.disable(logging.CRITICAL)
server = S7CommPlusServer(protocol_version=ProtocolVersion.V2)
server.start(host='127.0.0.1', port=0, use_tls=True, tls_cert=sys.argv[1], tls_key=sys.argv[2])
print(json.dumps({'port': server.port}), flush=True)
try:
    sys.stdin.readline()
finally:
    server.stop()
`;
const peer = spawn(/** @type {string} */ (python), ['-I', '-u', '-c', serverCode, join(directory, 'cert.pem'), join(directory, 'key.pem')]);
let peerError = '';
peer.stderr.on('data', chunk => { peerError += String(chunk); });
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Reference TLS server did not start: ${peerError}`)), 5000);
    peer.once('error', error => { clearTimeout(timer); reject(error); });
    peer.once('exit', code => { clearTimeout(timer); reject(new Error(`Reference TLS server exited ${code}: ${peerError}`)); });
    peer.stdout.once('data', chunk => {
      clearTimeout(timer);
      try { resolve(JSON.parse(String(chunk).trim()).port); } catch (error) { reject(error); }
    });
  });
  const client = new S7CommPlusClient({ host: '127.0.0.1', port: Number(port), securityMode: 'tls',
    tls: { ca: credentials.cert, servername: 'localhost', certificateSha256 } });
  try {
    await assert.rejects(client.connect(), { code: 'SESSION_CREATE_REJECTED' });
    assert.equal(client.report.sessionEstablished, false);
    assert.equal(client.report.securityMode, 'TLS_VERIFIED');
    assert.equal(client.report.peerCertificateSha256, certificateSha256);
    assert.deepEqual(client.report.transcript.filter(frame => frame.direction === 'out').map(frame => frame.kind), ['initSSL', 'createSession']);
    console.log(JSON.stringify({ scenario: 'independentTlsServer', tlsVerified: true, sessionEstablished: false, code: 'SESSION_CREATE_REJECTED',
      limitation: 'Reference emulator emits a class-0 root and duplicate attribute 306; owned-session validation deliberately retained' }));
  } finally { await client.disconnect(); }
} finally {
  peer.stdin.end('\n');
  if (peer.exitCode === null && peer.signalCode === null) {
    await new Promise(resolve => {
      const timer = setTimeout(() => peer.kill(), 2000);
      peer.once('exit', () => { clearTimeout(timer); resolve(undefined); });
    });
  }
}
} finally { await rm(directory, { recursive: true, force: true }); }