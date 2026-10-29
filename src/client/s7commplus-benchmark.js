// @ts-check
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { S7CommPlusClient } from './s7commplus-client.js';

/** @import { PlusOptions } from './s7commplus-client.js' */
/** @typedef {{id:string,type:'boolean'|'numeric',periodMs:number,readPacingMs?:number,maxItems?:number,maxMembers?:number}} BenchmarkLane */
/** @typedef {{name:string,durationMs:number,lanes:BenchmarkLane[]}} BenchmarkStage */
/** @typedef {{host:string,port?:number,securityMode:'tls'|'legacy',tls?:PlusOptions['tls'],dbNumbers:number[],stages:BenchmarkStage[],maxConnectionsPerTarget?:number,maxBlocks?:number,maxRequestsPerLane?:number,maxSweepsPerLane?:number,startupTimeoutMs?:number,maxLatencyMs?:number,reference?:{archiveSha256:string,controllerKey:string}}} BenchmarkConfig */
/** @typedef {Pick<S7CommPlusClient,'connect'|'disconnect'|'listDataBlocks'|'listBlockMembers'|'readMembers'|'connected'|'report'>} BenchmarkClient */

const numericTypes = new Set(['BYTE', 'WORD', 'DWORD', 'LWORD', 'SINT', 'USINT', 'INT', 'UINT', 'DINT', 'UDINT', 'LINT', 'ULINT', 'REAL', 'LREAL', 'TIME', 'LTIME']);

/** @param {number} value @param {number} minimum @param {number} maximum @param {string} name */
function integer(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be ${minimum}..${maximum}`);
}

/** @param {BenchmarkConfig} config */
export function validateBenchmarkConfig(config) {
  if (!config || typeof config.host !== 'string' || !config.host || !['tls', 'legacy'].includes(config.securityMode)) throw new Error('Explicit host and TLS or legacy profile required');
  integer(config.port ?? 102, 1, 65535, 'port');
  const connections = config.maxConnectionsPerTarget ?? 4;
  integer(connections, 1, 16, 'maxConnectionsPerTarget');
  integer(config.maxBlocks ?? 64, 1, 256, 'maxBlocks');
  integer(config.maxRequestsPerLane ?? 20000, 6, 100000, 'maxRequestsPerLane');
  integer(config.maxSweepsPerLane ?? 10000, 1, 100000, 'maxSweepsPerLane');
  integer(config.startupTimeoutMs ?? 30000, 100, 120000, 'startupTimeoutMs');
  integer(config.maxLatencyMs ?? 1000, 1, 5000, 'maxLatencyMs');
  if (!Array.isArray(config.dbNumbers) || !config.dbNumbers.length || config.dbNumbers.length > (config.maxBlocks ?? 64) || new Set(config.dbNumbers).size !== config.dbNumbers.length) throw new Error('Explicit unique bounded DB numbers required');
  for (const number of config.dbNumbers) integer(number, 1, 65535, 'DB number');
  if (config.reference && (!/^[a-f0-9]{64}$/i.test(config.reference.archiveSha256) || !config.reference.controllerKey)) throw new Error('Reference requires archive SHA256 and controller key');
  if (!Array.isArray(config.stages) || !config.stages.length || config.stages.length > 32) throw new Error('Specify 1..32 explicit stress stages');
  if (new Set(config.stages.map(stage => stage.name)).size !== config.stages.length) throw new Error('Stress stage names must be unique');
  let totalDuration = 0;
  for (const stage of config.stages) {
    integer(stage.durationMs, 50, 60000, 'durationMs');
    totalDuration += stage.durationMs;
    if (!stage.name || !Array.isArray(stage.lanes) || !stage.lanes.length || stage.lanes.length > connections || new Set(stage.lanes.map(lane => lane.id)).size !== stage.lanes.length) throw new Error('Each stage requires named unique lanes within the connection cap');
    for (const lane of stage.lanes) {
      if (!lane.id || !['boolean', 'numeric'].includes(lane.type)) throw new Error('Each lane requires an id and boolean or numeric type');
      integer(lane.periodMs, 0, 60000, 'periodMs');
      integer(lane.readPacingMs ?? 10, 10, 5000, 'readPacingMs');
      integer(lane.maxItems ?? 64, 1, 64, 'maxItems');
      integer(lane.maxMembers ?? 4096, 1, 4096, 'maxMembers');
    }
  }
  if (totalDuration > 300000) throw new Error('Total sampling duration must not exceed 300000 ms');
}

/** @param {number[]} values */
export function summarizeTiming(values) {
  if (!values.length) return { count: 0, min: null, max: null, mean: null, stddev: null, p50: null, p95: null, p99: null };
  const sorted = [...values].sort((left, right) => left - right);
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const percentile = (/** @type {number} */ fraction) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  return { count: values.length, min: sorted[0], max: sorted.at(-1), mean,
    stddev: Math.sqrt(values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length),
    p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) };
}

/** @param {BenchmarkConfig} input @param {{createClient?:(options:PlusOptions)=>BenchmarkClient,onRecord?:(record:Record<string,unknown>)=>void|Promise<void>,signal?:AbortSignal}} [options] */
export async function runS7CommPlusBenchmark(input, options = {}) {
  const config = structuredClone(input);
  validateBenchmarkConfig(config);
  const control = new AbortController();
  const createClient = options.createClient ?? (settings => new S7CommPlusClient(settings));
  /** @type {BenchmarkClient[]} */
  let clients = [];
  /** @type {string|null} */
  let failure = null;
  let cancelled = false;
  let output = Promise.resolve();
  const cancel = () => { cancelled = true; control.abort(); };
  const closeClients = () => { for (const client of clients) void client.disconnect().catch(() => undefined); };
  control.signal.addEventListener('abort', closeClients);
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const fail = (/** @type {unknown} */ error) => {
    if (!cancelled) failure ??= error instanceof Error ? error.message : String(error);
    control.abort();
  };
  const emit = async (/** @type {Record<string,unknown>} */ record) => {
    const pending = output.then(() => options.onRecord?.(record));
    output = pending.then(() => undefined, () => undefined);
    try { await pending; } catch (error) { fail(error); throw error; }
  };
  /** @type {Record<string,unknown>[]} */
  const stages = [];
  const startedAt = new Date().toISOString();
  try {
    await emit({ kind: 'run', version: 1, startedAt, timeOriginUnixMs: performance.timeOrigin,
      target: { host: config.host, port: config.port ?? 102 }, reference: config.reference ?? null,
      runtimeRevision: 'UNVERIFIED', plcScanSynchronized: false, selectedProfile: config.securityMode, dbNumbers: config.dbNumbers, stages: config.stages,
      budgets: { maxRequestsPerLane: config.maxRequestsPerLane ?? 20000, maxSweepsPerLane: config.maxSweepsPerLane ?? 10000,
        maxConnectionsPerTarget: config.maxConnectionsPerTarget ?? 4, maxLatencyMs: config.maxLatencyMs ?? 1000, startupTimeoutMs: config.startupTimeoutMs ?? 30000 } });
    for (const stage of config.stages) {
      if (control.signal.aborted) break;
      clients = [];
      const startupTimer = setTimeout(() => fail(new Error('Stage startup deadline exceeded')), config.startupTimeoutMs ?? 30000);
      try {
        const lanes = stage.lanes.map(lane => {
          const client = createClient({ host: config.host, port: config.port, securityMode: config.securityMode, tls: config.tls, productionReadOnly: true,
            limits: { maxConnectionsPerTarget: config.maxConnectionsPerTarget ?? 4, maxQueuedRequests: 1,
              sessionDurationMs: stage.durationMs + (config.startupTimeoutMs ?? 30000) + 5000,
              maxRequests: config.maxRequestsPerLane ?? 20000, requestTimeoutMs: Math.min(5000, (config.maxLatencyMs ?? 1000) + 1000),
              maxLatencyMs: config.maxLatencyMs ?? 1000, maxSessionBytes: 67108864, maxResponseBytes: 4194304,
              readPacingMs: lane.readPacingMs ?? 10, maxDiagnosticEntries: 16 } });
          clients.push(client);
          return { lane, client };
        });
        const preparation = await Promise.allSettled(lanes.map(async ({ lane, client }) => {
          await client.connect();
          if (control.signal.aborted) throw new Error('Benchmark cancelled during setup');
          const inventory = await client.listDataBlocks();
          /** @type {Awaited<ReturnType<BenchmarkClient['listBlockMembers']>>[]} */
          const discoveries = [];
          for (const number of config.dbNumbers) {
            const matches = inventory.blocks.filter(block => block.number === number);
            if (matches.length !== 1 || !matches[0].name) throw new Error(`DB${number} is unavailable or ambiguous`);
            const discovery = await client.listBlockMembers({ type: 'DB', number }, { maxMembers: 4096, maxTypes: 64 });
            if (discovery.completeness !== 'COMPLETE' || discovery.block.name !== matches[0].name) throw new Error(`DB${number} metadata incomplete or inconsistent`);
            discoveries.push(discovery);
          }
          const selected = discoveries.flatMap(discovery => discovery.members.filter(member => member.readable && (lane.type === 'boolean' ? member.datatype === 'BOOL' : numericTypes.has(member.datatype))).map(member => ({ member, block: discovery.block })));
          if (!selected.length || selected.length > (lane.maxMembers ?? 4096)) throw new Error(`Lane ${lane.id} has no matching members or exceeds its member cap`);
          await emit({ kind: 'manifest', stage: stage.name, lane: lane.id, securityMode: client.report.securityMode,
            peerCertificateSha256: client.report.peerCertificateSha256,
            members: selected.map(({ member, block }) => ({ canonicalTarget: `DB|${block.number}|${block.name}|${member.path}`,
              objectRid: block.objectRid, typeInfoId: block.typeInfoId, memberTypeInfoId: member.typeInfoId,
              memberId: member.memberId, accessPath: member.accessPath, datatype: member.datatype, metadataSymbolCrc: member.symbolCrc })) });
          return { lane, client, members: selected.map(item => item.member) };
        }).map(promise => promise.catch(error => { fail(error); throw error; })));
        const rejected = preparation.find(result => result.status === 'rejected');
        if (rejected?.status === 'rejected') throw rejected.reason;
        const prepared = preparation.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
        clearTimeout(startupTimer);
        const stageStart = performance.now();
        const deadline = stageStart + stage.durationMs;
        const deadlineTimer = setTimeout(() => closeClients(), stage.durationMs + (config.maxLatencyMs ?? 1000) + 1100);
        const results = await Promise.all(prepared.map(async ({ lane, client, members }) => {
          /** @type {Record<string,number[]>} */
          const metrics = { wirePeriodMs: [], wirePeriodDeltaMs: [], latencyMs: [], sweepPeriodMs: [], sweepPeriodErrorMs: [], sweepPeriodDeltaMs: [], scheduleLatenessMs: [], sweepWindowMs: [], outputWaitMs: [] };
          let sweeps = 0, requests = 0, missedPeriods = 0, deadlineOverruns = 0, values = 0, requestBytes = 0, responseBytes = 0;
          let nextDue = stageStart;
          /** @type {number|undefined} */
          let previousRequest, previousWirePeriod, previousSweep, previousPeriod;
          /** @type {string|null} */
          let laneFailure = null;
          try {
            while (!control.signal.aborted && performance.now() < deadline) {
              while (!control.signal.aborted && performance.now() < Math.min(nextDue, deadline)) {
                await delay(Math.max(1, Math.ceil(Math.min(nextDue, deadline) - performance.now())), undefined, { signal: control.signal });
              }
              if (control.signal.aborted || performance.now() >= deadline) break;
              if (sweeps >= (config.maxSweepsPerLane ?? 10000)) throw new Error(`Lane ${lane.id} sweep budget exhausted`);
              const samples = await client.readMembers(members, { maxItems: lane.maxItems ?? 32 });
              if (samples.length !== members.length) throw new Error(`Lane ${lane.id} returned an incomplete sample set`);
              const invalidSample = samples.find(sample => sample.observation.quality !== 'GOOD');
              if (invalidSample) throw new Error(`Lane ${lane.id} returned ${invalidSample.observation.quality} sample (${invalidSample.observation.status ?? 'unknown status'}); benchmark requires GOOD values`);
              const timedSamples = samples.map(sample => {
                if (!sample.request) throw new Error(`Lane ${lane.id} returned a GOOD sample without native request timing`);
                return { ...sample, request: sample.request };
              });
              const groups = [...new Map(timedSamples.map(sample => [sample.request.sequence, sample.request])).values()];
              const firstGroup = groups[0];
              if (!firstGroup) throw new Error(`Lane ${lane.id} returned no native request timing groups`);
              const first = firstGroup.sentAtMonotonicMs;
              const last = groups[groups.length - 1].receivedAtMonotonicMs;
              const period = previousSweep === undefined ? undefined : first - previousSweep;
              for (const request of groups) {
                if (!Number.isFinite(request.sentAtMonotonicMs) || !Number.isFinite(request.receivedAtMonotonicMs) || request.receivedAtMonotonicMs < request.sentAtMonotonicMs) throw new Error('Invalid native request timing evidence');
                metrics.latencyMs.push(request.latencyMs);
                requestBytes += request.requestBytes;
                responseBytes += request.responseBytes;
                if (previousRequest !== undefined) {
                  const wirePeriod = request.sentAtMonotonicMs - previousRequest;
                  metrics.wirePeriodMs.push(wirePeriod);
                  if (previousWirePeriod !== undefined) metrics.wirePeriodDeltaMs.push(wirePeriod - previousWirePeriod);
                  previousWirePeriod = wirePeriod;
                }
                previousRequest = request.sentAtMonotonicMs;
              }
              if (period !== undefined) {
                metrics.sweepPeriodMs.push(period);
                if (lane.periodMs) metrics.sweepPeriodErrorMs.push(period - lane.periodMs);
                if (previousPeriod !== undefined) metrics.sweepPeriodDeltaMs.push(period - previousPeriod);
                previousPeriod = period;
              }
              metrics.scheduleLatenessMs.push(Math.max(0, first - nextDue));
              metrics.sweepWindowMs.push(last - first);
              if (lane.periodMs && last > nextDue + lane.periodMs) deadlineOverruns++;
              previousSweep = first;
              sweeps++; requests += groups.length; values += samples.length;
              const outputStarted = performance.now();
              await emit({ kind: 'sweep', stage: stage.name, lane: lane.id, sweep: sweeps, scheduledAtMonotonicMs: nextDue,
                requests: groups, values: timedSamples.map(sample => ({ value: sample.observation.value, quality: sample.observation.quality,
                  receivedAt: sample.observation.receivedAt, requestSequence: sample.request.sequence })) });
              metrics.outputWaitMs.push(performance.now() - outputStarted);
              if (lane.periodMs) {
                nextDue += lane.periodMs;
                const now = performance.now();
                if (nextDue < now) {
                  const skipped = Math.ceil((Math.min(now, deadline) - nextDue) / lane.periodMs);
                  missedPeriods += skipped;
                  nextDue += skipped * lane.periodMs;
                }
              } else nextDue = performance.now();
            }
          } catch (error) {
            if (!control.signal.aborted) { laneFailure = error instanceof Error ? error.message : String(error); fail(error); }
          }
          const elapsedMs = performance.now() - stageStart;
          return { id: lane.id, type: lane.type, periodMs: lane.periodMs, memberCount: members.length, sweeps, requests, values,
            missedPeriods, deadlineOverruns, elapsedMs, requestBytes, responseBytes, applicationBytesPerSecond: (requestBytes + responseBytes) * 1000 / elapsedMs,
            periodicScheduleMet: lane.periodMs ? !laneFailure && !control.signal.aborted && missedPeriods === 0 && deadlineOverruns === 0 : null,
            sessionStatistics: client.report.statistics, sweepsPerSecond: sweeps * 1000 / elapsedMs, requestsPerSecond: requests * 1000 / elapsedMs,
            valuesPerSecond: values * 1000 / elapsedMs, error: laneFailure,
            timing: Object.fromEntries(Object.entries(metrics).map(([name, entries]) => [name, summarizeTiming(entries)])) };
        }));
        clearTimeout(deadlineTimer);
        const result = { name: stage.name, requestedDurationMs: stage.durationMs, elapsedMs: performance.now() - stageStart,
          completed: !control.signal.aborted, lanes: results };
        stages.push(result);
        await emit({ kind: 'stage', ...result });
      } catch (error) { fail(error); }
      finally {
        clearTimeout(startupTimer);
        const closing = await Promise.allSettled(clients.map(client => client.disconnect()));
        if (closing.some(result => result.status === 'rejected') || clients.some(client => client.connected)) failure ??= 'One or more owned connections did not disconnect cleanly';
      }
      if (failure) break;
    }
  } catch (error) { fail(error); }
  finally {
    options.signal?.removeEventListener('abort', cancel);
    control.signal.removeEventListener('abort', closeClients);
    await Promise.allSettled(clients.map(client => client.disconnect()));
  }
  const report = { version: 1, startedAt, finishedAt: new Date().toISOString(), status: failure ? 'FAILED' : cancelled ? 'ABORTED' : 'COMPLETED',
    error: failure, stages, disconnected: clients.every(client => !client.connected), plcScanSynchronized: false, runtimeRevision: 'UNVERIFIED' };
  await emit({ kind: 'summary', ...report });
  return report;
}