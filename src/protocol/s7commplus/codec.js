// @ts-check
export class PlusError extends Error {
  /** @param {string} code @param {string} message @param {Record<string,unknown>} [details] */
  constructor(code, message, details = {}) { super(message); this.name = 'PlusError'; this.code = code; this.details = details; }
}

export const PLUS_FUNCTION = Object.freeze({
  explore: 0x04BB, createSession: 0x04CA, setupSession: 0x0542,
  read: 0x054C, readAttribute: 0x0586, initSSL: 0x05B3,
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

/** @typedef {{flags:number, datatype:number, value:any, raw:Buffer, structId?:number, blobRootId?:number}} PlusValue */

/** @param {Cursor} cursor @param {number} [depth] @returns {PlusValue} */
export function decodeValue(cursor, depth = 0) {
  if (depth > 16) throw new PlusError('RESPONSE_LIMIT', 'Value nesting exceeds 16');
  const start = cursor.offset;
  const flags = cursor.byte();
  const datatype = cursor.byte();
  if (flags !== 0 && flags !== 0x10 && flags !== 0x20) throw new PlusError('UNSUPPORTED_DECODING', `PValue flags 0x${flags.toString(16)}`);
  /** @type {PlusValue} */
  const result = { flags, datatype, value: null, raw: Buffer.alloc(0) };
  if (flags) {
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
        return Buffer.from(cursor.take(cursor.uint()));
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

/** @typedef {{kind:string, objectId?:number, attributes?:number[], recursive?:boolean, accessArea?:number, lids?:number[], symbolCrc?:number, attribute?:number}} PlusOperation */
/** @typedef {{sessionId:number, version:number, serverVersion?:Buffer, integrityId?:number}} PlusContext */

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
      if (value.datatype === 23) {
        const members = /** @type {{id:number,value:PlusValue}[]} */ (value.value);
        const clean = members.map(member => Buffer.concat([
          vlq(member.id), member.id === 319 ? Buffer.from([0, 21, 0]) : member.value.raw,
        ]));
        return Buffer.concat([u32(sessionId), Buffer.from([1, 1]), vlq(306), Buffer.from([1, 0, 23]),
          u32(value.structId ?? 314), ...clean, Buffer.from([0, 0]), qualifier(version), u32(0)]);
      }
      return Buffer.concat([u32(sessionId), Buffer.from([1, 1]), vlq(306), Buffer.from([1]), value.raw,
        Buffer.from([0]), qualifier(version), u32(0)]);
    }
    case 'explore': {
      const attributes = operation.attributes ?? [];
      if (attributes.length > 8) throw new PlusError('REQUEST_LIMIT', 'At most eight metadata attributes');
      return Buffer.concat([u32(operation.objectId ?? 3), Buffer.from([0, operation.recursive ? 1 : 0, 1, 0, 0]),
        vlq(attributes.length), ...attributes.map(vlq), Buffer.alloc(5)]);
    }
    case 'read': {
      const lids = operation.lids ?? [];
      if (!lids.length || lids.length > 16) throw new PlusError('REQUEST_LIMIT', 'One LID path of 1..16 elements required');
      const area = operation.accessArea ?? 0;
      return Buffer.concat([u32(0), vlq(1), vlq(4 + lids.length), vlq(operation.symbolCrc ?? 0),
        vlq(area), vlq(1 + lids.length), vlq(area >= 0x8A0E0000 ? 2550 : 3736),
        ...lids.map(vlq), qualifier(version), u32(0)]);
    }
    case 'readAttribute':
      if (operation.attribute !== 1842) throw new PlusError('READ_ONLY_DENIED', 'Only effective protection-level attribute is qualified');
      return Buffer.concat([u32(sessionId), Buffer.from([0x20, 4, 1]), vlq(1842), qualifier(version), Buffer.from([0, 1]), u32(0)]);
    default: throw new PlusError('READ_ONLY_DENIED', `Operation ${operation.kind} is not allowlisted`);
  }
}

/** @param {PlusOperation} operation @param {PlusContext} context @param {number} sequence */
export function encodeOperation(operation, context, sequence) {
  let payload = operationPayload(operation, context);
  const functionCode = PLUS_FUNCTION[/** @type {keyof typeof PLUS_FUNCTION} */ (operation.kind)];
  if (functionCode === undefined) throw new PlusError('READ_ONLY_DENIED', 'Unknown function');
  if (['read', 'explore', 'readAttribute'].includes(operation.kind) && !context.sessionId) {
    throw new PlusError('SESSION_REQUIRED', 'Read requires an established session');
  }
  if (context.integrityId !== undefined && ['read', 'explore', 'readAttribute'].includes(operation.kind)) {
    const tail = operation.kind === 'explore' ? 5 : 4;
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
  const body = Buffer.concat([header, payload]);
  if (body.length > 900) throw new PlusError('REQUEST_LIMIT', 'Request exceeds 900 bytes');
  const outer = Buffer.from([0x72, version, 0, 0]);
  outer.writeUInt16BE(body.length, 2);
  return Buffer.concat([outer, body, Buffer.from([0x72, version, 0, 0])]);
}

/** @param {Buffer} frame @param {PlusOperation} operation @param {PlusContext} context @param {number} sequence */
export function assertOutgoing(frame, operation, context, sequence) {
  if (!frame.equals(encodeOperation(operation, context, sequence))) {
    throw new PlusError('READ_ONLY_DENIED', 'Outgoing bytes do not match an allowlisted canonical request');
  }
}

export class PlusAssembler {
  /** @type {Buffer} */
  #pending = Buffer.alloc(0);
  /** @type {Buffer[]} */
  #parts = [];
  #bytes = 0;
  #version = 0;
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
      if (version === 0xFE) throw new PlusError('SYSTEM_EVENT', 'PLC SystemEvent: stop acquisition and inspect raw response');
      if (version !== 1 && version !== 2) throw new PlusError('PROTOCOL_VERSION_UNSUPPORTED', `Unsupported response V${version}`);
      if (this.#version && this.#version !== version) throw new PlusError('MALFORMED_RESPONSE', 'Fragment version changed');
      this.#version = version;
      const length = this.#pending.readUInt16BE(2);
      if (length + 4 + this.#bytes > this.maxBytes) throw new PlusError('RESPONSE_LIMIT', 'Declared fragment exceeds budget');
      if (this.#pending.length < length + 4) break;
      const body = this.#pending.subarray(4, 4 + length);
      this.#pending = this.#pending.subarray(4 + length);
      if (!length) {
        if (!this.#parts.length) throw new PlusError('MALFORMED_RESPONSE', 'Empty response is not success');
        messages.push({ version, body: Buffer.concat(this.#parts) });
        this.#parts = []; this.#bytes = 0; this.#version = 0;
      } else {
        if (this.#parts.length >= this.maxFragments) throw new PlusError('RESPONSE_LIMIT', 'Too many response fragments');
        this.#parts.push(Buffer.from(body)); this.#bytes += length;
      }
    }
    return messages;
  }
}

/** @param {Buffer} body @param {number} expectedFunction @param {number} sequence */
export function responsePayload(body, expectedFunction, sequence) {
  if (body.length < 11 || ![0x32, 0x02].includes(body[0]) || body[1] || body[2] || body[5] || body[6]) {
    throw new PlusError('MALFORMED_RESPONSE', 'Invalid ten-byte response header or missing ReturnValue');
  }
  if (body.readUInt16BE(7) !== sequence) {
    throw new PlusError('CORRELATION', 'Unexpected response sequence');
  }
  const functionCode = body.readUInt16BE(3);
  if (functionCode !== expectedFunction && functionCode !== 0x04B1) throw new PlusError('CORRELATION', 'Unexpected response function');
  const identifiers = { functionCode, sequence, transportFlags: body[9], bodyBytes: body.length };
  if (functionCode === 0x04B1) {
    throw new PlusError('INDETERMINATE_PROTOCOL_ERROR', 'Generic Error response; its payload is not assumed to be a service ReturnValue', identifiers);
  }
  const payload = body.subarray(10);
  const cursor = new Cursor(payload);
  const status = cursor.integer(64);
  if (status !== 0n) {
    const code = expectedFunction === PLUS_FUNCTION.initSSL ? 'INITSSL_REJECTED'
      : expectedFunction === PLUS_FUNCTION.createSession ? 'SESSION_CREATE_REJECTED'
      : expectedFunction === PLUS_FUNCTION.setupSession ? 'SESSION_SETUP_REJECTED' : 'PLC_REJECTED';
    throw new PlusError(code, `PLC ReturnValue 0x${status.toString(16).padStart(16, '0')}; access cause not inferred`, {
      ...identifiers, returnValue: `0x${status.toString(16).padStart(16, '0')}`,
      returnValueHex: payload.subarray(0, cursor.offset).toString('hex'), returnValueBodyOffset: 10,
      returnValueBytes: cursor.offset, remainingPayloadBytes: payload.length - cursor.offset,
    });
  }
  return { cursor, payload };
}

/** @typedef {{rid:number,classId:number,classFlags:number,attributeId:number,parentRid:number|null,attributes:{id:number,value:PlusValue}[]}} PlusObject */
/** @param {Cursor} cursor @param {number} [maxObjects] */
export function decodeObjects(cursor, maxObjects = 32) {
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
      if (objects.length >= maxObjects || stack.length >= 16) throw new PlusError('RESPONSE_LIMIT', 'Object/depth budget exceeded');
      const object = { rid: cursor.uint32(), classId: cursor.uint(), classFlags: cursor.uint(), attributeId: cursor.uint(),
        parentRid: stack.at(-1)?.rid ?? null, attributes: /** @type {{id:number,value:PlusValue}[]} */ ([]) };
      objects.push(object); stack.push(object);
    } else if (tag === 0xA2) {
      if (!stack.pop()) throw new PlusError('MALFORMED_RESPONSE', 'Unbalanced object terminator');
    } else if (tag === 0xA3 && stack.length) {
      const current = /** @type {PlusObject} */ (stack.at(-1));
      if (current.attributes.length >= 128) throw new PlusError('RESPONSE_LIMIT', 'Attribute budget exceeded');
      current.attributes.push({ id: cursor.uint(), value: decodeValue(cursor) });
    } else throw new PlusError('UNSUPPORTED_DECODING', `Unhandled object element 0x${tag.toString(16)} at ${cursor.offset - 1}; raw bytes retained`);
  }
  if (stack.length) throw new PlusError('MALFORMED_RESPONSE', 'Unclosed object tree');
  return objects;
}