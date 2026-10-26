// @ts-check
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture } from './s7commplus-fixture.js';
import { S7CommPlusClient } from '../src/client/s7commplus-client.js';
import { Cursor, decodeObjects } from '../src/protocol/s7commplus/codec.js';

const python = process.env.S7PROXY_REFERENCE_PYTHON;
if (!python) throw new Error('Set S7PROXY_REFERENCE_PYTHON to an isolated interpreter containing pinned s7commplus 245350ea0ca6327234e5032e781a99782334bc8f');
const execute = promisify(execFile);
const referenceCode = `
import json, logging, sys
from s7commplus.connection import S7CommPlusConnection
from s7commplus.vlq import decode_uint64_vlq
logging.disable(logging.CRITICAL)
value, consumed = decode_uint64_vlq(bytes.fromhex('d180bae08087f3fdf8'), 0)
assert value == 0xa201d60001f9fdf8 and consumed == 9
connection = S7CommPlusConnection('127.0.0.1', int(sys.argv[1]))
try:
    connection.connect(timeout=2, legacy_session_key_refresh_interval=None)
    print(json.dumps({'established': connection._session_setup_ok, 'version': connection._protocol_version, 'sessionId': connection._session_id, 'protection': connection._protection_level, 'returnValue': hex(value), 'returnValueBytes': consumed}))
except Exception as error:
    print(json.dumps({'established': False, 'error': type(error).__name__, 'message': str(error), 'returnValue': hex(value), 'returnValueBytes': consumed}))
finally:
    connection._iso_conn.disconnect()
`;

/** @param {Buffer} frame */
function normalizedCreate(frame) {
  return decodeObjects(new Cursor(frame.subarray(29, -4))).map(object => ({ ...object,
    attributes: object.attributes.map(attribute => ({ id: attribute.id, datatype: attribute.value.datatype,
      value: typeof attribute.value.value === 'string' ? attribute.value.value.replaceAll('s7commplus', 'S7Proxy') : attribute.value.value })),
  }));
}

for (const scenario of ['success', 'createRejected', 'capturedRejected']) {
  /** @type {import('./s7commplus-fixture.js').FixtureOptions} */
  const options = scenario === 'createRejected' ? { reject: 'createSession' } : { capturedReject: scenario === 'capturedRejected' };
  const own = await fixture(options);
  const client = new S7CommPlusClient({ host: '127.0.0.1', port: own.port });
  /** @type {any} */
  let ownResult;
  try { await client.connect(); ownResult = { established: client.report.sessionEstablished, version: client.report.protocolVersion, protection: client.report.effectiveProtectionLevel }; }
  catch (error) { ownResult = { established: false, code: /** @type {any} */ (error).code }; }
  finally { await client.disconnect(); await own.close(); }
  const independent = await fixture({ ...options, reference: true });
  /** @type {any} */
  let referenceResult;
  try {
    const result = await execute(/** @type {string} */ (python), ['-I', '-c', referenceCode, String(independent.port)], { timeout: 10000, windowsHide: true });
    referenceResult = JSON.parse(result.stdout.trim());
  } finally { await independent.close(); }
  assert.deepEqual(own.errors, []);
  assert.deepEqual(independent.errors, []);
  assert.equal(referenceResult.established, scenario === 'success');
  assert.equal(ownResult.established, referenceResult.established);
  assert.deepEqual(own.requests[0].frame, independent.requests[0].frame, 'InitSSL bytes');
  assert.deepEqual(normalizedCreate(own.requests[1].frame), normalizedCreate(independent.requests[1].frame), 'CreateObject fields, excluding only client-name strings');
  if (scenario === 'success') {
    assert.deepEqual(own.requests[2].frame, independent.requests[2].frame, 'Session setup bytes including version echo');
    assert.equal(referenceResult.protection, ownResult.protection);
    assert.equal(referenceResult.version, ownResult.version);
  }
  console.log(JSON.stringify({ scenario, own: ownResult, reference: referenceResult, ownRequests: own.requests.length, referenceRequests: independent.requests.length,
    initBytesEqual: true, createFieldsEqual: true, setupBytesEqual: scenario === 'success' ? true : null }));
}