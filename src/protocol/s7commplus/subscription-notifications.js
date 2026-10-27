// @ts-check
import { decodeDataNotification, validateDataNotificationOwner, PlusError } from './codec.js';

/** @import { DataNotificationOwner } from './codec.js' */

export class DataNotificationBuffer {
  #owner;
  #queueSize;
  #maxBufferedBytes;
  /** @type {ReturnType<typeof decodeDataNotification>[]} */
  #queue = [];
  #bufferedBytes = 0;
  /** @type {number|null} */
  #lastSequence = null;
  #duplicates = 0;
  #outOfOrder = 0;
  #missedUpdates = 0;
  #droppedUpdates = 0;
  #discardedOnClose = 0;
  #requiresResynchronization = false;
  #closed = false;

  /** @param {DataNotificationOwner} owner @param {{queueSize?:number,maxBufferedBytes?:number}} [limits] */
  constructor(owner, limits = {}) {
    this.#owner = validateDataNotificationOwner(owner);
    const queueSize = limits.queueSize ?? 16;
    const maxBufferedBytes = limits.maxBufferedBytes ?? 1048576;
    if (!Number.isSafeInteger(queueSize) || queueSize < 1 || queueSize > 128
      || !Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < this.#owner.maxBytes || maxBufferedBytes > 16777216) {
      throw new PlusError('ARGUMENT', 'Notification queue requires 1..128 slots and a byte budget covering one bounded message, at most 16777216 bytes');
    }
    this.#queueSize = queueSize;
    this.#maxBufferedBytes = maxBufferedBytes;
  }

  /** @param {{version:number,body:Buffer}} message */
  push(message) {
    if (this.#closed) throw new PlusError('DISCONNECTED', 'Notification buffer is closed');
    const update = decodeDataNotification(message, this.#owner);
    if (this.#lastSequence !== null) {
      const distance = (update.sequenceNumber - this.#lastSequence + 0x100000000) % 0x100000000;
      if (distance === 0) { this.#duplicates++; return false; }
      if (distance >= 0x80000000) {
        this.#outOfOrder++;
        this.#requiresResynchronization = true;
        return false;
      }
      if (distance > 1) {
        this.#missedUpdates += distance - 1;
        this.#requiresResynchronization = true;
      }
    }
    this.#lastSequence = update.sequenceNumber;
    while (this.#queue.length >= this.#queueSize || this.#bufferedBytes + update.rawBody.length > this.#maxBufferedBytes) {
      const dropped = this.#queue.shift();
      if (!dropped) throw new PlusError('RESPONSE_LIMIT', 'Notification cannot fit the buffer byte budget');
      this.#bufferedBytes -= dropped.rawBody.length;
      this.#droppedUpdates++;
      this.#requiresResynchronization = true;
    }
    this.#queue.push(update);
    this.#bufferedBytes += update.rawBody.length;
    return true;
  }

  pop() {
    const update = this.#queue.shift();
    if (!update) return null;
    this.#bufferedBytes -= update.rawBody.length;
    return update;
  }

  close() {
    this.#discardedOnClose += this.#queue.length;
    this.#queue = [];
    this.#bufferedBytes = 0;
    this.#closed = true;
  }

  get diagnostics() {
    return { subscriptionRid: this.#owner.subscriptionRid, queuedUpdates: this.#queue.length,
      bufferedBytes: this.#bufferedBytes, lastSequence: this.#lastSequence,
      duplicates: this.#duplicates, outOfOrder: this.#outOfOrder, missedUpdates: this.#missedUpdates,
      droppedUpdates: this.#droppedUpdates, discardedOnClose: this.#discardedOnClose,
      requiresResynchronization: this.#requiresResynchronization, closed: this.#closed,
      sequenceSemantics: 'UINT32_MODULAR_REFERENCE_ASSUMPTION', baselineStatus: 'NOT_ESTABLISHED' };
  }
}

/** @typedef {{version:number,body:Buffer,receivedAtMonotonicMs?:number,fragmentCount?:number}} PlusIncomingMessage */

export class PlusReceiveRouter {
  /** @type {Map<number,{token:object,receive:(message:PlusIncomingMessage)=>void}>} */
  #owners = new Map();
  #closed = false;

  /** @param {number} rid @param {object} token @param {(message:PlusIncomingMessage)=>void} receive */
  register(rid, token, receive) {
    if (this.#closed) throw new PlusError('DISCONNECTED', 'Receive router is closed');
    if (!Number.isInteger(rid) || rid < 1 || rid > 0xFFFFFFFF || !token || typeof token !== 'object' || typeof receive !== 'function') {
      throw new PlusError('ARGUMENT', 'Expected a subscription RID, owner token and receiver');
    }
    if (this.#owners.has(rid)) throw new PlusError('CORRELATION', 'Subscription RID already belongs to this session');
    if (this.#owners.size >= 16) throw new PlusError('SESSION_LIMIT', 'Owned subscription routing budget exhausted');
    this.#owners.set(rid, { token, receive });
  }

  /** @param {number} rid @param {object} token */
  unregister(rid, token) {
    const owner = this.#owners.get(rid);
    if (!owner || owner.token !== token) throw new PlusError('CORRELATION', 'Subscription handle is not owned by this session');
    this.#owners.delete(rid);
  }

  /** @param {PlusIncomingMessage[]} messages @param {boolean} replyPending */
  route(messages, replyPending) {
    if (this.#closed) throw new PlusError('DISCONNECTED', 'Receive router is closed');
    /** @type {PlusIncomingMessage|null} */
    let reply = null;
    for (const message of messages) {
      if (message.body[0] === 0x33) {
        if (message.body.length < 5) throw new PlusError('MALFORMED_RESPONSE', 'Truncated notification owner');
        const owner = this.#owners.get(message.body.readUInt32BE(1));
        if (!owner) throw new PlusError('CORRELATION', 'Unowned data notification');
        owner.receive(message);
      } else {
        if (![0x32, 0x02].includes(message.body[0])) throw new PlusError('MALFORMED_RESPONSE', 'Unsupported incoming message family');
        if (!replyPending || reply) throw new PlusError('CORRELATION', 'Unexpected unsolicited or duplicate response');
        reply = message;
      }
    }
    return reply;
  }

  close() { this.#closed = true; this.#owners.clear(); }
}