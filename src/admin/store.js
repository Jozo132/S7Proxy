// @ts-check
// SQLite persistence layer for S7Proxy admin configuration and struct storage.
// Uses better-sqlite3 for synchronous, zero-dependency embedded database.

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** @import { S7StructDef } from '../protocol/db-struct.js' */
/** @import pino from 'pino' */

/**
 * @typedef {Object} StoredStruct
 * @property {string} name
 * @property {number} db
 * @property {number} offset
 * @property {string} items_json  - JSON-serialized S7StructItem[]
 * @property {string} [target_id]
 * @property {string} [description]
 * @property {string} [subscribe_mode]
 * @property {string} [subscribe_items_json]
 * @property {number} [subscribe_interval_ms]
 * @property {string} [subscribe_target_id]
 * @property {number} created_at
 * @property {number} updated_at
 */

/**
 * @typedef {Object} StoredTarget
 * @property {string} id
 * @property {string} primary_ip
 * @property {number} primary_rack
 * @property {number} primary_slot
 * @property {number} [primary_port]
 * @property {string} [backups_json]
 * @property {number} max_connections
 * @property {number} [request_timeout_ms]
 * @property {number} [keep_alive_interval_ms]
 * @property {string} [reconnect_backoff_json]
 * @property {number} created_at
 * @property {number} updated_at
 */

/**
 * @typedef {Object} StoredSetting
 * @property {string} key
 * @property {string} value
 * @property {number} updated_at
 */

export class AdminStore {
  /** @type {Database.Database} */
  #db;
  /** @type {pino.Logger | null} */
  #logger;

  /**
   * @param {string} dbPath  - Path to the SQLite database file
   * @param {pino.Logger} [logger]
   */
  constructor(dbPath, logger) {
    this.#logger = logger ?? null;

    // Ensure directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('foreign_keys = ON');
    this.#migrate();
    this.#logger?.info({ dbPath }, 'Admin store initialized');
  }

  // ─── Schema migration ───────────────────────────────────────────────────

  #migrate() {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS structs (
        name                  TEXT PRIMARY KEY,
        db                    INTEGER NOT NULL,
        "offset"              INTEGER NOT NULL DEFAULT 0,
        items_json            TEXT    NOT NULL,
        target_id             TEXT,
        description           TEXT,
        subscribe_mode        TEXT,
        subscribe_items_json  TEXT,
        subscribe_interval_ms INTEGER,
        subscribe_target_id   TEXT,
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS targets (
        id               TEXT PRIMARY KEY,
        primary_ip       TEXT    NOT NULL,
        primary_rack     INTEGER NOT NULL DEFAULT 0,
        primary_slot     INTEGER NOT NULL DEFAULT 1,
        primary_port     INTEGER,
        backups_json     TEXT,
        max_connections  INTEGER NOT NULL DEFAULT 4,
        request_timeout_ms INTEGER,
        keep_alive_interval_ms INTEGER,
        reconnect_backoff_json TEXT,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp  INTEGER NOT NULL,
        action     TEXT    NOT NULL,
        entity     TEXT,
        detail     TEXT
      );
    `);

    this.#ensureColumn('structs', 'target_id', 'TEXT');
    this.#ensureColumn('structs', 'subscribe_mode', 'TEXT');
    this.#ensureColumn('structs', 'subscribe_items_json', 'TEXT');
    this.#ensureColumn('targets', 'request_timeout_ms', 'INTEGER');
    this.#ensureColumn('targets', 'keep_alive_interval_ms', 'INTEGER');
    this.#ensureColumn('targets', 'reconnect_backoff_json', 'TEXT');
  }

  /**
   * @param {string} table
   * @param {string} column
   * @param {string} definition
   */
  #ensureColumn(table, column, definition) {
    const columns = /** @type {Array<{ name: string }>} */ (this.#db.prepare(`PRAGMA table_info(${table})`).all());
    if (!columns.some((c) => c.name === column)) {
      this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
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
    const stmt = this.#db.prepare(`
      INSERT INTO structs (
        name, db, "offset", items_json, target_id, description,
        subscribe_mode, subscribe_items_json, subscribe_interval_ms, subscribe_target_id,
        created_at, updated_at
      )
      VALUES (
        @name, @db, @offset, @items_json, @target_id, @description,
        @subscribe_mode, @subscribe_items_json, @subscribe_interval_ms, @subscribe_target_id,
        @now, @now
      )
      ON CONFLICT(name) DO UPDATE SET
        db = @db,
        "offset" = @offset,
        items_json = @items_json,
        target_id = @target_id,
        description = @description,
        subscribe_mode = @subscribe_mode,
        subscribe_items_json = @subscribe_items_json,
        subscribe_interval_ms = @subscribe_interval_ms,
        subscribe_target_id = @subscribe_target_id,
        updated_at = @now
    `);
    const subscribeMode = opts?.subscribeMode ?? (opts?.subscribeIntervalMs ? 'struct' : 'none');
    const subscribeTargetId = opts?.subscribeTargetId ?? opts?.targetId ?? null;
    stmt.run({
      name: def.name,
      db: def.db,
      offset: def.offset ?? 0,
      items_json: JSON.stringify(def.items),
      target_id: opts?.targetId ?? null,
      description: opts?.description ?? null,
      subscribe_mode: subscribeMode,
      subscribe_items_json: opts?.subscribeItems?.length ? JSON.stringify(opts.subscribeItems) : null,
      subscribe_interval_ms: opts?.subscribeIntervalMs ?? null,
      subscribe_target_id: subscribeTargetId,
      now,
    });
    this.#audit('struct:save', def.name, `DB${def.db} offset=${def.offset ?? 0} target=${opts?.targetId ?? 'unassigned'}`);
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
    const rows = /** @type {StoredStruct[]} */ (this.#db.prepare('SELECT * FROM structs ORDER BY name').all());
    return rows.map((r) => ({
      name: r.name,
      db: r.db,
      offset: r.offset,
      items: JSON.parse(r.items_json),
      targetId: r.target_id ?? r.subscribe_target_id ?? undefined,
      description: r.description ?? undefined,
      subscribeMode: /** @type {'none' | 'struct' | 'items' | undefined} */ (r.subscribe_mode ?? (r.subscribe_interval_ms ? 'struct' : 'none')),
      subscribeItems: r.subscribe_items_json ? JSON.parse(r.subscribe_items_json) : undefined,
      subscribeIntervalMs: r.subscribe_interval_ms ?? undefined,
      subscribeTargetId: r.subscribe_target_id ?? undefined,
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
    const r = /** @type {StoredStruct | undefined} */ (this.#db.prepare('SELECT * FROM structs WHERE name = ?').get(name));
    if (!r) return undefined;
    return {
      name: r.name,
      db: r.db,
      offset: r.offset,
      items: JSON.parse(r.items_json),
      targetId: r.target_id ?? r.subscribe_target_id ?? undefined,
      description: r.description ?? undefined,
      subscribeMode: /** @type {'none' | 'struct' | 'items' | undefined} */ (r.subscribe_mode ?? (r.subscribe_interval_ms ? 'struct' : 'none')),
      subscribeItems: r.subscribe_items_json ? JSON.parse(r.subscribe_items_json) : undefined,
      subscribeIntervalMs: r.subscribe_interval_ms ?? undefined,
      subscribeTargetId: r.subscribe_target_id ?? undefined,
    };
  }

  /**
   * Delete a struct definition.
   * @param {string} name
   * @returns {boolean}
   */
  deleteStruct(name) {
    const result = this.#db.prepare('DELETE FROM structs WHERE name = ?').run(name);
    if (result.changes > 0) this.#audit('struct:delete', name);
    return result.changes > 0;
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
    this.#db.prepare(`
      INSERT INTO targets (
        id, primary_ip, primary_rack, primary_slot, primary_port, backups_json,
        max_connections, request_timeout_ms, keep_alive_interval_ms, reconnect_backoff_json,
        created_at, updated_at
      )
      VALUES (
        @id, @ip, @rack, @slot, @port, @backups,
        @maxConn, @requestTimeoutMs, @keepAliveIntervalMs, @reconnectBackoffJson,
        @now, @now
      )
      ON CONFLICT(id) DO UPDATE SET
        primary_ip = @ip, primary_rack = @rack, primary_slot = @slot, primary_port = @port,
        backups_json = @backups,
        max_connections = @maxConn,
        request_timeout_ms = @requestTimeoutMs,
        keep_alive_interval_ms = @keepAliveIntervalMs,
        reconnect_backoff_json = @reconnectBackoffJson,
        updated_at = @now
    `).run({
      id: target.id,
      ip: target.primary.ip,
      rack: target.primary.rack,
      slot: target.primary.slot,
      port: target.primary.port ?? null,
      backups: target.backups ? JSON.stringify(target.backups) : null,
      maxConn: target.maxConnections ?? 4,
      requestTimeoutMs: target.requestTimeoutMs ?? null,
      keepAliveIntervalMs: target.keepAliveIntervalMs ?? null,
      reconnectBackoffJson: target.reconnectBackoffMs?.length ? JSON.stringify(target.reconnectBackoffMs) : null,
      now,
    });
    this.#audit('target:save', target.id, target.primary.ip);
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
    const rows = /** @type {StoredTarget[]} */ (this.#db.prepare('SELECT * FROM targets ORDER BY id').all());
    return rows.map((r) => ({
      id: r.id,
      primary: { ip: r.primary_ip, rack: r.primary_rack, slot: r.primary_slot, ...(r.primary_port ? { port: r.primary_port } : {}) },
      ...(r.backups_json ? { backups: JSON.parse(r.backups_json) } : {}),
      maxConnections: r.max_connections,
      ...(r.request_timeout_ms != null ? { requestTimeoutMs: r.request_timeout_ms } : {}),
      ...(r.keep_alive_interval_ms != null ? { keepAliveIntervalMs: r.keep_alive_interval_ms } : {}),
      ...(r.reconnect_backoff_json ? { reconnectBackoffMs: JSON.parse(r.reconnect_backoff_json) } : {}),
    }));
  }

  /**
   * Delete a target.
   * @param {string} id
   * @returns {boolean}
   */
  deleteTarget(id) {
    const result = this.#db.prepare('DELETE FROM targets WHERE id = ?').run(id);
    if (result.changes > 0) this.#audit('target:delete', id);
    return result.changes > 0;
  }

  // ─── Settings ───────────────────────────────────────────────────────────

  /**
   * @param {string} key
   * @param {string} value
   */
  setSetting(key, value) {
    const now = Date.now();
    this.#db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (@key, @value, @now)
      ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = @now
    `).run({ key, value, now });
  }

  /**
   * @param {string} key
   * @param {string} [defaultValue]
   * @returns {string | undefined}
   */
  getSetting(key, defaultValue) {
    const row = /** @type {{ value: string } | undefined} */ (this.#db.prepare('SELECT value FROM settings WHERE key = ?').get(key));
    return row?.value ?? defaultValue;
  }

  /**
   * @returns {Record<string, string>}
   */
  getAllSettings() {
    const rows = /** @type {{ key: string, value: string }[]} */ (this.#db.prepare('SELECT key, value FROM settings').all());
    /** @type {Record<string, string>} */
    const out = {};
    for (const r of rows) out[r.key] = r.value;
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
  }

  // ─── Audit log ──────────────────────────────────────────────────────────

  /**
   * @param {string} action
   * @param {string} [entity]
   * @param {string} [detail]
   */
  #audit(action, entity, detail) {
    this.#db.prepare(
      'INSERT INTO audit_log (timestamp, action, entity, detail) VALUES (?, ?, ?, ?)',
    ).run(Date.now(), action, entity ?? null, detail ?? null);
  }

  /**
   * Get recent audit log entries.
   * @param {number} [limit]
   * @returns {Array<{ id: number, timestamp: number, action: string, entity: string | null, detail: string | null }>}
   */
  getAuditLog(limit = 100) {
    return /** @type {any[]} */ (this.#db.prepare(
      'SELECT * FROM audit_log ORDER BY id DESC LIMIT ?',
    ).all(limit));
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  close() {
    this.#db.close();
  }
}
