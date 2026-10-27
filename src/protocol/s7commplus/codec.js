// @ts-check
import { getOperationPolicy, BLOCK_CONTENT_ATTRIBUTES } from './operation-policy.js';
import { createHmac } from 'node:crypto';
import { FragmentHMACVerifier } from './fragment-hmac.js';
export class PlusError extends Error {
  /** @param {string} code @param {string} message @param {Record<string,unknown>} [details] */
  constructor(code, message, details = {}) { super(message); this.name = 'PlusError'; this.code = code; this.details = details; }
}

export const PLUS_FUNCTION = Object.freeze({
  explore: 0x04BB, readBlockContent: 0x04BB, createSession: 0x04CA, setupSession: 0x0542,
  read: 0x054C, readAttribute: 0x0586, initSSL: 0x05B3, activateSession: 0x04F2,
});

/** @param {number} value */
export function u32(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xFFFFFFFF) throw new PlusError('ARGUMENT', 'Expected UInt32');
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

/** @param {number} value */
export function vlq(value) {
  u32(value);
  const bytes = [value & 0x7F];
  while ((value = Math.floor(value / 128)) > 0) bytes.unshift((value & 0x7F) | 0x80);
  return Buffer.from(bytes);
}

export class Cursor {
  offset = 0;
  /** @param {Buffer} bytes */
  constructor(bytes) { this.bytes = bytes; }
  /** @param {number} count */
  take(count) {
    if (!Number.isSafeInteger(count) || count < 0 || count > this.bytes.length - this.offset) {
      throw new PlusError('MALFORMED_RESPONSE', 'Truncated or oversized field');
    }
    const result = this.bytes.subarray(this.offset, this.offset + count);
    this.offset += count;
    return result;
  }
  byte() { return this.take(1)[0]; }
  uint32() { return this.take(4).readUInt32BE(); }
  /** @param {32 | 64} [bits] @param {boolean} [signed] */
  integer(bits = 32, signed = false) {
    let value = 0n;
    const groups = bits === 64 ? 8 : 5;
    for (let index = 0; index < groups; index++) {
      const octet = this.byte();
      if (index === 0 && signed && (octet & 0x40)) value = -1n;
      value = (value << 7n) | BigInt(octet & 0x7F);
      if (!(octet & 0x80)) return this.#range(value, bits, signed);
    }
    if (bits === 64) return this.#range((value << 8n) | BigInt(this.byte()), bits, signed);
    throw new PlusError('MALFORMED_RESPONSE', 'Unterminated UInt32 VLQ');
  }
  /** @param {bigint} value @param {number} bits @param {boolean} signed */
  #range(value, bits, signed) {
    const upper = 1n << BigInt(signed ? bits - 1 : bits);
    if (value >= upper || value < (signed ? -upper : 0n)) throw new PlusError('MALFORMED_RESPONSE', 'VLQ overflow');
    return value;
  }
  uint() { return Number(this.integer()); }
}

/** @typedef {{flags:number, datatype:number, value:any, raw:Buffer, structId?:number, blobRootId?:number,blobLength?:number}} PlusValue */

/** @param {Cursor} cursor @param {number} [depth] @returns {PlusValue} */
export function decodeValue(cursor, depth = 0) {
  if (depth > 16) throw new PlusError('RESPONSE_LIMIT', 'Value nesting exceeds 16');
  const start = cursor.offset;
  const flags = cursor.byte();
  const datatype = cursor.byte();
  if (![0, 0x10, 0x20, 0x40].includes(flags)) throw new PlusError('UNSUPPORTED_DECODING', `PValue flags 0x${flags.toString(16)}`);
  /** @type {PlusValue} */
  const result = { flags, datatype, value: null, raw: Buffer.alloc(0) };
  if (flags === 0x40) {
    if (datatype !== 20) throw new PlusError('UNSUPPORTED_DECODING', 'Only sparse BLOB values are qualified');
    const entries = [];
    const keys = new Set();
    for (let key = cursor.uint(); key !== 0; key = cursor.uint()) {
      if (entries.length >= 4096) throw new PlusError('RESPONSE_LIMIT', 'Sparse BLOB entry budget exceeded');
      if (keys.has(key)) throw new PlusError('MALFORMED_RESPONSE', 'Repeated sparse BLOB key');
      keys.add(key);
      const blobRootId = cursor.uint();
      const byteCount = cursor.uint();
      entries.push({ key, blobRootId, byteCount, bytes: Buffer.from(cursor.take(byteCount)) });
    }
    result.value = entries;
  } else if (flags) {
    const count = cursor.uint();
    if (count > 4096) throw new PlusError('RESPONSE_LIMIT', 'Array exceeds 4096 elements');
    result.value = Array.from({ length: count }, () => scalar(datatype));
  } else result.value = scalar(datatype);
  result.raw = Buffer.from(cursor.bytes.subarray(start, cursor.offset));
  return result;

  /** @param {number} type @returns {any} */
  function scalar(type) {
    switch (type) {
      case 0: return null;
      case 1: {
        const value = cursor.byte();
        if (value > 1) throw new PlusError('MALFORMED_RESPONSE', 'Invalid BOOL');
        return value === 1;
      }
      case 2: case 10: return cursor.byte();
      case 3: case 11: return cursor.take(2).readUInt16BE();
      case 4: case 19: return cursor.uint();
      case 5: return cursor.integer(64).toString();
      case 6: return cursor.take(1).readInt8();
      case 7: return cursor.take(2).readInt16BE();
      case 8: return Number(cursor.integer(32, true));
      case 9: case 17: return cursor.integer(64, true).toString();
      case 12: case 18: return cursor.uint32();
      case 13: case 16: return cursor.take(8).readBigUInt64BE().toString();
      case 14: return cursor.take(4).readFloatBE();
      case 15: return cursor.take(8).readDoubleBE();
      case 20:
        result.blobRootId = cursor.uint();
        if (result.blobRootId > 1) throw new PlusError('UNSUPPORTED_DECODING', 'Extended BLOB headers are not qualified');
        result.blobLength = cursor.uint();
        return Buffer.from(cursor.take(result.blobLength));
      case 21: return new TextDecoder('utf-8', { fatal: true }).decode(cursor.take(cursor.uint()));
      case 25: return cursor.take(cursor.uint()).toString('latin1');
      case 23: {
        result.structId = cursor.uint32();
        if ((result.structId >>> 28) === 9 || (result.structId >>> 24) === 2) {
          throw new PlusError('UNSUPPORTED_DECODING', 'Packed struct requires independently retrieved type layout');
        }
        /** @type {{id:number, value:PlusValue}[]} */
        const members = [];
        for (let count = 0; count <= 4096; count++) {
          const id = cursor.uint();
          if (!id) return members;
          if (count === 4096) throw new PlusError('RESPONSE_LIMIT', 'Struct member limit');
          members.push({ id, value: decodeValue(cursor, depth + 1) });
        }
        throw new PlusError('RESPONSE_LIMIT', 'Struct member limit');
      }
      default: throw new PlusError('UNSUPPORTED_DECODING', `PValue datatype 0x${type.toString(16)}`);
    }
  }
}

/** @param {number} version */
export function qualifier(version) {
  return Buffer.concat([
    u32(1256), vlq(1257), Buffer.from([0, 18]), u32(0),
    vlq(1258), Buffer.from([0, 19, 0]), vlq(1259), Buffer.from([0, 4]),
    version === 1 ? u32(0) : Buffer.from([0, 0]),
  ]);
}

/** @param {number} id @param {string} text */
function stringAttribute(id, text) {
  const bytes = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from([0xA3]), vlq(id), Buffer.from([0, 21]), vlq(bytes.length), bytes]);
}

export function createSessionPayload() {
  return Buffer.concat([
    u32(285), Buffer.from([0, 4, 0]), u32(0), Buffer.from([0xA1]), u32(211), vlq(287), Buffer.from([0, 0]),
    stringAttribute(233, 'S7Proxy'), stringAttribute(289, '1:::6.0::S7Proxy'),
    stringAttribute(296, 'S7Proxy'), stringAttribute(297, ''), stringAttribute(298, 'S7Proxy'),
    Buffer.from([0xA3]), vlq(299), Buffer.from([0, 4, 1, 0xA3]), vlq(300), Buffer.from([0, 18]), u32(0x80C3C901),
    stringAttribute(301, ''), Buffer.from([0xA1]), u32(211), vlq(255), Buffer.from([0, 0]),
    stringAttribute(233, 'SubscriptionContainer'), Buffer.from([0xA2, 0xA2]), u32(0),
  ]);
}

/** @typedef {{kind:string, objectId?:number, attributes?:number[], recursive?:boolean, accessArea?:number, lids?:number[], symbolCrc?:number, attribute?:number, maxItems?:number, items?:{accessArea:number,lids:number[],symbolCrc?:number}[]}} PlusOperation */
/** @typedef {{sessionId:number, version:number, serverVersion?:Buffer, integrityId?:number, securityKey?:Buffer, sessionKey?:Buffer, sequence?:number}} PlusContext */

/** @param {{accessArea:number,lids:number[],symbolCrc?:number}} item */
function encodeReadAddress(item) {
  if (!item.lids.length || item.lids.length > 16) throw new PlusError('REQUEST_LIMIT', 'LID path requires 1..16 elements');
  return Buffer.concat([vlq(item.symbolCrc ?? 0), vlq(item.accessArea), vlq(1 + item.lids.length),
    vlq(item.accessArea >= 0x8A0E0000 ? 2550 : 3736), ...item.lids.map(vlq)]);
}

/** @param {{accessArea:number,lids:number[],symbolCrc?:number}[]} items @param {number[]} valueSizes @param {PlusContext} context @param {{maxRequestBytes:number,maxResponseBytes:number,maxItems?:number}} limits */
export function planReadBatches(items, valueSizes, context, limits) {
  const maxItems = limits.maxItems ?? 32;
  if (!items.length || items.length !== valueSizes.length || valueSizes.some(size => !Number.isSafeInteger(size) || size < 1)
    || !Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 64
    || !Number.isSafeInteger(limits.maxRequestBytes) || limits.maxRequestBytes < 1 || limits.maxRequestBytes > 900
    || !Number.isSafeInteger(limits.maxResponseBytes) || limits.maxResponseBytes < 1) {
    throw new PlusError('ARGUMENT', 'Expected symbolic addresses, scalar value sizes and positive byte budgets');
  }
  const overhead = 8 + 14 + (context.sessionKey ? 33 : 0) + 4
    + qualifier(context.sessionKey ? 2 : context.version).length + 4
    + (context.sessionKey || context.integrityId !== undefined ? 5 : 0);
  const responseOverhead = 128;
  /** @type {number[][]} */
  const batches = [];
  /** @type {number[]} */
  let batch = [];
  let addressBytes = 0, fields = 0, responseBytes = responseOverhead;
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const size = encodeReadAddress(item).length;
    const itemFields = 4 + item.lids.length;
    const valueBytes = 1 + valueSizes[index];
    const requestSize = () => overhead + vlq(batch.length + 1).length + vlq(fields + itemFields).length + addressBytes + size;
    if (batch.length && (batch.length === maxItems || requestSize() > limits.maxRequestBytes || responseBytes + valueBytes > limits.maxResponseBytes)) {
      batches.push(batch); batch = []; addressBytes = 0; fields = 0; responseBytes = responseOverhead;
    }
    if (requestSize() > limits.maxRequestBytes) throw new PlusError('REQUEST_LIMIT', 'A symbolic address exceeds the request-byte budget');
    if (responseBytes + valueBytes > limits.maxResponseBytes) throw new PlusError('RESPONSE_LIMIT', 'A scalar value exceeds the response-byte budget');
    batch.push(index); addressBytes += size; fields += itemFields; responseBytes += valueBytes;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/** @param {PlusOperation} operation @param {PlusContext} context */
function operationPayload(operation, context) {
  const { sessionId, version } = context;
  switch (operation.kind) {
    case 'initSSL': return u32(0);
    case 'createSession': return createSessionPayload();
    case 'setupSession': {
      if (!sessionId || !context.serverVersion) throw new PlusError('SESSION_REQUIRED', 'No owned session/version');
      const cursor = new Cursor(context.serverVersion);
      const value = decodeValue(cursor);
      if (cursor.offset !== context.serverVersion.length) throw new PlusError('MALFORMED_RESPONSE', 'Session version has trailing data');
      if (value.flags || (value.datatype !== 4 && (value.datatype !== 23 || value.structId !== 314))) {
        throw new PlusError('SESSION_SETUP_REJECTED', 'ServerSessionVersion must be a scalar UDInt or Struct(314)');
      }
      const start = context.securityKey
        ? Buffer.concat([u32(sessionId), Buffer.from([2, 2]), vlq(1830), vlq(306), Buffer.from([1]), context.securityKey, Buffer.from([2])])
        : Buffer.concat([u32(sessionId), Buffer.from([1, 1]), vlq(306), Buffer.from([1])]);
      if (value.datatype === 23) {
        const members = /** @type {{id:number,value:PlusValue}[]} */ (value.value);
        const clean = members.map(member => Buffer.concat([
          vlq(member.id), member.id === 319 ? Buffer.from([0, 21, 0]) : member.value.raw,
        ]));
        return Buffer.concat([start, Buffer.from([0, 23]),
          u32(value.structId ?? 314), ...clean, Buffer.from([0, 0]), qualifier(version), u32(0)]);
      }
      return Buffer.concat([start, value.raw,
        Buffer.from([0]), qualifier(version), u32(0)]);
    }
    case 'activateSession': {
      if (!sessionId || !context.sessionKey || context.integrityId === undefined) throw new PlusError('SESSION_REQUIRED', 'Session activation requires an owned authenticated session');
      const qualified = qualifier(1);
      u32(context.sequence ?? 0).copy(qualified, qualified.length - 4);
      return Buffer.concat([u32(sessionId), Buffer.from([1]), vlq(323), Buffer.from([0, 2, 5]), qualified, Buffer.alloc(3)]);
    }
    case 'readBlockContent':
    case 'explore': {
      const attributes = operation.attributes ?? [];
      if (operation.kind === 'readBlockContent' && (operation.recursive
        || ![0x8A0E, 0x8A13, 0x8A32].includes((operation.objectId ?? 0) >>> 16)
        || !((operation.objectId ?? 0) & 0xFFFF)
        || attributes.length !== BLOCK_CONTENT_ATTRIBUTES.length
        || attributes.some((id, index) => id !== BLOCK_CONTENT_ATTRIBUTES[index]))) {
        throw new PlusError('READ_ONLY_DENIED', 'Program content requires the qualified native object and exact attribute set');
      }
      if (attributes.length > 8) throw new PlusError('REQUEST_LIMIT', 'At most eight metadata attributes');
      return Buffer.concat([u32(operation.objectId ?? 3), Buffer.from([0, operation.recursive ? 1 : 0, 1, 0, 0]),
        vlq(attributes.length), ...attributes.map(vlq), Buffer.alloc(5)]);
    }
    case 'read': {
      const items = operation.items ?? [{ accessArea: operation.accessArea ?? 0, lids: operation.lids ?? [], symbolCrc: operation.symbolCrc }];
      const maxItems = operation.maxItems ?? 32;
      if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 64) throw new PlusError('ARGUMENT', 'Batch item limit must be 1..64');
      if (!items.length || items.length > maxItems) throw new PlusError('REQUEST_LIMIT', `Read requires 1..${maxItems} symbolic items`);
      let fields = 0;
      const addresses = items.map(item => {
        fields += 4 + item.lids.length;
        return encodeReadAddress(item);
      });
      return Buffer.concat([u32(0), vlq(items.length), vlq(fields), ...addresses,
        qualifier(context.sessionKey ? 2 : version), u32(0)]);
    }
    case 'readAttribute': {
      if (operation.attribute !== 1842) throw new PlusError('READ_ONLY_DENIED', 'Only effective protection-level attribute is qualified');
      return Buffer.concat([u32(sessionId), Buffer.from([0x20, 4, 1]), vlq(1842), qualifier(context.sessionKey ? 2 : version), Buffer.from([0, 1]), u32(0)]);
    }
    default: throw new PlusError('READ_ONLY_DENIED', `Operation ${operation.kind} is not allowlisted`);
  }
}

/** @param {PlusOperation} operation @param {PlusContext} context @param {number} sequence */
export function encodeOperation(operation, context, sequence) {
  if (!getOperationPolicy(operation.kind).allowed) throw new PlusError('READ_ONLY_DENIED', `Operation ${operation.kind} is not allowlisted`);
  let payload = operationPayload(operation, { ...context, sequence });
  const functionCode = PLUS_FUNCTION[/** @type {keyof typeof PLUS_FUNCTION} */ (operation.kind)];
  if (functionCode === undefined) throw new PlusError('READ_ONLY_DENIED', 'Unknown function');
  if (['read', 'explore', 'readBlockContent', 'readAttribute'].includes(operation.kind) && !context.sessionId) {
    throw new PlusError('SESSION_REQUIRED', 'Read requires an established session');
  }
  if (context.integrityId !== undefined && ['read', 'explore', 'readBlockContent', 'readAttribute', 'activateSession'].includes(operation.kind)) {
    const tail = ['explore', 'readBlockContent'].includes(operation.kind) ? 5 : context.sessionKey && operation.kind === 'activateSession' ? 3 : 4;
    payload = Buffer.concat([payload.subarray(0, -tail), vlq(context.integrityId), payload.subarray(-tail)]);
  }
  const header = Buffer.alloc(14);
  header[0] = 0x31;
  header.writeUInt16BE(functionCode, 3);
  header.writeUInt16BE(sequence, 7);
  header.writeUInt32BE(operation.kind === 'createSession' ? 288 : context.sessionId, 9);
  header[13] = operation.kind === 'initSSL' ? 0x30 : operation.kind === 'createSession' ? 0x36 : 0x34;
  const version = ['initSSL', 'createSession'].includes(operation.kind) ? 1 : operation.kind === 'setupSession' ? 2 : context.version;
  if (version !== 1 && version !== 2) throw new PlusError('UNSUPPORTED_VERSION', `V${version} requires an unimplemented security profile`);
  const application = Buffer.concat([header, payload]);
  const body = context.sessionKey ? Buffer.concat([Buffer.from([32]), createHmac('sha256', context.sessionKey).update(application).digest(), application]) : application;
  if (body.length > 900) throw new PlusError('REQUEST_LIMIT', 'Request exceeds 900 bytes');
  const envelopeVersion = context.sessionKey ? 3 : version;
  const outer = Buffer.from([0x72, envelopeVersion, 0, 0]);
  outer.writeUInt16BE(body.length, 2);
  return Buffer.concat([outer, body, Buffer.from([0x72, envelopeVersion, 0, 0])]);
}

/** @param {Buffer} frame @param {PlusOperation} operation @param {PlusContext} context @param {number} sequence */
export function assertOutgoing(frame, operation, context, sequence) {
  if (!getOperationPolicy(operation.kind).allowed) throw new PlusError('READ_ONLY_DENIED', `Operation ${operation.kind} is not allowlisted`);
  if (!frame.equals(encodeOperation(operation, context, sequence))) {
    throw new PlusError('READ_ONLY_DENIED', 'Outgoing bytes do not match an allowlisted canonical request');
  }
}

export class PlusAssembler {
  /** @type {FragmentHMACVerifier|undefined} */
  #verifier;
  #confirmations = 0;
  get sessionConfirmations() { return this.#confirmations; }
  /** @type {Buffer|undefined} */
  #sessionKey;
  /** @param {Buffer} key */
  setSessionKey(key) {
    if (key.length !== 24 || this.#sessionKey || this.#pending.length || this.#parts.length) throw new PlusError('SESSION_STATE', 'Cannot change authentication during a response');
    this.#sessionKey = key;
  }
  /** @type {Buffer} */
  #pending = Buffer.alloc(0);
  /** @type {Buffer[]} */
  #parts = [];
  #bytes = 0;
  #version = 0;
  #lastFragmentCount = 0;
  get lastMessageFragmentCount() { return this.#lastFragmentCount; }
  /** @param {number} [maxBytes] @param {number} [maxFragments] */
  constructor(maxBytes = 65536, maxFragments = 64) { this.maxBytes = maxBytes; this.maxFragments = maxFragments; }
  /** @param {Buffer} bytes @returns {{version:number,body:Buffer}[]} */
  feed(bytes) {
    if (this.#pending.length + this.#bytes + bytes.length > this.maxBytes) throw new PlusError('RESPONSE_LIMIT', 'Response allocation budget exceeded');
    this.#pending = Buffer.concat([this.#pending, bytes]);
    const messages = [];
    while (this.#pending.length >= 4) {
      if (this.#pending[0] !== 0x72) throw new PlusError('MALFORMED_RESPONSE', 'Expected S7CommPlus 0x72');
      const version = this.#pending[1];
      if (version === 0xFE) {
        if (!this.#sessionKey || this.#pending.readUInt16BE(2) !== 16) throw new PlusError('SYSTEM_EVENT', 'PLC SystemEvent: stop acquisition and inspect raw response');
        if (this.#pending.length < 20) break;
        const event = this.#pending.subarray(4, 20);
        if ((!event.equals(Buffer.from('00000000000003230000000000000000', 'hex'))
          && !event.equals(Buffer.from('00000000000003220000000000000000', 'hex'))
          && !event.equals(Buffer.from('00000000000004430000000000000000', 'hex'))) || ++this.#confirmations > 16) {
          throw new PlusError('SYSTEM_EVENT', 'Unknown or excessive PLC SystemEvent; acquisition stopped');
        }
        this.#pending = this.#pending.subarray(20);
        continue;
      }
      if (this.#sessionKey ? version !== 3 : version !== 1 && version !== 2) throw new PlusError('PROTOCOL_VERSION_UNSUPPORTED', `Unsupported response V${version} for selected authentication`);
      if (this.#version && this.#version !== version) throw new PlusError('MALFORMED_RESPONSE', 'Fragment version changed');
      this.#version = version;
      const length = this.#pending.readUInt16BE(2);
      if (length + 4 + this.#bytes > this.maxBytes) throw new PlusError('RESPONSE_LIMIT', 'Declared fragment exceeds budget');
      if (this.#pending.length < length + 4) break;
      let body = this.#pending.subarray(4, 4 + length);
      this.#pending = this.#pending.subarray(4 + length);
      if (!length) {
        if (!this.#parts.length) throw new PlusError('MALFORMED_RESPONSE', 'Empty response is not success');
        this.#lastFragmentCount = this.#parts.length;
        messages.push({ version, body: Buffer.concat(this.#parts) });
        this.#parts = []; this.#bytes = 0; this.#version = 0;
        this.#verifier = undefined;
      } else {
        if (this.#sessionKey) {
          this.#verifier ??= new FragmentHMACVerifier(this.#sessionKey);
          body = this.#verifier.verify(body);
        }
        if (this.#parts.length >= this.maxFragments) throw new PlusError('RESPONSE_LIMIT', 'Too many response fragments');
        this.#parts.push(Buffer.from(body)); this.#bytes += length;
      }
    }
    return messages;
  }
}

/** @param {Buffer} body @param {number} expectedFunction @param {number} sequence @param {boolean} [verifiedTlsCreate] @param {boolean} [legacyInit] @param {boolean} [authenticatedActivation] */
export function responsePayload(body, expectedFunction, sequence, verifiedTlsCreate = false, legacyInit = false, authenticatedActivation = false) {
  if (body.length < 11 || ![0x32, 0x02].includes(body[0]) || body[1] || body[2] || body[5] || body[6]) {
    throw new PlusError('MALFORMED_RESPONSE', 'Invalid ten-byte response header or missing ReturnValue');
  }
  if (body.readUInt16BE(7) !== sequence) {
    throw new PlusError('CORRELATION', 'Unexpected response sequence');
  }
  const functionCode = body.readUInt16BE(3);
  const identifiers = { functionCode, expectedFunction, sequence, transportFlags: body[9], bodyBytes: body.length };
  if (functionCode !== expectedFunction && ![0x04B1, 0x05A9].includes(functionCode)) throw new PlusError('CORRELATION', 'Unexpected response function', identifiers);
  if (functionCode === 0x04B1 || (functionCode === 0x05A9 && !(legacyInit && expectedFunction === PLUS_FUNCTION.initSSL))) {
    throw new PlusError('INDETERMINATE_PROTOCOL_ERROR', 'Generic Error response; its payload is not assumed to be a service ReturnValue', { ...identifiers, payloadHex: body.subarray(10).toString('hex') });
  }
  const payload = body.subarray(10);
  const cursor = new Cursor(payload);
  const status = cursor.integer(64);
  const serviceResultCode = Number(BigInt.asIntN(16, status));
  const statusDetails = {
    ...identifiers, returnValue: `0x${status.toString(16).padStart(16, '0')}`,
    returnValueHex: payload.subarray(0, cursor.offset).toString('hex'), returnValueBodyOffset: 10,
    returnValueBytes: cursor.offset, remainingPayloadBytes: payload.length - cursor.offset, serviceResultCode,
  };
  if (expectedFunction === PLUS_FUNCTION.createSession && serviceResultCode === -134) {
    throw new PlusError('ENGINEERING_SESSION_IN_USE', 'PLC reports Service Multi-ES Not Supported; release other engineering connections before an explicit new attempt', statusDetails);
  }
  const legacyInitRejection = legacyInit && expectedFunction === PLUS_FUNCTION.initSSL
    && ((functionCode === PLUS_FUNCTION.initSSL && serviceResultCode === -519) || (functionCode === 0x05A9 && serviceResultCode === -119));
  const activationStatus = authenticatedActivation && expectedFunction === PLUS_FUNCTION.activateSession && status === 6n;
  if (status !== 0n && !legacyInitRejection && !activationStatus && !(verifiedTlsCreate && expectedFunction === PLUS_FUNCTION.createSession && serviceResultCode !== null && serviceResultCode >= 0)) {
    const code = expectedFunction === PLUS_FUNCTION.initSSL ? 'INITSSL_REJECTED'
      : expectedFunction === PLUS_FUNCTION.createSession ? 'SESSION_CREATE_REJECTED'
      : expectedFunction === PLUS_FUNCTION.setupSession ? 'SESSION_SETUP_REJECTED' : 'PLC_REJECTED';
    throw new PlusError(code, `PLC ReturnValue ${statusDetails.returnValue}; access cause not inferred`, statusDetails);
  }
  return { cursor, payload, statusDetails };
}

/** @typedef {{code:number,optimizedOffset:number,standardOffset:number,relationId:number|null,dimensions:{lowerBound:number,count:number}[],raw:Buffer}} TypeOffset */
/** @typedef {{lid:number,symbolCrc:number,softdatatype:number,attributeFlags:number,bitFlags:number,offset:TypeOffset}} TypeMember */
/** @typedef {{rid:number,classId:number,classFlags:number,attributeId:number,attributeFlags?:number,parentRid:number|null,attributes:{id:number,value:PlusValue}[],typeMembers?:TypeMember[],memberNames?:string[],firstMemberId?:number}} PlusObject */

/** @param {Cursor} cursor @returns {TypeOffset} */
function decodeTypeOffset(cursor, code = 8) {
  const lengths = [104, 4, 12, 20, 68, 32, 48, 96, 4, 12, 20, 68, 32, 48, 96, 40];
  const raw = Buffer.from(cursor.take(lengths[code]));
  const optimizedOffset = code === 1 ? raw.readUInt16LE(2) : code === 8 ? raw.readUInt16LE(0) : raw.readUInt32LE(4);
  const standardOffset = code === 1 ? raw.readUInt16LE(0) : code === 8 ? raw.readUInt16LE(2) : raw.readUInt32LE(8);
  const multidimensional = [4, 7, 11, 14].includes(code);
  const oneDimensional = [3, 6, 10, 13].includes(code);
  const relationOffset = [5, 12, 15].includes(code) ? 12 : [6, 13].includes(code) ? 28 : [7, 14].includes(code) ? 76 : code === 0 ? 12 : null;
  /** @type {{lowerBound:number,count:number}[]} */
  const dimensions = [];
  if (oneDimensional) dimensions.push({ lowerBound: raw.readInt32LE(12), count: raw.readUInt32LE(16) });
  if (multidimensional) {
    let ended = false;
    let total = 1;
    for (let axis = 0; axis < 6; axis++) {
      const count = raw.readUInt32LE(44 + axis * 4);
      if (!count) { ended = true; continue; }
      if (ended) throw new PlusError('MALFORMED_METADATA', 'Non-contiguous array dimensions');
      dimensions.unshift({ lowerBound: raw.readInt32LE(20 + axis * 4), count });
      total *= count;
    }
    if (!dimensions.length || total !== raw.readUInt32LE(16)) throw new PlusError('MALFORMED_METADATA', 'Array dimension product differs from element count');
  }
  return { code, optimizedOffset, standardOffset, relationId: relationOffset === null ? null : raw.readUInt32LE(relationOffset), dimensions, raw };
}

/** @param {Cursor} cursor */
function decodeTypeMembers(cursor) {
  /** @type {TypeMember[]} */
  const members = [];
  let firstMemberId;
  while (true) {
    const length = cursor.take(2).readUInt16BE();
    if (!length) return { members, firstMemberId };
    const block = new Cursor(cursor.take(length));
    if (firstMemberId === undefined) firstMemberId = block.take(4).readUInt32LE();
    if (block.offset === block.bytes.length) throw new PlusError('MALFORMED_METADATA', 'Empty type-member block');
    while (block.offset < block.bytes.length) {
      if (members.length >= 65536) throw new PlusError('RESPONSE_LIMIT', 'Type-member count exceeds 65536');
      const lid = block.take(4).readUInt32LE();
      const symbolCrc = block.take(4).readUInt32LE();
      const softdatatype = block.byte();
      const attributeFlags = block.take(2).readUInt16BE();
      const bitFlags = block.byte();
      members.push({ lid, symbolCrc, softdatatype, attributeFlags, bitFlags, offset: decodeTypeOffset(block, attributeFlags >>> 12) });
    }
  }
}

/** @param {Cursor} cursor */
function decodeMemberNames(cursor) {
  /** @type {string[]} */
  const names = [];
  while (true) {
    const length = cursor.take(2).readUInt16BE();
    if (!length) return names;
    const block = new Cursor(cursor.take(length));
    while (block.offset < block.bytes.length) {
      if (names.length >= 65536) throw new PlusError('RESPONSE_LIMIT', 'Member-name count exceeds 65536');
      const name = new TextDecoder('utf-8', { fatal: true }).decode(block.take(block.byte()));
      if (block.byte() !== 0) throw new PlusError('MALFORMED_METADATA', 'Member name is not terminated');
      names.push(name);
    }
  }
}

/** @param {Cursor} cursor @param {number} [maxObjects] @param {number} [maxDepth] */
export function decodeObjects(cursor, maxObjects = 65536, maxDepth = 256) {
  /** @type {PlusObject[]} */
  const objects = [];
  /** @type {PlusObject[]} */
  const stack = [];
  while (cursor.offset < cursor.bytes.length) {
    const tag = cursor.byte();
    if (!tag && !stack.length) {
      if (cursor.bytes.subarray(cursor.offset).some(byte => byte !== 0)) throw new PlusError('UNSUPPORTED_DECODING', 'Unknown object preamble or suffix');
      break;
    }
    if (tag === 0xA1) {
      if (objects.length >= maxObjects) throw new PlusError('RESPONSE_LIMIT', `Object count exceeds configured limit ${maxObjects}`);
      if (stack.length >= maxDepth) throw new PlusError('RESPONSE_LIMIT', `Object depth exceeds configured limit ${maxDepth}`);
      /** @type {PlusObject} */
      const object = { rid: cursor.uint32(), classId: cursor.uint(), classFlags: cursor.uint(), attributeId: cursor.uint(),
        parentRid: stack.at(-1)?.rid ?? null, attributes: /** @type {{id:number,value:PlusValue}[]} */ ([]) };
      if (object.attributeId) object.attributeFlags = cursor.uint();
      objects.push(object); stack.push(object);
    } else if (tag === 0xA2) {
      if (!stack.pop()) throw new PlusError('MALFORMED_RESPONSE', 'Unbalanced object terminator');
    } else if (tag === 0xA3 && stack.length) {
      const current = /** @type {PlusObject} */ (stack.at(-1));
      if (current.attributes.length >= 128) throw new PlusError('RESPONSE_LIMIT', 'Attribute budget exceeded');
      current.attributes.push({ id: cursor.uint(), value: decodeValue(cursor) });
    } else if (tag === 0xAB && stack.length) {
      const current = /** @type {PlusObject} */ (stack.at(-1));
      if (current.typeMembers) throw new PlusError('MALFORMED_METADATA', 'Duplicate type-member list');
      const decoded = decodeTypeMembers(cursor);
      current.typeMembers = decoded.members;
      current.firstMemberId = decoded.firstMemberId;
    } else if (tag === 0xAC && stack.length) {
      const current = /** @type {PlusObject} */ (stack.at(-1));
      if (current.memberNames) throw new PlusError('MALFORMED_METADATA', 'Duplicate member-name list');
      current.memberNames = decodeMemberNames(cursor);
    } else throw new PlusError('UNSUPPORTED_DECODING', `Unhandled object element 0x${tag.toString(16)} at ${cursor.offset - 1}; raw bytes retained`);
  }
  if (stack.length) throw new PlusError('MALFORMED_RESPONSE', 'Unclosed object tree');
  return objects;
}