// @ts-check
import { readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { runS7CommPlusBenchmark, validateBenchmarkConfig } from './client/s7commplus-benchmark.js';

/** @import { BenchmarkConfig } from './client/s7commplus-benchmark.js' */

async function main() {
  const { values } = parseArgs({ options: {
    live: { type: 'boolean' }, 'acknowledge-load': { type: 'boolean' }, config: { type: 'string' },
    host: { type: 'string' }, port: { type: 'string' }, tls: { type: 'boolean' }, legacy: { type: 'boolean' },
    output: { type: 'string' }, 'max-trace-bytes': { type: 'string' }, 'allow-any-certificate': { type: 'boolean' }, 'tls-min-version': { type: 'string' },
  } });
  if (!values.live || !values['acknowledge-load'] || !values.config || !values.host || !values.output || Boolean(values.tls) === Boolean(values.legacy)) {
    throw new Error('Usage: node src/plus-benchmark.js --live --acknowledge-load --host HOST (--tls | --legacy) --config PLAN.json --output TRACE.ndjson [--port PORT] [--allow-any-certificate] [--tls-min-version TLSv1.2|TLSv1.3]');
  }
  const minVersion = values['tls-min-version'];
  if (minVersion !== undefined && minVersion !== 'TLSv1.2' && minVersion !== 'TLSv1.3') throw new Error('Invalid TLS minimum version');
  if (!values.tls && (values['allow-any-certificate'] || minVersion)) throw new Error('TLS options require --tls');
  const parsed = JSON.parse(await readFile(values.config, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Plan must be a JSON object');
  if (['host', 'port', 'securityMode', 'tls'].some(key => key in parsed)) throw new Error('Set endpoint/security through CLI and TLS environment variables, not the plan');
  /** @type {BenchmarkConfig} */
  const config = { ...parsed, host: values.host, port: values.port === undefined ? 102 : Number(values.port), securityMode: values.tls ? 'tls' : 'legacy' };
  validateBenchmarkConfig(config);
  const maxTraceBytes = values['max-trace-bytes'] === undefined ? 134217728 : Number(values['max-trace-bytes']);
  if (!Number.isSafeInteger(maxTraceBytes) || maxTraceBytes < 1024 || maxTraceBytes > 1073741824) throw new Error('max-trace-bytes must be 1024..1073741824');
  if (values.tls) {
    const bypass = values['allow-any-certificate'] === true;
    if (!bypass && (!process.env.S7PLUS_TLS_CA || !/^[a-f0-9]{64}$/i.test(process.env.S7PLUS_TLS_CERT_SHA256 ?? ''))) throw new Error('Verified TLS requires S7PLUS_TLS_CA and independently approved S7PLUS_TLS_CERT_SHA256');
    if (bypass) console.error('WARNING: TLS_UNVERIFIED; peer authentication is disabled. Read-only polling can still load the CPU and affect machine timing.');
    config.tls = { ca: !bypass ? await readFile(/** @type {string} */ (process.env.S7PLUS_TLS_CA)) : undefined,
      servername: process.env.S7PLUS_TLS_SERVERNAME, certificateSha256: process.env.S7PLUS_TLS_CERT_SHA256,
      allowAnyCertificate: bypass, minVersion };
  }
  const control = new AbortController();
  const abort = () => control.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const stream = createWriteStream(values.output, { flags: 'wx' });
  /** @type {Error|undefined} */
  let outputError;
  let writtenBytes = 0;
  stream.on('error', error => { outputError = error; control.abort(); });
  try {
    await new Promise((resolve, reject) => { stream.once('open', resolve); stream.once('error', reject); });
    const report = await runS7CommPlusBenchmark(config, { signal: control.signal, onRecord: record => new Promise((resolve, reject) => {
      if (outputError) { reject(outputError); return; }
      let serialized;
      try { serialized = JSON.stringify(record, (_key, value) => typeof value === 'bigint' ? { encoding: 'bigint', decimal: value.toString() } : value); }
      catch (error) { reject(error); return; }
      const bytes = Buffer.byteLength(serialized) + 1;
      if (writtenBytes + bytes > maxTraceBytes) { reject(new Error('Trace byte budget exhausted; output is partial')); return; }
      writtenBytes += bytes;
      stream.write(`${serialized}\n`, error => error ? reject(error) : resolve());
    }) });
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'COMPLETED') process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    stream.end();
    await finished(stream);
  }
}

try { await main(); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }