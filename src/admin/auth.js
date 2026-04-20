// @ts-check
// Simple admin authentication — password hashing + in-memory sessions

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** @import { AdminStore } from './store.js' */

export class AdminAuth {
  /** @type {Map<string, { createdAt: number }>} */
  #sessions = new Map();
  /** @type {AdminStore} */
  #store;
  /** @type {number} */
  #sessionTtlMs;

  /**
   * @param {AdminStore} store
   * @param {{ sessionTtlMs?: number }} [opts]
   */
  constructor(store, opts) {
    this.#store = store;
    this.#sessionTtlMs = opts?.sessionTtlMs ?? 24 * 60 * 60 * 1000;
    this.#ensureDefaultPassword();
  }

  #ensureDefaultPassword() {
    if (!this.#store.getSetting('admin_password_hash')) {
      this.#store.setSetting('admin_password_hash', this.#hash('1234'));
    }
  }

  /** @param {string} value */
  #hash(value) {
    return createHash('sha256').update(String(value)).digest('hex');
  }

  /**
   * @param {string} password
   * @returns {boolean}
   */
  verify(password) {
    const stored = this.#store.getSetting('admin_password_hash');
    if (!stored) return false;
    const hashed = this.#hash(password);
    try {
      const a = Buffer.from(hashed, 'utf8');
      const b = Buffer.from(stored, 'utf8');
      return a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  /**
   * @param {string} password
   * @returns {string | null} session token or null
   */
  login(password) {
    if (!this.verify(password)) return null;
    const token = randomBytes(32).toString('hex');
    this.#sessions.set(token, { createdAt: Date.now() });
    this.#cleanup();
    return token;
  }

  /**
   * @param {string | null | undefined} token
   * @returns {boolean}
   */
  validate(token) {
    if (!token || typeof token !== 'string') return false;
    const session = this.#sessions.get(token);
    if (!session) return false;
    if (Date.now() - session.createdAt > this.#sessionTtlMs) {
      this.#sessions.delete(token);
      return false;
    }
    return true;
  }

  /** @param {string} token */
  logout(token) {
    this.#sessions.delete(token);
  }

  /**
   * @param {string} currentPassword
   * @param {string} newPassword
   * @returns {boolean}
   */
  changePassword(currentPassword, newPassword) {
    if (!this.verify(currentPassword)) return false;
    this.#store.setSetting('admin_password_hash', this.#hash(newPassword));
    this.#sessions.clear();
    return true;
  }

  #cleanup() {
    const now = Date.now();
    for (const [token, session] of this.#sessions) {
      if (now - session.createdAt > this.#sessionTtlMs) {
        this.#sessions.delete(token);
      }
    }
  }
}
