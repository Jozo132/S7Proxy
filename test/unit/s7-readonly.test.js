// @ts-check
import { describe, it, expect, vi } from 'vitest';
import { S7Client } from '../../src/compat/s7client.js';
import { PlcConnection } from '../../src/client/plc-connection.js';
import { S7CommPlusClient } from '../../src/client/s7commplus-client.js';
import { saveAcquisitionEvidence, sha256, portableJSON } from '../../src/backup/evidence-store.js';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('unsupported compatibility operations', () => {
  it('blocks the classic/raw backend for the production target before a socket exists', () => {
    vi.stubEnv('S7PROXY_PRODUCTION_HOST', '192.0.2.10');
    try {
      const productionHost = new S7CommPlusClient().report.target.host;
      expect(() => new PlcConnection('denied', 'production-fixture', { ip: productionHost, rack: 0, slot: 1 },
        /** @type {any} */ ({}), /** @type {any} */ ({}))).toThrow(/PRODUCTION_READ_ONLY/);
    } finally { vi.unstubAllEnvs(); }
  });
  /** @type {[string, any[]][]} */
  const calls = [
    ['PlcStatus', []], ['GetCpuInfo', []], ['GetCpInfo', []], ['GetOrderCode', []],
    ['GetPlcDateTime', []], ['GetProtection', []], ['ReadSZL', [0x11, 0]],
    ['ReadSZLList', []], ['ListBlocks', []], ['ListBlocksOfType', [0x41]],
    ['GetAgBlockInfo', [0x41, 1]], ['Upload', [0x41, 1]], ['FullUpload', [0x41, 1, 16]],
    ['PlcHotStart', []], ['PlcColdStart', []], ['PlcStop', []],
    ['SetPlcDateTime', [new Date()]], ['SetPlcSystemDateTime', []],
    ['SetSessionPassword', ['unused']], ['ClearSessionPassword', []],
    ['Download', [1, Buffer.alloc(1)]], ['Delete', [0x41, 1]],
    ['DBGet', [1]], ['DBFill', [1, 0]], ['CopyRamToRom', [1000]], ['Compress', [1000]],
  ];
  it.each(calls)('%s never fabricates success', (name, args) => {
    const client = new S7Client();
    const callback = vi.fn();
    const method = /** @type {any} */ (client)[String(name)].bind(client);
    method(...args, callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith(0x00F00000);
    expect(client.LastError()).toBe(0x00F00000);
    expect(client.ErrorText(client.LastError())).toContain('not implemented');
    expect(method(...args)).toBe(false);
  });
});

describe('local acquisition evidence (not a project backup)', () => {
  it('preserves raw bytes and hashes, deduplicates content and detects corruption', async () => {
    const directory = await mkdtemp(join(tmpdir(), 's7-evidence-'));
    const report = { target: { host: '127.0.0.1', port: 1 }, protocol: 'fixture', identity: { deviceString: null },
      failure: { code: 'FIXTURE_REJECTED' }, transcript: [{ direction: 'in', layer: 'TPKT', hex: '03000007' }] };
    try {
      const first = await saveAcquisitionEvidence(report, directory);
      const second = await saveAcquisitionEvidence(report, directory);
      expect(first.manifest.report.sha256).toBe(second.manifest.report.sha256);
      expect(first.manifest).toMatchObject({ status: 'INCOMPLETE', completeness: null, restorableProject: false, blockArtifacts: [] });
      expect(first.manifestPath).not.toBe(second.manifestPath);
      const bytes = await readFile(join(directory, first.manifest.report.path));
      expect(sha256(bytes)).toBe(first.manifest.report.sha256);
      expect(JSON.parse(bytes.toString())).toEqual(report);
      expect((await readFile(join(directory, first.manifest.rawFrames[0].path))).toString('hex')).toBe('03000007');
      await writeFile(join(directory, first.manifest.report.path), 'corruption');
      await expect(saveAcquisitionEvidence(report, directory)).rejects.toThrow(/corrupt/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('does not lose 64-bit values or binary metadata during JSON serialization', () => {
    const result = JSON.parse(portableJSON({ count: 18446744073709551615n, raw: Buffer.from([1, 255]) }));
    expect(result).toEqual({ count: { type: 'bigint', decimal: '18446744073709551615' }, raw: { type: 'bytes', hex: '01ff' } });
  });
});