// @ts-check
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { SHA256 } from '@noble/hashes/sha256';
import { PlusError } from './codec.js';

class ContinuedSHA256 extends SHA256 {
  /** @param {Buffer} digest @param {Buffer} data @param {number} total */
  static resume(digest, data, total) {
    const hash = new ContinuedSHA256();
    hash.set(digest.readUInt32BE(0), digest.readUInt32BE(4), digest.readUInt32BE(8), digest.readUInt32BE(12),
      digest.readUInt32BE(16), digest.readUInt32BE(20), digest.readUInt32BE(24), digest.readUInt32BE(28));
    const bitLength = Buffer.alloc(8); bitLength.writeBigUInt64BE(BigInt(total) * 8n);
    const padding = (55 - data.length % 64 + 64) % 64;
    hash.update(Buffer.concat([data, Buffer.from([128]), Buffer.alloc(padding), bitLength]));
    const result = Buffer.alloc(32);
    hash.get().forEach((word, index) => result.writeUInt32BE(word >>> 0, index * 4));
    hash.destroy();
    return result;
  }
}

export class FragmentHMACVerifier {
  /** @type {Buffer|undefined} */
  #inner;
  /** @type {Buffer|undefined} */
  #outer;
  #innerCount = 64;
  #outerCount = 64;
  #last = Buffer.alloc(0);
  /** @type {'independent'|'legacy'|'feed-forward'|undefined} */
  #mode;
  /** @param {Buffer} key */
  constructor(key) {
    if (key.length !== 24) throw new PlusError('LEGACY_SESSION_KEY', 'Expected a 24-byte integrity key');
    this.key = key;
  }
  /** @param {Buffer} data */
  #hmac(data) { return createHmac('sha256', this.key).update(data).digest(); }
  /** @param {Buffer} protectedBytes */
  verify(protectedBytes) {
    if (protectedBytes.length < 33 || protectedBytes[0] !== 32) throw new PlusError('INTEGRITY_CHECK_FAILED', 'Malformed authenticated response');
    const received = protectedBytes.subarray(1, 33), data = protectedBytes.subarray(33);
    if (!this.#inner) {
      const expected = this.#hmac(data);
      if (!timingSafeEqual(received, expected)) throw new PlusError('INTEGRITY_CHECK_FAILED', 'PLC response HMAC verification failed');
      const ipad = Buffer.alloc(64, 0x36);
      for (let index = 0; index < 24; index++) ipad[index] ^= this.key[index];
      this.#inner = createHash('sha256').update(ipad).update(data).digest();
      this.#outer = expected;
      this.#innerCount += data.length; this.#outerCount += 32;
      this.#last = Buffer.from(received);
      return data;
    }
    if (this.#mode === 'independent' || this.#mode === 'feed-forward') {
      const expected = this.#hmac(this.#mode === 'independent' ? data : Buffer.concat([this.#last, data]));
      if (!timingSafeEqual(received, expected)) throw new PlusError('INTEGRITY_CHECK_FAILED', 'PLC continuation HMAC verification failed');
      this.#last = Buffer.from(received);
      return data;
    }
    const innerCount = this.#innerCount + data.length, outerCount = this.#outerCount + 32;
    const inner = ContinuedSHA256.resume(this.#inner, data, innerCount);
    const outer = ContinuedSHA256.resume(/** @type {Buffer} */ (this.#outer), inner, outerCount);
    if (this.#mode === 'legacy' || timingSafeEqual(received, outer)) {
      if (!timingSafeEqual(received, outer)) throw new PlusError('INTEGRITY_CHECK_FAILED', 'PLC legacy continuation HMAC verification failed');
      this.#mode = 'legacy'; this.#inner = inner; this.#outer = outer;
      this.#innerCount = innerCount; this.#outerCount = outerCount;
    } else if (timingSafeEqual(received, this.#hmac(data))) this.#mode = 'independent';
    else if (timingSafeEqual(received, this.#hmac(Buffer.concat([this.#last, data])))) this.#mode = 'feed-forward';
    else throw new PlusError('INTEGRITY_CHECK_FAILED', 'PLC continuation HMAC verification failed');
    this.#last = Buffer.from(received);
    return data;
  }
}