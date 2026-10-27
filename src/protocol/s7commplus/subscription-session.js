// @ts-check
import { performance } from 'node:perf_hooks';
import { PlusError, decodeDataNotification, validateDataNotificationOwner } from './codec.js';
import { DataNotificationBuffer, PlusReceiveRouter } from './subscription-notifications.js';

/** @import { DataNotificationOwner } from './codec.js' */
/** @import { PlusIncomingMessage } from './subscription-notifications.js' */
/** @typedef {{sessionRid:number,containerRid:number,subscriptionRid:number}} OwnedSubscriptionReceipt */
/** @typedef {{create:(request:{sessionRid:number,containerRid:number,referenceIds:number[],changeCounter:number,creditLimit:number},signal:AbortSignal)=>Promise<OwnedSubscriptionReceipt>,renew:(receipt:OwnedSubscriptionReceipt,creditLimit:number,signal:AbortSignal)=>Promise<void>,deleteOwned:(receipt:OwnedSubscriptionReceipt,signal:AbortSignal)=>Promise<void>,abort:()=>void}} SubscriptionLifecycleAdapter */
/** @typedef {{owner:DataNotificationOwner,receipt:OwnedSubscriptionReceipt,buffer:DataNotificationBuffer,state:'ACTIVE'|'DELETING'|'CLOSED',busy:boolean,creditLimit:number,lastCreditTick:number|null,createdAt:number,lastReceivedAt:number|null,discardedWhileClosing:number,cancelPromise?:Promise<void>}} OwnedEntry */

export class OwnedSubscriptionSession {
  #router = new PlusReceiveRouter();
  /** @type {Map<object,OwnedEntry>} */
  #entries = new Map();
  #abort = new AbortController();
  /** @type {'OPEN'|'CLOSING'|'CLOSED'|'ABORTED'} */
  #state = 'OPEN';
  #creating = 0;
  /** @type {Promise<void>|undefined} */
  #closePromise;
  /** @type {{operation:string,code:string}[]} */
  #failures = [];
  #sessionRid;
  #containerRid;
  #adapter;
  #clock;
  #lastNow = -Infinity;
  #timeoutMs;
  #staleAfterMs;

  /** @param {{sessionRid:number,containerRid:number,adapter:SubscriptionLifecycleAdapter,clock?:()=>number,requestTimeoutMs?:number,staleAfterMs?:number}} options */
  constructor(options) {
    for (const rid of [options.sessionRid, options.containerRid]) {
      if (!Number.isInteger(rid) || rid < 1 || rid > 0xFFFFFFFF) throw new PlusError('ARGUMENT', 'Expected owned session/container RIDs');
    }
    if (options.sessionRid === options.containerRid) throw new PlusError('ARGUMENT', 'Session and container must be distinct');
    for (const key of ['create', 'renew', 'deleteOwned', 'abort']) {
      if (typeof options.adapter?.[/** @type {keyof SubscriptionLifecycleAdapter} */ (key)] !== 'function') throw new PlusError('ARGUMENT', 'Complete offline lifecycle adapter required');
    }
    this.#sessionRid = options.sessionRid;
    this.#containerRid = options.containerRid;
    this.#adapter = Object.freeze({ create: options.adapter.create.bind(options.adapter), renew: options.adapter.renew.bind(options.adapter),
      deleteOwned: options.adapter.deleteOwned.bind(options.adapter), abort: options.adapter.abort.bind(options.adapter) });
    this.#clock = options.clock ?? (() => performance.now());
    this.#timeoutMs = options.requestTimeoutMs ?? 1000;
    this.#staleAfterMs = options.staleAfterMs ?? 3000;
    if (![this.#timeoutMs, this.#staleAfterMs].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 60000)) throw new PlusError('ARGUMENT', 'Lifecycle time budgets must be 1..60000 ms');
    this.#now();
  }

  /** @param {Omit<DataNotificationOwner,'subscriptionRid'>} selection @param {{credits?:number,queueSize?:number,signal?:AbortSignal}} [options] */
  async create(selection, options = {}) {
    this.#requireOpen();
    if (options.signal?.aborted) throw new PlusError('CANCELLED', 'Subscription creation cancelled before transmission');
    if (this.#entries.size + this.#creating >= 16) throw new PlusError('SESSION_LIMIT', 'At most 16 subscription handles per session generation');
    const credits = options.credits ?? 10;
    const queueSize = options.queueSize;
    this.#validateCredits(credits);
    const owner = validateDataNotificationOwner({ ...selection, subscriptionRid: 1 });
    new DataNotificationBuffer(owner, { queueSize });
    this.#creating++;
    try {
      const receipt = await this.#call(signal => this.#adapter.create({ sessionRid: this.#sessionRid, containerRid: this.#containerRid,
        referenceIds: [...owner.referenceIds], changeCounter: owner.changeCounter, creditLimit: credits }, signal), options.signal);
      this.#requireOpen();
      if (receipt.sessionRid !== this.#sessionRid || receipt.containerRid !== this.#containerRid
        || !Number.isInteger(receipt.subscriptionRid) || receipt.subscriptionRid < 1 || receipt.subscriptionRid > 0xFFFFFFFF
        || [this.#sessionRid, this.#containerRid].includes(receipt.subscriptionRid)
        || [...this.#entries.values()].some(entry => entry.receipt.subscriptionRid === receipt.subscriptionRid)) {
        throw new PlusError('CORRELATION', 'Creation did not return a unique child of the owned session/container');
      }
      const handle = Object.freeze({});
      owner.subscriptionRid = receipt.subscriptionRid;
      const entry = /** @type {OwnedEntry} */ ({ owner, receipt: Object.freeze({ sessionRid: receipt.sessionRid, containerRid: receipt.containerRid, subscriptionRid: receipt.subscriptionRid }),
        buffer: new DataNotificationBuffer(owner, { queueSize }), state: 'ACTIVE', busy: false,
        creditLimit: credits, lastCreditTick: null, createdAt: this.#now(), lastReceivedAt: null, discardedWhileClosing: 0 });
      this.#router.register(owner.subscriptionRid, handle, message => this.#receive(entry, message));
      this.#entries.set(handle, entry);
      return handle;
    } catch (error) { this.#fail('create', error); throw error; }
    finally { this.#creating--; }
  }

  /** @param {PlusIncomingMessage[]} messages @param {boolean} replyPending */
  route(messages, replyPending) {
    if (this.#state === 'CLOSED' || this.#state === 'ABORTED') throw new PlusError('DISCONNECTED', 'Subscription session is closed');
    try { return this.#router.route(messages, replyPending); }
    catch (error) { this.#fail('receive', error); throw error; }
  }

  /** @param {object} handle @param {number} credits */
  async renew(handle, credits) {
    this.#requireOpen();
    const entry = this.#entry(handle);
    this.#validateCredits(credits);
    if (entry.state !== 'ACTIVE' || entry.busy) throw new PlusError('CONCURRENCY_LIMIT', 'Subscription is closing or has a pending operation');
    if (entry.buffer.diagnostics.requiresResynchronization) throw new PlusError('RESYNC_REQUIRED', 'Lost delta continuity requires a new subscription');
    const creditLimit = entry.creditLimit + credits;
    if (creditLimit > 254) throw new PlusError('UNSUPPORTED_PROFILE', 'Credit rollover is not qualified; create a new subscription');
    entry.busy = true;
    try {
      await this.#call(signal => this.#adapter.renew(entry.receipt, creditLimit, signal));
      this.#requireOpen();
      entry.creditLimit = creditLimit;
    } catch (error) { this.#fail('renew', error); throw error; }
    finally { entry.busy = false; }
  }

  /** @param {object} handle */
  pop(handle) { return this.#entry(handle).buffer.pop(); }

  /** @param {object} handle */
  diagnostics(handle) {
    const entry = this.#entry(handle);
    const now = this.#now();
    const creditsRemaining = entry.creditLimit - (entry.lastCreditTick === null ? 0 : entry.lastCreditTick + 1);
    const buffer = entry.buffer.diagnostics;
    const freshness = entry.state !== 'ACTIVE' || this.#state !== 'OPEN' ? 'CLOSED'
      : buffer.requiresResynchronization ? 'RESYNC_REQUIRED' : creditsRemaining === 0 ? 'CREDIT_EXHAUSTED'
        : now - (entry.lastReceivedAt ?? entry.createdAt) >= this.#staleAfterMs ? 'STALE'
          : entry.lastReceivedAt === null ? 'AWAITING_INITIAL' : 'RECENT_DELTA_NOT_GOOD';
    return { ...buffer, state: entry.state, freshness, creditLimit: entry.creditLimit, creditsRemaining,
      lastCreditTick: entry.lastCreditTick, lastReceivedAtMonotonicMs: entry.lastReceivedAt,
      discardedWhileClosing: entry.discardedWhileClosing, quality: 'UNKNOWN',
      creditSemantics: 'ZERO_BASED_REFERENCE_TICKS_NO_ROLLOVER_UNQUALIFIED' };
  }

  /** @param {object} handle @returns {Promise<void>} */
  cancel(handle) {
    const entry = this.#entry(handle);
    if (entry.cancelPromise) return entry.cancelPromise;
    this.#requireOpen();
    if (entry.busy || entry.state !== 'ACTIVE') return Promise.reject(new PlusError('CONCURRENCY_LIMIT', 'Subscription has a pending operation'));
    entry.cancelPromise = this.#delete(handle, entry);
    return entry.cancelPromise;
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    if (this.#state === 'CLOSED' || this.#state === 'ABORTED') return Promise.resolve();
    if (this.#creating || [...this.#entries.values()].some(entry => entry.busy)) {
      this.abort();
      return Promise.resolve();
    }
    this.#state = 'CLOSING';
    for (const entry of this.#entries.values()) entry.buffer.close();
    this.#closePromise = (async () => {
      for (const [handle, entry] of this.#entries) {
        if (entry.cancelPromise) await entry.cancelPromise;
        else if (entry.state === 'ACTIVE') await this.#delete(handle, entry);
      }
      if (this.#state === 'ABORTED') return;
      this.#router.close();
      this.#state = 'CLOSED';
    })();
    return this.#closePromise;
  }

  abort() {
    if (this.#state === 'CLOSED' || this.#state === 'ABORTED') return;
    this.#state = 'ABORTED';
    this.#abort.abort();
    this.#router.close();
    for (const entry of this.#entries.values()) { entry.state = 'CLOSED'; entry.buffer.close(); }
    try { this.#adapter.abort(); }
    catch (error) { this.#recordFailure('abort', error); }
  }

  get report() { return { state: this.#state, sessionRid: this.#sessionRid, containerRid: this.#containerRid,
    handles: this.#entries.size, pendingCreations: this.#creating, failures: this.#failures.map(failure => ({ ...failure })), automaticRestore: false }; }

  /** @param {OwnedEntry} entry @param {PlusIncomingMessage} message */
  #receive(entry, message) {
    const update = decodeDataNotification(message, entry.owner);
    if (entry.state !== 'ACTIVE' || this.#state !== 'OPEN') { entry.discardedWhileClosing++; return; }
    if (!entry.buffer.push(message)) return;
    if (update.creditTick >= entry.creditLimit || (entry.lastCreditTick !== null && update.creditTick <= entry.lastCreditTick)) {
      throw new PlusError('CORRELATION', 'Notification exceeded the finite credit window or reordered its credit tick');
    }
    entry.lastCreditTick = update.creditTick;
    entry.lastReceivedAt = this.#now();
  }

  /** @param {object} handle @param {OwnedEntry} entry */
  async #delete(handle, entry) {
    entry.state = 'DELETING';
    entry.buffer.close();
    try {
      await this.#call(signal => this.#adapter.deleteOwned(entry.receipt, signal));
      if (this.#state === 'ABORTED') throw new PlusError('DISCONNECTED', 'Session aborted during cleanup');
      this.#router.unregister(entry.receipt.subscriptionRid, handle);
      entry.state = 'CLOSED';
    } catch (error) { this.#fail('deleteOwned', error); throw error; }
  }

  /** @template T @param {(signal:AbortSignal)=>Promise<T>} action @param {AbortSignal} [externalSignal] @returns {Promise<T>} */
  async #call(action, externalSignal) {
    const signal = externalSignal ? AbortSignal.any([this.#abort.signal, externalSignal]) : this.#abort.signal;
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timer;
    const cancelled = () => new PlusError('CANCELLED', 'Subscription operation cancelled; transport must be aborted');
    /** @type {()=>void} */
    let onAbort = () => {};
    try {
      return await Promise.race([
        Promise.resolve().then(() => { if (signal.aborted) throw cancelled(); return action(signal); }),
        new Promise((resolve, reject) => {
          onAbort = () => reject(cancelled());
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
          timer = setTimeout(() => reject(new PlusError('TIMEOUT', 'Subscription lifecycle operation timed out')), this.#timeoutMs);
        }),
      ]);
    } finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
  }

  #requireOpen() { if (this.#state !== 'OPEN') throw new PlusError('DISCONNECTED', 'Subscription session is not open'); }
  /** @param {object} handle */
  #entry(handle) { const entry = this.#entries.get(handle); if (!entry) throw new PlusError('CORRELATION', 'Foreign or previous-session subscription handle'); return entry; }
  /** @param {number} credits */
  #validateCredits(credits) { if (!Number.isSafeInteger(credits) || credits < 1 || credits > 254) throw new PlusError('ARGUMENT', 'Finite credits must be 1..254'); }
  #now() { const now = this.#clock(); if (!Number.isFinite(now) || now < this.#lastNow) throw new PlusError('ARGUMENT', 'Monotonic subscription clock required'); this.#lastNow = now; return now; }
  /** @param {string} operation @param {unknown} error */
  #recordFailure(operation, error) { if (this.#failures.length < 16) this.#failures.push({ operation, code: error instanceof PlusError ? error.code : 'ADAPTER_FAILURE' }); }
  /** @param {string} operation @param {unknown} error */
  #fail(operation, error) { this.#recordFailure(operation, error); this.abort(); }
}