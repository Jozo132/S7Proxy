// @ts-check
// JSON persistence layer for S7Proxy admin configuration and struct storage.
// Uses a small file-backed store to keep the package portable and dependency-light.

import { existsSync, mkdirSync, readFileSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';

/** @import { S7StructDef } from '../protocol/db-struct.js' */
/** @import { Logger } from '../logging/logger.js' */

/**
 * @typedef {Object} StoredStruct
 * @property {string} name
 * @property {number} db
 * @property {number} offset
 * @property {import('../protocol/db-struct.js').S7StructItem[]} items
 * @property {string} [targetId]
 * @property {string} [description]
 * @property {'none' | 'struct' | 'items'} [subscribeMode]
 * @property {string[]} [subscribeItems]
 * @property {number} [subscribeIntervalMs]
 * @property {string} [subscribeTargetId]
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} StoredTarget
 * @property {string} id
 * @property {{ ip: string, rack: number, slot: number, port?: number }} primary
 * @property {Array<{ ip: string, rack: number, slot: number, port?: number }>} [backups]
 * @property {number} maxConnections
 * @property {number} [requestTimeoutMs]
 * @property {number} [keepAliveIntervalMs]
 * @property {number[]} [reconnectBackoffMs]
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} StoredSetting
 * @property {string} value
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} AuditEntry
 * @property {number} id
 * @property {number} timestamp
 * @property {string} action
 * @property {string | null} entity
 * @property {string | null} detail
 */

/**
 * @typedef {Object} StoreData
 * @property {number} schemaVersion
 * @property {Record<string, StoredStruct>} structs
 * @property {Record<string, StoredTarget>} targets
 * @property {Record<string, StoredSetting>} settings
 * @property {AuditEntry[]} auditLog
 * @property {number} nextAuditId
 */

const STORE_SCHEMA_VERSION = 1;

/** @returns {StoreData} */
function createEmptyStoreData() {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    structs: {},
    targets: {},
    settings: {},
    auditLog: [],
    nextAuditId: 1,
  };
}

/**
 * @param {string} persistencePath
 * @returns {string}
 */
function resolveStorePath(persistencePath) {
  const absolutePath = resolve(persistencePath);
  if (extname(absolutePath).toLowerCase() === '.json') return absolutePath;

  const dir = dirname(absolutePath);
  const stem = basename(absolutePath, extname(absolutePath)) || 's7proxy';
  return join(dir, `${stem}.json`);
}

/**
 * @param {StoreData} data
 * @returns {StoreData}
 */
function normalizeStoreData(data) {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    structs: data.structs && typeof data.structs === 'object' ? data.structs : {},
    targets: data.targets && typeof data.targets === 'object' ? data.targets : {},
    settings: data.settings && typeof data.settings === 'object' ? data.settings : {},
    auditLog: Array.isArray(data.auditLog) ? data.auditLog : [],
    nextAuditId: Number.isSafeInteger(data.nextAuditId) && data.nextAuditId > 0
      ? data.nextAuditId
      : ((Array.isArray(data.auditLog) && data.auditLog.length > 0)
        ? Math.max(...data.auditLog.map((entry) => Number.isSafeInteger(entry.id) ? entry.id : 0)) + 1
        : 1),
  };
}

export class AdminStore {
  /** @type {string} */
  #filePath;
  /** @type {StoreData} */
  #data;
  /** @type {Logger | null} */
  #logger;

  /**
   * @param {string} persistencePath  - Path to the JSON store file, or a legacy .db-style path whose basename will be converted to .json
   * @param {Logger} [logger]
   */
  constructor(persistencePath, logger) {
    this.#logger = logger ?? null;
    this.#filePath = resolveStorePath(persistencePath);

    // Ensure directory exists
    const dir = dirname(this.#filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.#data = this.#load();
    this.#logger?.info({ filePath: this.#filePath }, 'Admin store initialized');
  }

  /**
   * @returns {StoreData}
   */
  #load() {
    if (!existsSync(this.#filePath)) return createEmptyStoreData();

    const raw = readFileSync(this.#filePath, 'utf8').trim();
    if (!raw) return createEmptyStoreData();

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`Invalid admin store file: ${this.#filePath}`);
    }
    return normalizeStoreData(/** @type {StoreData} */ (parsed));
  }

  #save() {
    const tempPath = `${this.#filePath}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(this.#data, null, 2)}\n`, 'utf8');
    rmSync(this.#filePath, { force: true });
    renameSync(tempPath, this.#filePath);
  }

  // ─── Structs ────────────────────────────────────────────────────────────

  /**
   * Save (upsert) a struct definition.
   * @param {S7StructDef} def
   * @param {{
   *   targetId?: string,
   *   description?: string,
   *   subscribeMode?: 'none' | 'struct' | 'items',
   *   subscribeItems?: string[],
   *   subscribeIntervalMs?: number,
   *   subscribeTargetId?: string,
   * }} [opts]
   */
  saveStruct(def, opts) {
    const now = Date.now();
    const subscribeMode = opts?.subscribeMode ?? (opts?.subscribeIntervalMs ? 'struct' : 'none');
    const subscribeTargetId = opts?.subscribeTargetId ?? opts?.targetId ?? null;
    const existing = this.#data.structs[def.name];
    this.#data.structs[def.name] = {
      name: def.name,
      db: def.db,
      offset: def.offset ?? 0,
      items: JSON.parse(JSON.stringify(def.items)),
      targetId: opts?.targetId ?? undefined,
      description: opts?.description ?? undefined,
      subscribeMode,
      subscribeItems: opts?.subscribeItems?.length ? [...opts.subscribeItems] : undefined,
      subscribeIntervalMs: opts?.subscribeIntervalMs ?? undefined,
      subscribeTargetId: subscribeTargetId ?? undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.#audit('struct:save', def.name, `DB${def.db} offset=${def.offset ?? 0} target=${opts?.targetId ?? 'unassigned'}`);
    this.#save();
  }

  /**
   * Load all struct definitions from the database.
   * @returns {Array<S7StructDef & {
   *   targetId?: string,
   *   description?: string,
   *   subscribeMode?: 'none' | 'struct' | 'items',
   *   subscribeItems?: string[],
   *   subscribeIntervalMs?: number,
   *   subscribeTargetId?: string,
   * }>}
   */
  loadStructs() {
    return Object.values(this.#data.structs)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((r) => ({
      name: r.name,
      db: r.db,
      offset: r.offset,
      items: JSON.parse(JSON.stringify(r.items)),
      targetId: r.targetId ?? r.subscribeTargetId ?? undefined,
      description: r.description ?? undefined,
      subscribeMode: /** @type {'none' | 'struct' | 'items' | undefined} */ (r.subscribeMode ?? (r.subscribeIntervalMs ? 'struct' : 'none')),
      subscribeItems: r.subscribeItems ? [...r.subscribeItems] : undefined,
      subscribeIntervalMs: r.subscribeIntervalMs ?? undefined,
      subscribeTargetId: r.subscribeTargetId ?? undefined,
    }));
  }

  /**
   * Get a single struct by name.
   * @param {string} name
   * @returns {(S7StructDef & {
   *   targetId?: string,
   *   description?: string,
   *   subscribeMode?: 'none' | 'struct' | 'items',
   *   subscribeItems?: string[],
   *   subscribeIntervalMs?: number,
   *   subscribeTargetId?: string,
   * }) | undefined}
   */
  getStruct(name) {
    const r = this.#data.structs[name];
    if (!r) return undefined;
    return {
      name: r.name,
      db: r.db,
      offset: r.offset,
      items: JSON.parse(JSON.stringify(r.items)),
      targetId: r.targetId ?? r.subscribeTargetId ?? undefined,
      description: r.description ?? undefined,
      subscribeMode: /** @type {'none' | 'struct' | 'items' | undefined} */ (r.subscribeMode ?? (r.subscribeIntervalMs ? 'struct' : 'none')),
      subscribeItems: r.subscribeItems ? [...r.subscribeItems] : undefined,
      subscribeIntervalMs: r.subscribeIntervalMs ?? undefined,
      subscribeTargetId: r.subscribeTargetId ?? undefined,
    };
  }

  /**
   * Delete a struct definition.
   * @param {string} name
   * @returns {boolean}
   */
  deleteStruct(name) {
    if (!(name in this.#data.structs)) return false;
    delete this.#data.structs[name];
    this.#audit('struct:delete', name);
    this.#save();
    return true;
  }

  // ─── Targets ────────────────────────────────────────────────────────────

  /**
   * Save (upsert) a target definition.
   * @param {{
   *   id: string,
   *   primary: { ip: string, rack: number, slot: number, port?: number },
   *   backups?: Array<{ ip: string, rack: number, slot: number, port?: number }>,
   *   maxConnections?: number,
   *   requestTimeoutMs?: number,
   *   keepAliveIntervalMs?: number,
   *   reconnectBackoffMs?: number[],
   * }} target
   */
  saveTarget(target) {
    const now = Date.now();
    const existing = this.#data.targets[target.id];
    this.#data.targets[target.id] = {
      id: target.id,
      primary: { ...target.primary },
      backups: target.backups?.map((backup) => ({ ...backup })),
      maxConnections: target.maxConnections ?? 4,
      requestTimeoutMs: target.requestTimeoutMs ?? undefined,
      keepAliveIntervalMs: target.keepAliveIntervalMs ?? undefined,
      reconnectBackoffMs: target.reconnectBackoffMs?.length ? [...target.reconnectBackoffMs] : undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.#audit('target:save', target.id, target.primary.ip);
    this.#save();
  }

  /**
   * Load all target definitions.
   * @returns {Array<{
   *   id: string,
   *   primary: { ip: string, rack: number, slot: number, port?: number },
   *   backups?: Array<{ ip: string, rack: number, slot: number, port?: number }>,
   *   maxConnections: number,
   *   requestTimeoutMs?: number,
   *   keepAliveIntervalMs?: number,
   *   reconnectBackoffMs?: number[],
   * }>}
   */
  loadTargets() {
    return Object.values(this.#data.targets)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => ({
      id: r.id,
      primary: { ...r.primary },
      ...(r.backups ? { backups: r.backups.map((backup) => ({ ...backup })) } : {}),
      maxConnections: r.maxConnections,
      ...(r.requestTimeoutMs != null ? { requestTimeoutMs: r.requestTimeoutMs } : {}),
      ...(r.keepAliveIntervalMs != null ? { keepAliveIntervalMs: r.keepAliveIntervalMs } : {}),
      ...(r.reconnectBackoffMs ? { reconnectBackoffMs: [...r.reconnectBackoffMs] } : {}),
    }));
  }

  /**
   * Delete a target.
   * @param {string} id
   * @returns {boolean}
   */
  deleteTarget(id) {
    if (!(id in this.#data.targets)) return false;
    delete this.#data.targets[id];
    this.#audit('target:delete', id);
    this.#save();
    return true;
  }

  // ─── Settings ───────────────────────────────────────────────────────────

  /**
   * @param {string} key
   * @param {string} value
   */
  setSetting(key, value) {
    const now = Date.now();
    this.#data.settings[key] = { value, updatedAt: now };
    this.#save();
  }

  /**
   * @param {string} key
   * @param {string} [defaultValue]
   * @returns {string | undefined}
   */
  getSetting(key, defaultValue) {
    const row = this.#data.settings[key];
    return row?.value ?? defaultValue;
  }

  /**
   * @returns {Record<string, string>}
   */
  getAllSettings() {
    /** @type {Record<string, string>} */
    const out = {};
    for (const [key, setting] of Object.entries(this.#data.settings)) out[key] = setting.value;
    return out;
  }

  /** @returns {string[]} */
  getDisabledTargets() {
    const raw = this.getSetting('disabledTargets', '[]');
    try {
      const parsed = JSON.parse(raw ?? '[]');
      return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
    } catch {
      return [];
    }
  }

  /**
   * @param {string} targetId
   * @param {boolean} disabled
   */
  setTargetDisabled(targetId, disabled) {
    const current = new Set(this.getDisabledTargets());
    if (disabled) current.add(targetId);
    else current.delete(targetId);
    this.setSetting('disabledTargets', JSON.stringify([...current]));
    this.#audit(disabled ? 'target:disable' : 'target:enable', targetId);
    this.#save();
  }

  // ─── Audit log ──────────────────────────────────────────────────────────

  /**
   * @param {string} action
   * @param {string} [entity]
   * @param {string} [detail]
   */
  #audit(action, entity, detail) {
    this.#data.auditLog.push({
      id: this.#data.nextAuditId++,
      timestamp: Date.now(),
      action,
      entity: entity ?? null,
      detail: detail ?? null,
    });
  }

  /**
   * Get recent audit log entries.
   * @param {number} [limit]
   * @returns {Array<{ id: number, timestamp: number, action: string, entity: string | null, detail: string | null }>}
   */
  getAuditLog(limit = 100) {
    return [...this.#data.auditLog]
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .map((entry) => ({ ...entry }));
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  close() {
    this.#save();
  }
}
