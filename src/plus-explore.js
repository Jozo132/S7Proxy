// @ts-check
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { S7CommPlusClient } from './client/s7commplus-client.js';
import { getLabHost } from './protocol/production-policy.js';

let options;
try {
  options = parseArgs({ options: {
    live: { type: 'boolean' }, tls: { type: 'boolean' }, legacy: { type: 'boolean' },
    lab: { type: 'boolean' }, host: { type: 'string' }, port: { type: 'string' },
    'allow-any-certificate': { type: 'boolean' }, 'tls-min-version': { type: 'string' },
  } }).values;
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); }
if (!options?.live || Boolean(options.tls) === Boolean(options.legacy) || (options.lab && options.host) || ((options['allow-any-certificate'] || options['tls-min-version']) && !options.tls)) {
  console.error('Usage: node src/plus-explore.js --live (--tls | --legacy) [--host HOST | --lab] [--port PORT] [--allow-any-certificate] [--tls-min-version TLSv1.2|TLSv1.3]');
  console.error('One bounded identification session to the explicit host or locally configured target. No block uploads or recurring work.');
  process.exitCode = 2;
} else {
  const tlsMode = options.tls === true;
  const allowAnyCertificate = options['allow-any-certificate'] === true;
  const labMode = options.lab === true;
  const minVersion = options['tls-min-version'];
  if (minVersion !== undefined && minVersion !== 'TLSv1.2' && minVersion !== 'TLSv1.3') throw new Error('TLS minimum version must be TLSv1.2 or TLSv1.3');
  const labHost = labMode ? getLabHost() : undefined;
  if (labMode && !labHost) throw new Error('S7PROXY_LAB_HOST must identify the explicitly authorized lab PLC');
  if (tlsMode && !allowAnyCertificate && !process.env.S7PLUS_TLS_CA) throw new Error('S7PLUS_TLS_CA must name the authorized PLC CA certificate');
  if (tlsMode && !allowAnyCertificate && !/^[a-fA-F0-9]{64}$/.test(process.env.S7PLUS_TLS_CERT_SHA256 ?? '')) throw new Error('S7PLUS_TLS_CERT_SHA256 must contain the independently approved certificate pin');
  if (allowAnyCertificate) console.error('WARNING: TLS certificate verification is disabled; the PLC identity is not authenticated.');
  const ca = tlsMode && !allowAnyCertificate ? await readFile(/** @type {string} */ (process.env.S7PLUS_TLS_CA)) : undefined;
  const client = new S7CommPlusClient({ host: options.host ?? labHost, port: options.port === undefined ? 102 : Number(options.port), productionReadOnly: true, securityMode: tlsMode ? 'tls' : 'legacy',
    limits: { maxRequests: 5, sessionDurationMs: 20000, requestTimeoutMs: 3000 },
    tls: tlsMode ? { ca, servername: process.env.S7PLUS_TLS_SERVERNAME, certificateSha256: process.env.S7PLUS_TLS_CERT_SHA256, allowAnyCertificate, minVersion } : undefined });
  const startedAt = new Date().toISOString();
  try { await client.connect(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  finally {
    const observation = client.report;
    await client.disconnect();
    const report = { startedAt, finishedAt: new Date().toISOString(), ...observation, targetKind: options.host ? 'CONFIGURED' : labMode ? 'LAB' : 'PRODUCTION',
      disconnected: !client.connected, referenceProject: process.env.S7PROXY_REFERENCE_PROJECT ?? null,
      offlineComparison: { status: 'REFERENCE_NOT_AVAILABLE', exactRevisionMatch: null },
      blockUpload: { status: 'NOT_ATTEMPTED_UNQUALIFIED', attempts: [], totalBytes: 0 },
      nextStep: observation.failure ? 'Resolve the recorded failure without escalating traffic or changing PLC settings' : 'Review identity and health evidence before authorizing a small explicit object query',
    };
    console.log(JSON.stringify(report, null, 2));
  }
}