// @ts-check
// Test-only snapshot persistence; not part of the published library.
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { portableJSON, sha256, storeContent, readBoundedContent as readBounded } from './evidence-store.js';
import { PlusError } from '../../src/protocol/s7commplus/codec.js';
import { responsePayload, decodeObjects } from '../../src/protocol/s7commplus/codec.js';
import { decodeBlockContent } from '../../src/protocol/s7commplus/block-upload.js';
import { BLOCK_CONTENT_ATTRIBUTES } from '../../src/protocol/s7commplus/operation-policy.js';

/** @import { S7CommPlusClient } from '../../src/client/s7commplus-client.js' */
/** @import { decodeProgramInventory } from '../../src/protocol/s7commplus/block-inventory.js' */
/** @typedef {Omit<Awaited<ReturnType<S7CommPlusClient['uploadProgram']>>,'inventory'|'files'> & {inventory:ReturnType<typeof decodeProgramInventory>}} SoftwareAcquisition */
/** @typedef {Awaited<ReturnType<typeof storeContent>>} ContentReference */
/** @typedef {Awaited<ReturnType<typeof saveSoftwareSnapshot>>['manifest']} SoftwareManifest */
const MAX_STORED_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

/** @param {SoftwareAcquisition} acquisition @param {string} [directory] */
export async function saveSoftwareSnapshot(acquisition, directory = 'backups') {
  if (acquisition.artifactClass !== 'SOFTWARE_UPLOAD' || acquisition.restorable !== false) {
    throw new PlusError('ARGUMENT', 'Expected a non-restorable native software acquisition');
  }
  const root = resolve(directory);
  const objectDirectory = join(root, 'objects', 'sha256');
  const manifestDirectory = join(root, 'manifests');
  await mkdir(objectDirectory, { recursive: true, mode: 0o700 });
  await mkdir(manifestDirectory, { recursive: true, mode: 0o700 });
  /** @type {Map<string,ContentReference>} */
  const objects = new Map();
  let storedBytes = 0;
  /** @param {Buffer} bytes */
  async function put(bytes) {
    const hash = sha256(bytes);
    const existing = objects.get(hash);
    if (existing) return existing;
    if (storedBytes + bytes.length > MAX_STORED_BYTES) throw new PlusError('RESPONSE_LIMIT', 'Snapshot storage-byte budget exceeded');
    const reference = await storeContent(objectDirectory, bytes, 'objects/sha256');
    objects.set(hash, reference);
    storedBytes += bytes.length;
    return reference;
  }
  const blocks = [];
  for (const artifact of acquisition.artifacts) {
    if (artifact.rawBytes && (sha256(artifact.rawBytes) !== artifact.sha256 || artifact.rawBytes.length !== artifact.byteCount)) {
      throw new PlusError('ARTIFACT_MISMATCH', 'Primary block content differs from its declared hash or size');
    }
    const components = [];
    for (const component of artifact.components) {
      const parts = [];
      for (const part of component.parts ?? []) {
        if (part.bytes.length !== part.byteCount) throw new PlusError('ARTIFACT_MISMATCH', 'Native component length differs from its bytes');
        parts.push({ key: part.key, blobRootId: part.blobRootId, content: await put(part.bytes) });
      }
      components.push({ attributeId: component.attributeId, role: component.role, status: component.status,
        byteCount: component.byteCount, parts, rawAttribute: component.rawAttribute ? await put(component.rawAttribute) : null });
    }
    blocks.push({ block: artifact.block, status: artifact.status, contentKind: artifact.contentKind,
      rawFormat: artifact.rawFormat, primaryComponent: artifact.primaryComponent,
      primary: artifact.rawBytes ? await put(artifact.rawBytes) : null,
      totalComponentBytes: artifact.totalComponentBytes, components, transfer: artifact.transfer,
      completeness: artifact.completeness, retrievedAt: artifact.retrievedAt,
      correlation: { sequence: artifact.evidence.correlation.sequence ?? null,
        functionCode: artifact.evidence.correlation.functionCode ?? null,
        integrityId: artifact.evidence.correlation.integrityId ?? null,
        request: artifact.evidence.correlation.request ?? null },
      response: await put(artifact.evidence.correlation.responseBody) });
  }
  const inventoryEvidence = await put(Buffer.from(portableJSON(acquisition.inventory.evidence)));
  const manifest = {
    schema: 's7proxy.software-snapshot.v1', captureId: randomUUID(), createdAt: new Date().toISOString(),
    artifactClass: 'SOFTWARE_UPLOAD', source: acquisition.source, status: acquisition.status,
    controller: acquisition.controller, cpuState: acquisition.cpuState,
    inventory: { blocks: acquisition.inventory.blocks, otherObjects: acquisition.inventory.otherObjects,
      completeness: acquisition.inventory.completeness, receivedAt: acquisition.inventory.receivedAt, evidence: inventoryEvidence },
    blocks, omissions: acquisition.omissions, failure: acquisition.failure,
    totalContentBytes: acquisition.totalContentBytes,
    completeness: acquisition.completeness, restorable: false, objects: [...objects.values()],
  };
  const bytes = Buffer.from(portableJSON(manifest));
  if (bytes.length > MAX_MANIFEST_BYTES) throw new PlusError('RESPONSE_LIMIT', 'Snapshot manifest exceeds the byte budget');
  const manifestSha256 = sha256(bytes);
  const manifestPath = join(manifestDirectory, `${manifest.captureId}-${manifestSha256}.json`);
  await writeFile(manifestPath, bytes, { flag: 'wx', mode: 0o600 });
  return { manifestPath, manifestSha256, manifest };
}

/** @param {string} manifestPath @returns {Promise<{valid:true,manifest:SoftwareManifest,objectsVerified:number,storedBytes:number,protocolBlocksVerified:number,protocolEvidenceUnavailable:number}>} */
export async function verifySoftwareSnapshot(manifestPath) {
  const path = resolve(manifestPath);
  if (basename(dirname(path)) !== 'manifests') throw new PlusError('ARGUMENT', 'Select a software snapshot in its manifests directory');
  const bytes = await readBounded(path, MAX_MANIFEST_BYTES);
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest?.schema !== 's7proxy.software-snapshot.v1' || manifest.artifactClass !== 'SOFTWARE_UPLOAD'
    || manifest.restorable !== false || !Array.isArray(manifest.objects) || !Array.isArray(manifest.blocks)
    || !manifest.objects.length || manifest.objects.length > 32768 || manifest.blocks.length > 128
    || !['AVAILABLE_COMPONENTS_CAPTURED', 'PARTIAL', 'UNAVAILABLE'].includes(manifest.status)
    || (manifest.status === 'AVAILABLE_COMPONENTS_CAPTURED' && !manifest.blocks.length)
    || !manifest.controller?.target || typeof manifest.controller.target.host !== 'string'
    || !manifest.controller.identity || !Array.isArray(manifest.inventory?.blocks)
    || !manifest.inventory.evidence || !Array.isArray(manifest.omissions)
    || !['RUN', 'STOP', 'UNKNOWN'].includes(manifest.cpuState?.before)
    || !['RUN', 'STOP', 'UNKNOWN'].includes(manifest.cpuState?.after)
    || manifest.completeness?.restore !== 'UNVERIFIED'
    || !Number.isSafeInteger(manifest.totalContentBytes) || manifest.totalContentBytes < 0
    || basename(path) !== `${manifest.captureId}-${sha256(bytes)}.json`) {
    throw new PlusError('ARTIFACT_MISMATCH', 'Invalid software manifest or manifest digest');
  }
  let componentBytes = 0;
  const blockKeys = new Set();
  const contentIds = BLOCK_CONTENT_ATTRIBUTES.filter(id => id !== 233 && id !== 2521);
  for (const block of manifest.blocks) {
    if (!block?.block || !Number.isInteger(block.block.objectRid) || !Number.isInteger(block.block.number)
      || !['CODE_CONTENT_RETRIEVED', 'DEFINITION_ONLY', 'UNAVAILABLE'].includes(block.status)
      || !Array.isArray(block.components) || block.components.length !== contentIds.length
      || new Set(block.components.map((/** @type {{attributeId:number}} */ component) => component.attributeId)).size !== contentIds.length
      || !Number.isInteger(block.transfer?.protocolFragmentCount) || block.transfer.protocolFragmentCount < 1 || block.transfer.protocolFragmentCount > 64
      || blockKeys.has(block.block.objectRid)) throw new PlusError('ARTIFACT_MISMATCH', 'Invalid or duplicate block manifest');
    blockKeys.add(block.block.objectRid);
    let blockBytes = 0;
    for (const component of block.components) {
      if (!contentIds.includes(component.attributeId) || !Array.isArray(component.parts)
        || !['RETRIEVED', 'EMPTY', 'ABSENT', 'UNSUPPORTED_ENCODING'].includes(component.status)
        || !Number.isSafeInteger(component.byteCount) || component.byteCount < 0
        || component.parts.reduce((/** @type {number} */ sum, /** @type {{content:ContentReference}} */ part) => sum + part.content.byteCount, 0) !== component.byteCount
        || (component.status === 'RETRIEVED' && (component.byteCount === 0 || !component.rawAttribute))
        || (component.status === 'ABSENT' && (component.rawAttribute !== null || component.byteCount !== 0))) {
        throw new PlusError('ARTIFACT_MISMATCH', 'Native component sizes or statuses disagree');
      }
      blockBytes += component.byteCount;
    }
    if (blockBytes !== block.totalComponentBytes || (block.status !== 'UNAVAILABLE' && !block.primary?.byteCount)) {
      throw new PlusError('ARTIFACT_MISMATCH', 'Block content totals or primary content are invalid');
    }
    componentBytes += blockBytes;
  }
  if (componentBytes !== manifest.totalContentBytes) throw new PlusError('ARTIFACT_MISMATCH', 'Software payload total differs from its blocks');
  /** @type {Map<string,ContentReference>} */
  const references = new Map();
  let storedBytes = 0;
  for (const reference of manifest.objects) {
    if (!reference || typeof reference.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(reference.sha256)
      || !Number.isSafeInteger(reference.byteCount) || reference.byteCount < 0
      || reference.path !== `objects/sha256/${reference.sha256}.bin` || references.has(reference.sha256)) {
      throw new PlusError('ARTIFACT_MISMATCH', 'Invalid, duplicate or unsafe content reference');
    }
    storedBytes += reference.byteCount;
    if (storedBytes > MAX_STORED_BYTES) throw new PlusError('RESPONSE_LIMIT', 'Snapshot verification-byte budget exceeded');
    const content = await readBounded(join(dirname(dirname(path)), reference.path), reference.byteCount);
    if (content.length !== reference.byteCount || sha256(content) !== reference.sha256) {
      throw new PlusError('ARTIFACT_MISMATCH', 'Content-addressed block artifact is corrupt', { path: reference.path });
    }
    references.set(reference.sha256, reference);
  }
  let nodes = 0;
  /** @param {unknown} value @param {number} depth */
  function checkReferences(value, depth) {
    if (++nodes > 100000 || depth > 32) throw new PlusError('RESPONSE_LIMIT', 'Manifest structure budget exceeded');
    if (!value || typeof value !== 'object') return;
    if ('path' in value && 'sha256' in value && 'byteCount' in value) {
      const reference = typeof value.sha256 === 'string' ? references.get(value.sha256) : undefined;
      if (!reference || value.path !== reference.path || value.byteCount !== reference.byteCount) {
        throw new PlusError('ARTIFACT_MISMATCH', 'Manifest points outside its verified content registry');
      }
    }
    for (const item of Object.values(value)) checkReferences(item, depth + 1);
  }
  checkReferences(manifest, 0);
  let protocolBlocksVerified = 0;
  let protocolEvidenceUnavailable = 0;
  for (const block of manifest.blocks) {
    const correlation = block.correlation;
    if (!correlation || correlation.sequence === null || correlation.functionCode === null || correlation.integrityId === null || correlation.request === null) {
      protocolEvidenceUnavailable++;
      continue;
    }
    if (!Number.isInteger(correlation.sequence) || correlation.functionCode !== 0x04BB
      || correlation.request.objectId !== block.block.objectRid) throw new PlusError('CORRELATION', 'Snapshot request does not identify its block');
    const body = await readBounded(join(dirname(dirname(path)), block.response.path), block.response.byteCount);
    const { cursor } = responsePayload(body, correlation.functionCode, correlation.sequence);
    cursor.uint32();
    if (cursor.uint() !== correlation.integrityId) throw new PlusError('CORRELATION', 'Snapshot response integrity counter differs from the request receipt');
    const native = manifest.inventory.blocks.filter((/** @type {SoftwareManifest['inventory']['blocks'][number]} */ candidate) => candidate.objectRid === block.block.objectRid);
    if (native.length !== 1) throw new PlusError('CORRELATION', 'Snapshot block is not unique in its inventory');
    const decoded = decodeBlockContent(native[0], { objects: decodeObjects(cursor, 128), receivedAt: block.retrievedAt,
      correlation: { fragmentCount: block.transfer.protocolFragmentCount, responseBody: body } });
    if (decoded.sha256 !== (block.primary?.sha256 ?? null) || decoded.byteCount !== (block.primary?.byteCount ?? 0)) {
      throw new PlusError('ARTIFACT_MISMATCH', 'Decoded native primary content differs from the stored artifact');
    }
    for (const component of decoded.components) {
      const saved = block.components.find((/** @type {SoftwareManifest['blocks'][number]['components'][number]} */ candidate) => candidate.attributeId === component.attributeId);
      if (!saved || saved.status !== component.status || saved.byteCount !== component.byteCount
        || (saved.rawAttribute?.sha256 ?? null) !== component.rawAttributeSha256
        || portableJSON(saved.parts.map((/** @type {SoftwareManifest['blocks'][number]['components'][number]['parts'][number]} */ part) => ({
          key: part.key, blobRootId: part.blobRootId, sha256: part.content.sha256, byteCount: part.content.byteCount,
        }))) !== portableJSON((component.parts ?? []).map(part => ({
          key: part.key, blobRootId: part.blobRootId, sha256: sha256(part.bytes), byteCount: part.byteCount,
        })))) throw new PlusError('ARTIFACT_MISMATCH', 'Decoded native component differs from its manifest');
    }
    protocolBlocksVerified++;
  }
  return { valid: true, manifest, objectsVerified: references.size, storedBytes, protocolBlocksVerified, protocolEvidenceUnavailable };
}

/** @param {SoftwareManifest} previous @param {SoftwareManifest} current */
export function diffSoftwareSnapshots(previous, current) {
  if (portableJSON(previous.controller) !== portableJSON(current.controller)) throw new PlusError('TARGET_MISMATCH', 'Cannot compare software snapshots from different controller identities');
  /** @param {SoftwareManifest['blocks'][number]} block */
  const key = block => `${block.block.type}:${block.block.number}:${block.block.objectRid}`;
  /** @param {SoftwareManifest['blocks'][number]} block */
  const fingerprint = block => portableJSON({ status: block.status, components: block.components.map(component => ({
    attributeId: component.attributeId, status: component.status, sha256: component.rawAttribute?.sha256 ?? null,
  })).sort((left, right) => left.attributeId - right.attributeId) });
  const before = new Map(previous.blocks.map(block => [key(block), block]));
  const after = new Map(current.blocks.map(block => [key(block), block]));
  return {
    added: [...after.keys()].filter(id => !before.has(id)),
    removed: [...before.keys()].filter(id => !after.has(id)),
    changed: [...after].filter(([id, block]) => { const prior = before.get(id); return prior && fingerprint(prior) !== fingerprint(block); }).map(([id]) => id),
    unchanged: [...after].filter(([id, block]) => { const prior = before.get(id); return prior && fingerprint(prior) === fingerprint(block); }).map(([id]) => id),
    scope: 'CAPTURED_COMPONENTS_ONLY_NOT_CONTROLLER_REVISION',
  };
}
