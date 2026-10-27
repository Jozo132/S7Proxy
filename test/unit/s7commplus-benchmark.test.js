// @ts-check
import { describe, it, expect } from 'vitest';
import { runS7CommPlusBenchmark, summarizeTiming, validateBenchmarkConfig } from '../../src/client/s7commplus-benchmark.js';
import { fixture } from '../s7commplus-fixture.js';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

describe('S7CommPlus bounded parallel benchmark', () => {
  it('computes signed jitter distributions without fabricating empty percentiles', () => {
    expect(summarizeTiming([])).toMatchObject({ count: 0, p99: null });
    expect(summarizeTiming([-2, 0, 2, 4])).toMatchObject({ count: 4, min: -2, max: 4, mean: 1, p50: 0, p95: 4, p99: 4 });
  });
  it('rejects unbounded or ambiguous configurations before connecting', () => {
    const config = { host: '127.0.0.1', securityMode: /** @type {const} */ ('legacy'), dbNumbers: [7], stages: [{ name: 'test', durationMs: 100, lanes: [{ id: 'bool', type: /** @type {const} */ ('boolean'), periodMs: 0 }] }] };
    expect(() => validateBenchmarkConfig(config)).not.toThrow();
    expect(() => validateBenchmarkConfig({ ...config, dbNumbers: [] })).toThrow(/DB/);
    expect(() => validateBenchmarkConfig({ ...config, stages: [{ ...config.stages[0], durationMs: 60001 }] })).toThrow(/duration/);
    expect(() => validateBenchmarkConfig({ ...config, stages: [{ ...config.stages[0], lanes: [{ ...config.stages[0].lanes[0], readPacingMs: 1 }] }] })).toThrow(/readPacing/);
  });
  it('runs real loopback boolean and numeric traffic on independent sessions and records timing', async () => {
    const server = await fixture({ metadata: true });
    /** @type {Record<string,any>[]} */
    const records = [];
    try {
      const report = await runS7CommPlusBenchmark({ host: '127.0.0.1', port: server.port, securityMode: 'legacy', dbNumbers: [7],
        stages: [{ name: 'parallel', durationMs: 180, lanes: [{ id: 'bool', type: 'boolean', periodMs: 0 }, { id: 'numeric', type: 'numeric', periodMs: 70 }] }] },
      { onRecord: record => { records.push(record); } });
      expect(report.error).toBeNull();
      expect(report.status).toBe('COMPLETED');
      expect(report.disconnected).toBe(true);
      expect(server.cotpRequests).toHaveLength(2);
      const manifests = records.filter(record => record.kind === 'manifest');
      expect(manifests).toHaveLength(2);
      expect(manifests.filter(record => record.lane === 'bool')[0].members.every(/** @param {{datatype:string}} member */ member => member.datatype === 'BOOL')).toBe(true);
      expect(manifests.filter(record => record.lane === 'numeric')[0].members.every(/** @param {{datatype:string}} member */ member => member.datatype !== 'BOOL' && member.datatype !== 'STRING')).toBe(true);
      const sweeps = records.filter(record => record.kind === 'sweep');
      expect(sweeps.filter(record => record.lane === 'bool').length).toBeGreaterThan(0);
      expect(sweeps.filter(record => record.lane === 'numeric').length).toBeGreaterThan(0);
      expect(sweeps.every(record => record.requests.every(/** @param {{latencyMs:number}} request */ request => request.latencyMs >= 0))).toBe(true);
      expect(report.plcScanSynchronized).toBe(false);
      expect(server.errors).toEqual([]);
    } finally { await server.close(); }
  });
  it('records skipped absolute schedule slots rather than catching up with bursts', async () => {
    const server = await fixture({ metadata: true });
    try {
      const report = await runS7CommPlusBenchmark({ host: '127.0.0.1', port: server.port, securityMode: 'legacy', dbNumbers: [7],
        stages: [{ name: 'slow-sink', durationMs: 100, lanes: [{ id: 'bool', type: 'boolean', periodMs: 10 }] }] },
      { onRecord: async record => { if (record.kind === 'sweep') await delay(35); } });
      expect(report.error).toBeNull();
      expect(report.stages[0]).toMatchObject({ lanes: [{ missedPeriods: expect.any(Number), periodicScheduleMet: false }] });
      const lanes = /** @type {{missedPeriods:number}[]} */ (report.stages[0].lanes);
      expect(lanes[0].missedPeriods).toBeGreaterThan(0);
    } finally { await server.close(); }
  });
  it('stops sibling traffic on a typed read failure and closes all sessions', async () => {
    const server = await fixture({ metadata: true, memberError: true });
    try {
      const report = await runS7CommPlusBenchmark({ host: '127.0.0.1', port: server.port, securityMode: 'legacy', dbNumbers: [7],
        stages: [{ name: 'reject', durationMs: 100, lanes: [{ id: 'bool', type: 'boolean', periodMs: 0 }, { id: 'num', type: 'numeric', periodMs: 50 }] },
          { name: 'must-not-start', durationMs: 100, lanes: [{ id: 'bool', type: 'boolean', periodMs: 0 }] }] });
      expect(report.status).toBe('FAILED');
      expect(report.error).toMatch(/rejected/);
      expect(report.disconnected).toBe(true);
      expect(server.cotpRequests).toHaveLength(2);
    } finally { await server.close(); }
  });
  it('cancels parallel setup and does not start traffic for a pre-aborted run', async () => {
    const server = await fixture({ metadata: true });
    const config = { host: '127.0.0.1', port: server.port, securityMode: /** @type {const} */ ('legacy'), dbNumbers: [7],
      stages: [{ name: 'abort', durationMs: 100, lanes: [{ id: 'bool', type: /** @type {const} */ ('boolean'), periodMs: 0 }] }] };
    try {
      const preaborted = new AbortController();
      preaborted.abort();
      expect((await runS7CommPlusBenchmark(config, { signal: preaborted.signal })).status).toBe('ABORTED');
      expect(server.cotpRequests).toHaveLength(0);
      const control = new AbortController();
      const timer = setTimeout(() => control.abort(), 50);
      const report = await runS7CommPlusBenchmark(config, { signal: control.signal });
      clearTimeout(timer);
      expect(report.disconnected).toBe(true);
      expect(report.status).toBe('ABORTED');
      expect(server.cotpRequests).toHaveLength(1);
    } finally { await server.close(); }
  });
  it('creates fresh owned sessions for each stress stage', async () => {
    const server = await fixture({ metadata: true });
    try {
      const report = await runS7CommPlusBenchmark({ host: '127.0.0.1', port: server.port, securityMode: 'legacy', dbNumbers: [7],
        stages: [32, 16].map(maxItems => ({ name: `batch-${maxItems}`, durationMs: 60, lanes: [{ id: 'bool', type: 'boolean', periodMs: 0, maxItems }] })) });
      expect(report.error).toBeNull();
      expect(report.stages).toHaveLength(2);
      expect(server.cotpRequests).toHaveLength(2);
      expect(report.disconnected).toBe(true);
    } finally { await server.close(); }
  });
  it('CLI refuses implicit traffic and streams a bounded trace without overwriting files', async () => {
    const execute = promisify(execFile);
    await expect(execute(process.execPath, ['src/plus-benchmark.js'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('--acknowledge-load') });
    const server = await fixture({ metadata: true });
    const directory = await mkdtemp(join(tmpdir(), 's7plus-benchmark-'));
    try {
      const plan = join(directory, 'plan.json');
      const trace = join(directory, 'trace.ndjson');
      await writeFile(plan, JSON.stringify({ dbNumbers: [7], stages: [{ name: 'cli', durationMs: 70, lanes: [{ id: 'bool', type: 'boolean', periodMs: 0 }] }] }));
      const args = ['src/plus-benchmark.js', '--live', '--acknowledge-load', '--legacy', '--host', '127.0.0.1', '--port', String(server.port), '--config', plan, '--output', trace];
      const result = await execute(process.execPath, args);
      expect(JSON.parse(result.stdout).status).toBe('COMPLETED');
      const records = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(records[0]).toMatchObject({ kind: 'run', plcScanSynchronized: false });
      expect(records.at(-1)).toMatchObject({ kind: 'summary', disconnected: true });
      const connections = server.cotpRequests.length;
      await expect(execute(process.execPath, args)).rejects.toMatchObject({ stderr: expect.stringContaining('EEXIST') });
      expect(server.cotpRequests).toHaveLength(connections);
    } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it('cancels a stalled on-wire read without waiting for the request timeout', async () => {
    const fixtureOptions = { metadata: true, readStall: false };
    const server = await fixture(fixtureOptions);
    const control = new AbortController();
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timer;
    try {
      const report = await runS7CommPlusBenchmark({ host: '127.0.0.1', port: server.port, securityMode: 'legacy', dbNumbers: [7],
        stages: [{ name: 'stall', durationMs: 1000, lanes: [{ id: 'bool', type: 'boolean', periodMs: 0 }] }] },
      { signal: control.signal, onRecord: record => { if (record.kind === 'manifest') { fixtureOptions.readStall = true; timer = setTimeout(() => control.abort(), 70); } } });
      expect(report.status).toBe('ABORTED');
      expect(report.disconnected).toBe(true);
      expect(server.requests.some(request => request.functionCode === 0x054C)).toBe(true);
    } finally { clearTimeout(timer); await server.close(); }
  });
  it('cleans up every setup connection when a selected DB is missing', async () => {
    const server = await fixture({ metadata: true });
    try {
      const report = await runS7CommPlusBenchmark({ host: '127.0.0.1', port: server.port, securityMode: 'legacy', dbNumbers: [99],
        stages: [{ name: 'missing-db', durationMs: 100, lanes: [{ id: 'bool', type: 'boolean', periodMs: 0 }, { id: 'numeric', type: 'numeric', periodMs: 50 }] }] });
      expect(report.status).toBe('FAILED');
      expect(report.error).toMatch(/DB99/);
      expect(report.disconnected).toBe(true);
      expect(server.cotpRequests).toHaveLength(2);
      expect(server.requests.some(request => request.functionCode === 0x054C)).toBe(false);
    } finally { await server.close(); }
  });
  it('fails closed on trace output errors instead of claiming telemetry delivery', async () => {
    const server = await fixture({ metadata: true });
    try {
      await expect(runS7CommPlusBenchmark({ host: '127.0.0.1', port: server.port, securityMode: 'legacy', dbNumbers: [7],
        stages: [{ name: 'sink-failure', durationMs: 100, lanes: [{ id: 'bool', type: 'boolean', periodMs: 0 }] }] },
      { onRecord: record => { if (record.kind === 'sweep' || record.kind === 'summary') throw new Error('sink failed'); } })).rejects.toThrow('sink failed');
      expect(server.errors).toEqual([]);
    } finally { await server.close(); }
  });
});