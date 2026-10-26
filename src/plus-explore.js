// @ts-check
import { readFile } from 'node:fs/promises';
import { S7CommPlusClient } from './client/s7commplus-client.js';
import { saveAcquisitionEvidence, portableJSON } from './backup/evidence-store.js';

const args = process.argv.slice(2);
if (!args.includes('--live') || args.some(arg => !['--live', '--tls'].includes(arg))) {
  console.error('Usage: node src/plus-explore.js --live [--tls]');
  console.error('One bounded identification session to the locally configured target on port 102. No block uploads or recurring work.');
  process.exitCode = 2;
} else {
  const tlsMode = args.includes('--tls');
  if (tlsMode && !process.env.S7PLUS_TLS_CA) throw new Error('S7PLUS_TLS_CA must name the authorized PLC CA certificate');
  const ca = tlsMode ? await readFile(/** @type {string} */ (process.env.S7PLUS_TLS_CA)) : undefined;
  const client = new S7CommPlusClient({ productionReadOnly: true, securityMode: tlsMode ? 'tls' : 'discovery',
    tls: ca ? { ca, servername: process.env.S7PLUS_TLS_SERVERNAME } : undefined });
  const startedAt = new Date().toISOString();
  try { await client.connect(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  finally {
    const observation = client.report;
    await client.disconnect();
    const report = { startedAt, finishedAt: new Date().toISOString(), ...observation,
      disconnected: !client.connected, referenceProject: process.env.S7PROXY_REFERENCE_PROJECT ?? null,
      offlineComparison: { status: 'REFERENCE_NOT_AVAILABLE', exactRevisionMatch: null },
      blockUpload: { status: 'NOT_ATTEMPTED_UNQUALIFIED', attempts: [], totalBytes: 0 },
      nextStep: observation.failure ? 'Resolve the recorded failure without escalating traffic or changing PLC settings' : 'Review identity and health evidence before authorizing a small explicit object query',
    };
    const saved = await saveAcquisitionEvidence(report);
    console.log(portableJSON({ manifestPath: saved.manifestPath, report }));
  }
}