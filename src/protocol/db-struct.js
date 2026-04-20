// @ts-check
// Structured S7 DB layout — encode/decode typed fields to/from raw buffers.
//
// Mirrors the Siemens S7 memory layout rules:
//  - multi-byte types aligned to even offsets
//  - BOOL fields packed into bits, flushed on type boundary
//  - STRING stored as [maxLen][actualLen][chars…] padded to even size
//  - arrays aligned before and after

// ─── Data-type definitions ───────────────────────────────────────────────────

/**
 * Every S7 data type the module handles (case-insensitive at API boundary).
 *
 * @typedef { 'SINT' | 'USINT' | 'INT' | 'UINT' | 'WORD' | 'DINT' | 'UDINT'
 *          | 'DWORD' | 'REAL' | 'FLOAT' | 'LREAL' | 'DOUBLE'
 *          | 'CHAR' | 'STRING'
 *          | 'BOOL' | 'BIT' | 'BYTE'
 *          | 'TIME' | 'TIMER' | 'S5TIME' | 'IEC_TIMER' } S7DataType
 */

/**
 * Canonical upper-case sizes (bytes) per type.
 * @type {Record<string, number>}
 */
const TYPE_SIZES = {
  SINT: 1, USINT: 1,
  INT: 2, UINT: 2, WORD: 2,
  DINT: 4, UDINT: 4, DWORD: 4,
  REAL: 4, FLOAT: 4,
  LREAL: 8, DOUBLE: 8,
  CHAR: 1,
  STRING: 256,          // default, overridden by strlen
  BIT: 1, BOOL: 1,
  BYTE: 1,
  TIME: 4, TIMER: 4,
  S5TIME: 2,
  IEC_TIMER: 16,
};

/** @param {string} type @returns {number} */
function typeSize(type) {
  return TYPE_SIZES[type.toUpperCase()] ?? 2;
}

/** @param {string} t */
const isBool = (t) => { const u = t.toUpperCase(); return u === 'BOOL' || u === 'BIT'; };
/** @param {string} t */
const isString = (t) => t.toUpperCase() === 'STRING';
/** @param {number} n */
const roundEven = (n) => n + (n & 1);

/** Types whose decoded value is always a number. */
const NUMERIC_TYPES = new Set([
  'SINT', 'USINT', 'INT', 'UINT', 'WORD', 'DINT', 'UDINT', 'DWORD',
  'REAL', 'FLOAT', 'LREAL', 'DOUBLE', 'BIT', 'BYTE', 'TIME', 'TIMER', 'S5TIME',
]);
/** Types whose decoded value is a sub-structure array. */
const OBJECT_TYPES = new Set(['IEC_TIMER']);

// ─── Structure item & result types ───────────────────────────────────────────

/**
 * One field in a DB structure definition.
 *
 * @typedef {Object} S7StructItem
 * @property {string}      name    - Field name
 * @property {S7DataType}  type    - S7 data type
 * @property {number}      [size]  - Array length (default 1)
 * @property {number}      [strlen]- For STRING: max char count (default 254)
 * @property {S7Value}     [value] - Current value (used for encoding)
 * @property {string}      [offset]- Computed byte.bit offset (filled by calculateSize)
 */

/**
 * A complete DB structure descriptor.
 *
 * @typedef {Object} S7StructDef
 * @property {string}        name   - Human label
 * @property {number}        db     - DB number
 * @property {number}        offset - Start byte offset in the DB
 * @property {string}        [targetId] - Preferred PLC target for this struct
 * @property {string}        [description]
 * @property {'none' | 'struct' | 'items'} [subscribeMode]
 * @property {string[]}      [subscribeItems]
 * @property {number}        [subscribeIntervalMs]
 * @property {string}        [subscribeTargetId]
 * @property {S7StructItem[]} items - Fields
 */

/**
 * Scalar or array value.
 * @typedef {boolean | number | string | S7DecodedField[] | Array<boolean | number | string | S7DecodedField[]>} S7Value
 */

/**
 * One decoded field from a buffer.
 *
 * @typedef {Object} S7DecodedField
 * @property {string}  name
 * @property {string}  type
 * @property {S7Value} value
 */

// ─── Size calculation ────────────────────────────────────────────────────────

/**
 * Calculate the total byte size for a list of struct items following S7 layout
 * rules.  Also populates each item's `offset` as `"byte.bit"`.
 *
 * @param {S7StructItem[]} items
 * @param {number} [startOffset=0]
 * @returns {number} Total byte count (even-aligned)
 */
export function calculateSize(items, startOffset = 0) {
  let bytes = 0;
  let bits = 0;

  for (const item of items) {
    // Normalise
    const type = (item.type = /** @type {S7DataType} */ (item.type.toUpperCase()));
    const size = (item.size = (item.size && item.size > 0) ? Math.round(item.size) : 1);
    if (type === 'STRING') item.strlen = item.strlen ?? 254;
    const strlen = type === 'STRING' ? roundEven((item.strlen ?? 254) + 2) : 0;
    const tsize = typeSize(type);
    const bool = isBool(type);

    // Record offset before advancing
    item.offset = `${(startOffset + bytes + 0.1 * bits).toFixed(1)}`;

    if (size > 1) {
      // ── Array ──
      if (bits > 0) { bytes += 1; bits = 0; }
      bytes = roundEven(bytes);
      if (bool) bytes += 2 * Math.ceil(size / 16);
      else bytes += isString(type) ? strlen * size : tsize * size;
      bytes = roundEven(bytes);
    } else {
      // ── Scalar ──
      if (bool) {
        bits++;
        if (bits >= 8) { bytes += 1; bits = 0; }
      } else {
        if (bits > 0) { bytes += 1; bits = 0; }
        if (tsize > 1) bytes = roundEven(bytes);
        bytes += isString(type) ? strlen : tsize;
      }
    }
  }

  if (bits > 0) bytes += 1;
  return roundEven(bytes);
}

// ─── Decode helpers ──────────────────────────────────────────────────────────

/** @param {Buffer} buf @param {number} off @param {number} bit */
function readBool(buf, off, bit) {
  const byteOff = off + (bit > 7 ? 1 : 0);
  return ((buf.readUInt8(byteOff) >> (bit % 8)) & 1) === 1;
}

/** @param {Buffer} buf @param {number} off */
function readTime(buf, off) { return buf.readUInt32BE(off); }

const S5_TIMEBASE = [10, 100, 1000, 10000];
/** @param {Buffer} buf @param {number} off */
function readS5Time(buf, off) {
  const raw = buf.readUInt16BE(off);
  const factor = (raw & 0x3000) >> 12;
  const bcd = +(raw & 0x0FFF).toString(16);
  return bcd * S5_TIMEBASE[factor];
}

/**
 * @param {Buffer} buf
 * @param {number} off
 * @returns {S7DecodedField[]}
 */
function readIecTimer(buf, off) {
  return [
    { name: 'start', type: 'UDINT', value: readValue(buf, 'UDINT', off) },
    { name: 'PT',    type: 'TIME',  value: readValue(buf, 'TIME',  off + 4) },
    { name: 'ET',    type: 'TIME',  value: readValue(buf, 'TIME',  off + 8) },
    { name: 'IN',    type: 'BOOL',  value: readValue(buf, 'BOOL',  off + 12, 0) },
    { name: 'Q',     type: 'BOOL',  value: readValue(buf, 'BOOL',  off + 12, 1) },
    { name: 'end',   type: 'UINT',  value: readValue(buf, 'UINT',  off + 14) },
  ];
}

/**
 * @param {Buffer} buf @param {number} off @param {number} [expectedStrLen]
 * @returns {string}
 */
function readString(buf, off, expectedStrLen) {
  const maxLen = buf.readUInt8(off);
  const curLen = buf.readUInt8(off + 1);
  const len = Math.min(curLen, maxLen, expectedStrLen ?? 254);
  return buf.toString('ascii', off + 2, off + 2 + len);
}

/**
 * Read a single scalar value from a buffer.
 *
 * @param {Buffer} buf
 * @param {string} type - Upper-case S7 type name
 * @param {number} off  - Byte offset
 * @param {number} [bit=0] - Bit index (booleans only)
 * @param {number} [strlen] - Expected string buffer size
 * @returns {S7Value}
 */
function readValue(buf, type, off, bit = 0, strlen) {
  switch (type.toUpperCase()) {
    case 'BIT':
    case 'BOOL':      return readBool(buf, off, bit);
    case 'BYTE':      return buf.readUInt8(off);
    case 'SINT':      return buf.readInt8(off);
    case 'USINT':     return buf.readUInt8(off);
    case 'INT':       return buf.readInt16BE(off);
    case 'UINT':
    case 'WORD':      return buf.readUInt16BE(off);
    case 'DINT':      return buf.readInt32BE(off);
    case 'UDINT':
    case 'DWORD':     return buf.readUInt32BE(off);
    case 'REAL':
    case 'FLOAT':     return buf.readFloatBE(off);
    case 'LREAL':
    case 'DOUBLE':    return buf.readDoubleBE(off);
    case 'CHAR':      return String.fromCharCode(buf.readUInt8(off));
    case 'STRING':    return readString(buf, off, strlen);
    case 'TIME':
    case 'TIMER':     return readTime(buf, off);
    case 'S5TIME':    return readS5Time(buf, off);
    case 'IEC_TIMER': return readIecTimer(buf, off);
    default:          return buf.readUInt16BE(off);
  }
}

// ─── Decode (Buffer → S7DecodedField[]) ──────────────────────────────────────

/**
 * Decode a raw buffer into an array of named/typed values following the given
 * DB structure definition.
 *
 * @param {S7StructDef} def   - Structure descriptor
 * @param {Buffer}      buf   - Raw bytes (length ≥ calculateSize result)
 * @returns {S7DecodedField[]}
 */
export function decode(def, buf) {
  buf = Buffer.from(buf);
  /** @type {S7DecodedField[]} */
  const out = [];
  let off = 0;
  let bits = 0;

  for (const item of def.items) {
    const type = /** @type {string} */ (item.type).toUpperCase();
    const size = item.size && item.size > 0 ? Math.round(item.size) : 1;
    const tsize = typeSize(type);
    const bool = isBool(type);
    const strBufLen = type === 'STRING' ? roundEven((item.strlen ?? 254) + 2) : 0;

    // Alignment
    if (bool && size > 1) { if (bits > 0) { off += 1; bits = 0; } }
    else if (bool) { bits++; }
    else { if (bits > 0) { off += 1; bits = 0; } }

    /** @type {S7DecodedField} */
    const field = { name: item.name, type, value: /** @type {S7Value} */ (/** @type {unknown} */ (undefined)) };

    if (size > 1) {
      // ── Array ──
      off = roundEven(off);
      /** @type {Array<boolean | number | string | S7DecodedField[]>} */
      const arr = [];
      for (let i = 0; i < size; i++) {
        let v = readValue(buf, type, off, bool ? bits : bits - 1, strBufLen);
        if (NUMERIC_TYPES.has(type.toUpperCase())) v = Number.isFinite(+v) ? +v : 0;
        arr.push(bool ? !!v : /** @type {boolean | number | string | S7DecodedField[]} */ (v));
        if (isString(type)) off += strBufLen;
        else if (bool) { bits++; if (bits >= 8) { off += 1; bits = 0; } }
        else off += tsize;
      }
      off = roundEven(off);
      field.value = arr;
    } else {
      // ── Scalar ──
      if (tsize > 1 && !bool) off = roundEven(off);
      field.value = readValue(buf, type, off, bits - 1, strBufLen);
      if (isString(type)) off += strBufLen;
      else if (bool) { if (bits >= 8) { off += 1; bits = 0; } }
      else off += tsize;
    }

    // Flatten object types (IEC_TIMER)
    if (OBJECT_TYPES.has(type.toUpperCase())) {
      if (size > 1 && Array.isArray(field.value)) {
        for (let i = 0; i < field.value.length; i++) {
          const sub = /** @type {S7DecodedField[]} */ (field.value[i]);
          for (const s of sub) out.push({ name: `${item.name}[${i}].${s.name}`, type: s.type, value: s.value });
        }
      } else if (Array.isArray(field.value)) {
        for (const s of /** @type {S7DecodedField[]} */ (field.value)) {
          out.push({ name: `${item.name}.${s.name}`, type: s.type, value: s.value });
        }
      }
    } else {
      out.push(field);
    }
  }

  return out;
}

// ─── Encode helpers ──────────────────────────────────────────────────────────

/** @param {boolean} v @param {Buffer} buf @param {number} off @param {number} bit */
function writeBool(v, buf, off, bit) {
  let byte = buf.readUInt8(off);
  if (v) byte |= (1 << bit);
  else byte &= ~(1 << bit);
  buf.writeUInt8(byte, off);
}

/** @param {string} v @param {Buffer} buf @param {number} off @param {number} maxLen */
function writeString(v, buf, off, maxLen) {
  const chars = v.length > maxLen - 2 ? maxLen - 2 : v.length;
  buf.writeUInt8(maxLen - 2, off);
  buf.writeUInt8(chars, off + 1);
  for (let i = 0; i < chars; i++) buf.writeUInt8(v.charCodeAt(i), off + 2 + i);
  // Zero-fill the rest
  for (let i = chars; i < maxLen - 2; i++) buf.writeUInt8(0, off + 2 + i);
}

/** @param {number} v @param {Buffer} buf @param {number} off */
function writeS5Time(v, buf, off) {
  v = Math.max(0, Math.min(9990000, v));
  const factor = v < 9990 ? 0 : v < 99900 ? 1 : v < 999000 ? 2 : 3;
  const bcd = +((v / (10 ** (factor + 1))) | 0).toString().substring(0, 3);
  buf.writeUInt16BE((factor << 12) | (+('0x' + bcd) & 0x0FFF), off);
}

/**
 * Write a single scalar value into a buffer.
 *
 * @param {Buffer} buf
 * @param {S7Value} value
 * @param {string} type
 * @param {number} off
 * @param {number} [bit=0]
 * @param {number} [strlen=254]
 */
function writeValue(buf, value, type, off, bit = 0, strlen = 254) {
  switch (type.toUpperCase()) {
    case 'BIT':
    case 'BOOL':      writeBool(!!value, buf, off, bit); break;
    case 'BYTE':      buf.writeUInt8(+/** @type {number} */(value), off); break;
    case 'SINT':      buf.writeInt8(+/** @type {number} */(value), off); break;
    case 'USINT':     buf.writeUInt8(+/** @type {number} */(value), off); break;
    case 'INT':       buf.writeInt16BE(+/** @type {number} */(value), off); break;
    case 'UINT':
    case 'WORD':      buf.writeUInt16BE(+/** @type {number} */(value), off); break;
    case 'DINT':      buf.writeInt32BE(+/** @type {number} */(value), off); break;
    case 'UDINT':
    case 'DWORD':     buf.writeUInt32BE(+/** @type {number} */(value), off); break;
    case 'REAL':
    case 'FLOAT':     buf.writeFloatBE(+/** @type {number} */(value), off); break;
    case 'LREAL':
    case 'DOUBLE':    buf.writeDoubleBE(+/** @type {number} */(value), off); break;
    case 'CHAR':      buf.writeUInt8(String(value).charCodeAt(0), off); break;
    case 'STRING':    writeString(String(value), buf, off, strlen); break;
    case 'TIME':
    case 'TIMER':     buf.writeUInt32BE(+/** @type {number} */(value), off); break;
    case 'S5TIME':    writeS5Time(+/** @type {number} */(value), buf, off); break;
    // IEC_TIMER encode is not supported (read-only composite)
    default:          buf.writeUInt16BE(+/** @type {number} */(value), off); break;
  }
}

// ─── Encode (S7StructDef → Buffer) ───────────────────────────────────────────

/**
 * Encode a DB structure definition (with `.value` set on each item) into a raw
 * buffer following the S7 memory layout.
 *
 * @param {S7StructDef} def
 * @returns {Buffer}
 */
export function encode(def) {
  const totalSize = calculateSize(def.items, def.offset);
  const buf = Buffer.alloc(totalSize);
  let off = 0;
  let bits = 0;

  for (const item of def.items) {
    const type = /** @type {string} */ (item.type).toUpperCase();
    const size = item.size && item.size > 0 ? Math.round(item.size) : 1;
    const tsize = typeSize(type);
    const bool = isBool(type);
    const strBufLen = type === 'STRING' ? roundEven((item.strlen ?? 254) + 2) : 0;
    const { value } = item;

    // Alignment (mirrors decode)
    if (bool && size > 1) { if (bits > 0) { off += 1; bits = 0; } }
    else if (bool) { bits++; }
    else { if (bits > 0) { off += 1; bits = 0; } }

    if (size > 1 && Array.isArray(value)) {
      // ── Array ──
      off = roundEven(off);
      for (let i = 0; i < size; i++) {
        const v = value[i];
        const num = NUMERIC_TYPES.has(type) ? (Number.isFinite(+v) ? +v : 0) : v;
        if (!OBJECT_TYPES.has(type)) writeValue(buf, /** @type {S7Value} */ (num), type, off, bool ? bits : bits - 1, strBufLen);
        if (isString(type)) off += strBufLen;
        else if (bool) { bits++; if (bits >= 8) { off += 1; bits = 0; } }
        else off += tsize;
      }
      off = roundEven(off);
    } else {
      // ── Scalar ──
      if (tsize > 1 && !bool) off = roundEven(off);
      const v = NUMERIC_TYPES.has(type) ? (Number.isFinite(+(value ?? 0)) ? +(value ?? 0) : 0) : (value ?? '');
      if (!OBJECT_TYPES.has(type)) writeValue(buf, v, type, off, bits - 1, strBufLen);
      if (isString(type)) off += strBufLen;
      else if (bool) { if (bits >= 8) { off += 1; bits = 0; } }
      else off += tsize;
    }
  }

  return buf;
}

// ─── Convenience: DBStruct class ─────────────────────────────────────────────

/**
 * High-level wrapper for a DB structure definition.
 *
 * ```js
 * const struct = new DBStruct({
 *   name: 'Control', db: 1, offset: 0,
 *   items: [
 *     { name: 'setpoint', type: 'REAL' },
 *     { name: 'enable',   type: 'BOOL' },
 *     { name: 'mode',     type: 'INT'  },
 *   ],
 * });
 * const values = struct.decode(buffer);
 * const buffer = struct.encode();
 * ```
 */
export class DBStruct {
  /** @type {string} */
  name;
  /** @type {number} */
  db;
  /** @type {number} */
  offset;
  /** @type {S7StructItem[]} */
  items;
  /** @type {number} */
  size;

  /** @param {S7StructDef} def */
  constructor(def) {
    this.name = def.name ?? 'Unnamed';
    this.db = def.db >= 0 ? def.db : 1;
    this.offset = def.offset >= 0 ? def.offset : 0;
    this.items = def.items ?? [];
    this.size = calculateSize(this.items, this.offset);
  }

  /**
   * Decode a raw buffer into named/typed values.
   * @param {Buffer} buf
   * @returns {S7DecodedField[]}
   */
  decode(buf) {
    return decode(this, buf);
  }

  /**
   * Encode the current item values into a raw buffer.
   * @returns {Buffer}
   */
  encode() {
    return encode(this);
  }

  /**
   * Set values from a key→value map and return the encoded buffer.
   * @param {Record<string, S7Value>} values
   * @returns {Buffer}
   */
  encodeValues(values) {
    for (const item of this.items) {
      if (values[item.name] !== undefined) {
        item.value = values[item.name];
      }
    }
    return encode(this);
  }

  /**
   * Decode a buffer and return a flat name→value map (convenience).
   * @param {Buffer} buf
   * @returns {Record<string, S7Value>}
   */
  decodeToMap(buf) {
    const fields = decode(this, buf);
    /** @type {Record<string, S7Value>} */
    const map = {};
    for (const f of fields) map[f.name] = f.value;
    return map;
  }
}
