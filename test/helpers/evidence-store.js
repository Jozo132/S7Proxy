// @ts-check
// Test-only persistence for synthetic fixtures and acquisition assertions.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, lstat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

/** @param {Buffer} bytes */
export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

/** @param {string} path @param {number} maximum */
export async function readBoundedContent(path, maximum) {
  const entry = await lstat(path);
  if (!entry.isFile()) throw new Error(`Content-addressed artifact is not a regular file: ${path}`);
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum) throw new Error(`Content-addressed artifact is corrupt or exceeds its byte budget: ${path}`);
    const bytes = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== info.size) throw new Error(`Content-addressed artifact changed during verification: ${path}`);
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

/** @param {string} directory @param {Buffer} bytes @param {string} [namespace] */
export async function storeContent(directory, bytes, namespace = 'content') {
  const hash = sha256(bytes);
  const path = join(directory, `${hash}.bin`);
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
    if (sha256(await readBoundedContent(path, bytes.length)) !== hash) throw new Error(`Content-addressed evidence is corrupt: ${path}`);
  }
  return { sha256: hash, byteCount: bytes.length, path: `${namespace}/${hash}.bin` };
}

/** @param {unknown} value */
export function portableJSON(value) {
  return JSON.stringify(value, (_key, current) => {
    if (typeof current === 'bigint') return { type: 'bigint', decimal: current.toString() };
    if (current instanceof Uint8Array) return { type: 'bytes', hex: Buffer.from(current).toString('hex') };
    if (current?.type === 'Buffer' && Array.isArray(current.data)) return { type: 'bytes', hex: Buffer.from(current.data).toString('hex') };
    return current;
  }, 2);
}

/** @param {object} report @param {string} [directory] */
export async function saveAcquisitionEvidence(report, directory = 'backups/production') {
  const root = resolve(directory);
  const content = join(root, 'content');
  await mkdir(content, { recursive: true });
  const payload = Buffer.from(portableJSON(report));
  const artifact = await storeContent(content, payload);
  const reportValue = /** @type {any} */ (report);
  const frames = [];
  for (const entry of reportValue.transcript ?? []) {
    if (entry.direction !== 'in' || entry.layer !== 'TPKT') continue;
    frames.push(await storeContent(content, Buffer.from(entry.hex, 'hex')));
  }
  const manifest = {
    schema: 's7proxy.acquisition-evidence.v1', createdAt: new Date().toISOString(),
    source: { target: reportValue.target, protocol: reportValue.protocol, identity: reportValue.identity },
    completeness: reportValue.identity?.deviceString ? 'IDENTITY_ONLY' : null,
    status: reportValue.failure ? 'INCOMPLETE' : 'OBSERVATION_ONLY',
    restorableProject: false, blockArtifacts: [], report: artifact, rawFrames: frames,
    failures: reportValue.failure ? [reportValue.failure] : [],
    unavailable: ['Qualified program-block upload', 'Full-controller inventory', 'Independently verified restorable backup'],
  };
  const manifestBytes = Buffer.from(portableJSON(manifest));
  const manifestPath = join(root, `${manifest.createdAt.replace(/[:.]/g, '-')}-${sha256(manifestBytes).slice(0, 12)}-${randomUUID()}.json`);
  await writeFile(manifestPath, manifestBytes, { flag: 'wx', mode: 0o600 });
  return { manifestPath, manifest };
}