// @ts-check
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { Cursor, decodeObjects } from '../../src/protocol/s7commplus/codec.js';
import { decodeProgramInventory } from '../../src/protocol/s7commplus/block-inventory.js';
import { decodeBlockContent } from '../../src/protocol/s7commplus/block-upload.js';
import { saveSoftwareSnapshot, verifySoftwareSnapshot, diffSoftwareSnapshots } from '../helpers/program-store.js';
import { programExplore } from '../s7commplus-fixture.js';

/** @type {string[]} */
const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function acquisition() {
  const receivedAt = '2026-01-01T00:00:00.000Z';
  const inventory = decodeProgramInventory({ objectId: 3, objects: decodeObjects(new Cursor(programExplore(3, false))), receivedAt });
  const responseBody = programExplore(0x8A130008, false);
  const artifact = decodeBlockContent(inventory.blocks[1], {
    objects: decodeObjects(new Cursor(responseBody)), receivedAt, correlation: { responseBody, fragmentCount: 2 },
  });
  return { artifactClass: 'SOFTWARE_UPLOAD', source: 'SYNTHETIC', status: 'AVAILABLE_COMPONENTS_CAPTURED',
    controller: { target: { host: '127.0.0.1', port: 102 }, identity: { deviceString: 'TEST', orderNumber: 'TEST', firmware: 'V0.0', model: null }, peerCertificateSha256: null },
    cpuState: { before: 'RUN', after: 'RUN' }, inventory, artifacts: [artifact], omissions: [], failure: null,
    totalContentBytes: 4, receivedAt, incrementalStrategy: 'CONTENT_DEDUPLICATION_AFTER_READ',
    completeness: { program: 'AVAILABLE_NATIVE_COMPONENTS_ONLY', inventory: inventory.completeness, controllerState: 'NOT_CAPTURED', restore: 'UNVERIFIED' }, restorable: false };
}

async function directory() {
  const result = await mkdtemp(join(tmpdir(), 's7proxy-software-snapshot-'));
  directories.push(result);
  return result;
}

describe('immutable native software snapshots', () => {
  it('stores original bytes once, verifies references and produces deterministic content diffs', async () => {
    const root = await directory();
    const first = await saveSoftwareSnapshot(acquisition(), root);
    const objects = await readdir(join(root, 'objects/sha256'));
    const second = await saveSoftwareSnapshot(acquisition(), root);
    expect(first.manifestPath).not.toBe(second.manifestPath);
    expect(await readdir(join(root, 'objects/sha256'))).toEqual(objects);
    const verified = await verifySoftwareSnapshot(first.manifestPath);
    expect(verified.valid).toBe(true);
    expect(verified.objectsVerified).toBe(objects.length);
    expect(diffSoftwareSnapshots(first.manifest, second.manifest)).toMatchObject({ added: [], removed: [], changed: [], unchanged: ['FC:8:2316501000'] });
    expect(first.manifest.completeness.restore).toBe('UNVERIFIED');
    expect(first.manifest.restorable).toBe(false);
  });
  it('detects corrupt binary artifacts and preserves previous snapshots on failed acquisition', async () => {
    const root = await directory();
    const first = await saveSoftwareSnapshot(acquisition(), root);
    const originalManifest = await readFile(first.manifestPath);
    const reference = first.manifest.objects[0];
    await writeFile(join(root, reference.path), Buffer.alloc(reference.byteCount));
    await expect(verifySoftwareSnapshot(first.manifestPath)).rejects.toThrow(/corrupt/);
    await expect(saveSoftwareSnapshot(acquisition(), root)).rejects.toThrow(/corrupt/);
    expect(await readFile(first.manifestPath)).toEqual(originalManifest);
  });
  it('rejects changed manifest bytes, unsafe object paths, and undeclared graph references', async () => {
    const root = await directory();
    const first = await saveSoftwareSnapshot(acquisition(), root);
    await writeFile(first.manifestPath, Buffer.from('{}'));
    await expect(verifySoftwareSnapshot(first.manifestPath)).rejects.toThrow(/manifest/);
    for (const path of ['../../outside.bin', 'objects/sha256/missing.bin']) {
      const manifest = { ...first.manifest, objects: first.manifest.objects.map((reference, index) => index ? reference : { ...reference, path }) };
      const bytes = Buffer.from(JSON.stringify(manifest));
      const name = `${manifest.captureId}-${createHash('sha256').update(bytes).digest('hex')}.json`;
      const manifestPath = join(dirname(first.manifestPath), name);
      await writeFile(manifestPath, bytes);
      await expect(verifySoftwareSnapshot(manifestPath)).rejects.toThrow(/unsafe/);
    }
    const manifest = { ...first.manifest, blocks: first.manifest.blocks.map(block => ({ ...block, primary: { sha256: 'a'.repeat(64), byteCount: 1, path: `objects/sha256/${'a'.repeat(64)}.bin` } })) };
    const bytes = Buffer.from(JSON.stringify(manifest));
    const path = join(dirname(first.manifestPath), `${manifest.captureId}-${createHash('sha256').update(bytes).digest('hex')}.json`);
    await writeFile(path, bytes);
    await expect(verifySoftwareSnapshot(path)).rejects.toThrow(/registry/);
  });
  it('retains explicit partial snapshots, detects component changes and refuses unrelated controllers', async () => {
    const root = await directory();
    const first = await saveSoftwareSnapshot(acquisition(), root);
    const partial = acquisition();
    partial.status = 'PARTIAL';
    const second = await saveSoftwareSnapshot(partial, root);
    expect((await verifySoftwareSnapshot(second.manifestPath)).manifest.status).toBe('PARTIAL');
    const changed = structuredClone(second.manifest);
    changed.blocks[0].components[0].status = 'UNAVAILABLE';
    expect(diffSoftwareSnapshots(first.manifest, changed).changed).toEqual(['FC:8:2316501000']);
    changed.controller.target.host = '192.0.2.1';
    expect(() => diffSoftwareSnapshots(first.manifest, changed)).toThrow(/different controller/);
  });
  it('rejects digest-consistent but malformed or falsely successful manifests', async () => {
    const root = await directory();
    const saved = await saveSoftwareSnapshot(acquisition(), root);
    for (const change of [
      { blocks: [] }, { controller: null }, { objects: [] }, { totalContentBytes: 999 },
      { blocks: [saved.manifest.blocks[0], saved.manifest.blocks[0]] },
      { blocks: [{ ...saved.manifest.blocks[0], components: [] }] },
    ]) {
      const manifest = { ...saved.manifest, ...change };
      const bytes = Buffer.from(JSON.stringify(manifest));
      const path = join(dirname(saved.manifestPath), `${manifest.captureId}-${createHash('sha256').update(bytes).digest('hex')}.json`);
      await writeFile(path, bytes);
      await expect(verifySoftwareSnapshot(path)).rejects.toThrow(/manifest|total/);
    }
  });
});
