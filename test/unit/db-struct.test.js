// @ts-check
import { describe, it, expect } from 'vitest';
import { DBStruct, calculateSize, decode, encode } from '../../src/protocol/db-struct.js';

// ─── calculateSize ───────────────────────────────────────────────────────────

describe('calculateSize', () => {
  it('single INT = 2 bytes', () => {
    expect(calculateSize([{ name: 'x', type: 'INT' }])).toBe(2);
  });

  it('single BOOL = 2 bytes (even-aligned)', () => {
    // 1 bool → 1 bit → flush → 1 byte → round even → 2
    expect(calculateSize([{ name: 'b', type: 'BOOL' }])).toBe(2);
  });

  it('8 bools = 2 bytes', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ name: `b${i}`, type: /** @type {const} */ ('BOOL') }));
    expect(calculateSize(items)).toBe(2);
  });

  it('9 bools = 2 bytes (1 byte + partial flush → round even)', () => {
    const items = Array.from({ length: 9 }, (_, i) => ({ name: `b${i}`, type: /** @type {const} */ ('BOOL') }));
    expect(calculateSize(items)).toBe(2);
  });

  it('REAL + INT = 6 → round even = 6', () => {
    expect(calculateSize([
      { name: 'r', type: 'REAL' },
      { name: 'i', type: 'INT' },
    ])).toBe(6);
  });

  it('BOOL then INT = 4 (bool flush + even align)', () => {
    expect(calculateSize([
      { name: 'b', type: 'BOOL' },
      { name: 'i', type: 'INT' },
    ])).toBe(4);
  });

  it('STRING[10] = 12 bytes (10 + 2 header, already even)', () => {
    expect(calculateSize([{ name: 's', type: 'STRING', strlen: 10 }])).toBe(12);
  });

  it('STRING[3] = 6 bytes (3 + 2 = 5, round to 6)', () => {
    expect(calculateSize([{ name: 's', type: 'STRING', strlen: 3 }])).toBe(6);
  });

  it('BOOL array size=16 = 2 bytes (16 bits)', () => {
    expect(calculateSize([{ name: 'flags', type: 'BOOL', size: 16 }])).toBe(2);
  });

  it('INT array size=3 = 6 bytes', () => {
    expect(calculateSize([{ name: 'arr', type: 'INT', size: 3 }])).toBe(6);
  });

  it('IEC_TIMER = 16 bytes', () => {
    expect(calculateSize([{ name: 'tmr', type: 'IEC_TIMER' }])).toBe(16);
  });

  it('populates offset strings on items', () => {
    /** @type {import('../../src/protocol/db-struct.js').S7StructItem[]} */
    const items = [
      { name: 'a', type: 'INT' },
      { name: 'b', type: 'REAL' },
      { name: 'c', type: 'BYTE' },
    ];
    calculateSize(items);
    expect(items[0].offset).toBe('0.0');
    expect(items[1].offset).toBe('2.0');
    expect(items[2].offset).toBe('6.0');
  });

  it('BOOL offset shows bit position', () => {
    /** @type {import('../../src/protocol/db-struct.js').S7StructItem[]} */
    const items = [
      { name: 'b0', type: 'BOOL' },
      { name: 'b1', type: 'BOOL' },
      { name: 'b2', type: 'BOOL' },
    ];
    calculateSize(items);
    expect(items[0].offset).toBe('0.0');
    expect(items[1].offset).toBe('0.1');
    expect(items[2].offset).toBe('0.2');
  });
});

// ─── Decode scalars ──────────────────────────────────────────────────────────

describe('decode', () => {
  /** @param {import('../../src/protocol/db-struct.js').S7StructItem[]} items */
  const def = (items) => ({ name: 'test', db: 1, offset: 0, items });

  it('INT', () => {
    const buf = Buffer.alloc(2);
    buf.writeInt16BE(42, 0);
    const result = decode(def([{ name: 'val', type: 'INT' }]), buf);
    expect(result).toEqual([{ name: 'val', type: 'INT', value: 42 }]);
  });

  it('UINT / WORD', () => {
    const buf = Buffer.alloc(2);
    buf.writeUInt16BE(65535, 0);
    expect(decode(def([{ name: 'x', type: 'UINT' }]), buf)[0].value).toBe(65535);
  });

  it('SINT / USINT', () => {
    const buf = Buffer.from([0x80, 0x80]); // -128 / 128
    const items = [{ name: 'a', type: /** @type {const} */ ('SINT') }, { name: 'b', type: /** @type {const} */ ('USINT') }];
    const r = decode(def(items), buf);
    expect(r[0].value).toBe(-128);
    expect(r[1].value).toBe(128);
  });

  it('DINT / UDINT / DWORD', () => {
    const buf = Buffer.alloc(4);
    buf.writeInt32BE(-100000, 0);
    expect(decode(def([{ name: 'x', type: 'DINT' }]), buf)[0].value).toBe(-100000);
  });

  it('REAL / FLOAT', () => {
    const buf = Buffer.alloc(4);
    buf.writeFloatBE(3.14, 0);
    const v = /** @type {number} */ (decode(def([{ name: 'x', type: 'REAL' }]), buf)[0].value);
    expect(v).toBeCloseTo(3.14, 2);
  });

  it('LREAL / DOUBLE', () => {
    const buf = Buffer.alloc(8);
    buf.writeDoubleBE(2.718281828, 0);
    const v = /** @type {number} */ (decode(def([{ name: 'x', type: 'LREAL' }]), buf)[0].value);
    expect(v).toBeCloseTo(2.718281828, 6);
  });

  it('BYTE', () => {
    const buf = Buffer.from([0xAB, 0x00]);
    expect(decode(def([{ name: 'x', type: 'BYTE' }]), buf)[0].value).toBe(0xAB);
  });

  it('CHAR', () => {
    const buf = Buffer.from([0x41, 0x00]); // 'A'
    expect(decode(def([{ name: 'x', type: 'CHAR' }]), buf)[0].value).toBe('A');
  });

  it('BOOL bit packing', () => {
    // byte 0 = 0b00000101 = bits 0 and 2 set
    const buf = Buffer.from([0x05, 0x00]);
    const items = [
      { name: 'b0', type: /** @type {const} */ ('BOOL') },
      { name: 'b1', type: /** @type {const} */ ('BOOL') },
      { name: 'b2', type: /** @type {const} */ ('BOOL') },
    ];
    const r = decode(def(items), buf);
    expect(r[0].value).toBe(true);
    expect(r[1].value).toBe(false);
    expect(r[2].value).toBe(true);
  });

  it('STRING', () => {
    // STRING[10] "Test" → [10, 4, T, e, s, t, 0, 0, 0, 0, 0, 0]
    const buf = Buffer.alloc(12);
    buf[0] = 10; buf[1] = 4;
    buf.write('Test', 2, 'ascii');
    const r = decode(def([{ name: 's', type: 'STRING', strlen: 10 }]), buf);
    expect(r[0].value).toBe('Test');
  });

  it('TIME', () => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(5000, 0);
    expect(decode(def([{ name: 't', type: 'TIME' }]), buf)[0].value).toBe(5000);
  });

  it('S5TIME', () => {
    // factor 0, BCD 100 → 100 * 10 = 1000ms
    const buf = Buffer.alloc(2);
    buf.writeUInt16BE(0x0100, 0); // factor=0, BCD=0x100 → decimal 256 → ...
    // Use a known value: factor=1 (100ms), BCD 050 → 50*100 = 5000ms
    buf.writeUInt16BE(0x1050, 0);
    const r = decode(def([{ name: 't', type: 'S5TIME' }]), buf);
    expect(r[0].value).toBe(5000);
  });

  it('IEC_TIMER is flattened', () => {
    const buf = Buffer.alloc(16);
    buf.writeUInt32BE(1, 0);   // start
    buf.writeUInt32BE(500, 4); // PT
    buf.writeUInt32BE(200, 8); // ET
    buf[12] = 0x03;            // IN=bit0=1, Q=bit1=1
    buf.writeUInt16BE(0, 14);  // end
    const r = decode(def([{ name: 'tmr', type: 'IEC_TIMER' }]), buf);
    expect(r.length).toBe(6);
    expect(r[0]).toEqual({ name: 'tmr.start', type: 'UDINT', value: 1 });
    expect(r[1]).toEqual({ name: 'tmr.PT', type: 'TIME', value: 500 });
    expect(r[3]).toEqual({ name: 'tmr.IN', type: 'BOOL', value: true });
    expect(r[4]).toEqual({ name: 'tmr.Q', type: 'BOOL', value: true });
  });
});

// ─── Decode arrays ───────────────────────────────────────────────────────────

describe('decode arrays', () => {
  /** @param {import('../../src/protocol/db-struct.js').S7StructItem[]} items */
  const def = (items) => ({ name: 'test', db: 1, offset: 0, items });

  it('INT array', () => {
    const buf = Buffer.alloc(6);
    buf.writeInt16BE(10, 0);
    buf.writeInt16BE(20, 2);
    buf.writeInt16BE(30, 4);
    const r = decode(def([{ name: 'arr', type: 'INT', size: 3 }]), buf);
    expect(r[0].value).toEqual([10, 20, 30]);
  });

  it('BOOL array', () => {
    // 16 bools = 2 bytes. byte0=0xFF (bits 0-7 true), byte1=0x00 (bits 8-15 false)
    const buf = Buffer.from([0xFF, 0x00, 0x00, 0x00]);
    const r = decode(def([{ name: 'flags', type: 'BOOL', size: 16 }]), buf);
    const arr = /** @type {boolean[]} */ (r[0].value);
    expect(arr.length).toBe(16);
    for (let i = 0; i < 8; i++) expect(arr[i]).toBe(true);
    for (let i = 8; i < 16; i++) expect(arr[i]).toBe(false);
  });
});

// ─── Encode ──────────────────────────────────────────────────────────────────

describe('encode', () => {
  /** @param {import('../../src/protocol/db-struct.js').S7StructItem[]} items */
  const def = (items) => ({ name: 'test', db: 1, offset: 0, items });

  it('INT roundtrip', () => {
    const d = def([{ name: 'val', type: 'INT', value: -1234 }]);
    const buf = encode(d);
    expect(buf.readInt16BE(0)).toBe(-1234);
  });

  it('REAL roundtrip', () => {
    const d = def([{ name: 'val', type: 'REAL', value: 3.14 }]);
    const buf = encode(d);
    expect(buf.readFloatBE(0)).toBeCloseTo(3.14, 2);
  });

  it('BOOL bit packing', () => {
    const d = def([
      { name: 'b0', type: 'BOOL', value: true },
      { name: 'b1', type: 'BOOL', value: false },
      { name: 'b2', type: 'BOOL', value: true },
    ]);
    const buf = encode(d);
    expect(buf[0]).toBe(0x05); // bits 0 and 2
  });

  it('STRING', () => {
    const d = def([{ name: 's', type: 'STRING', strlen: 10, value: 'Hi' }]);
    const buf = encode(d);
    expect(buf[0]).toBe(10);   // max len
    expect(buf[1]).toBe(2);    // actual len
    expect(buf.toString('ascii', 2, 4)).toBe('Hi');
  });

  it('INT array', () => {
    const d = def([{ name: 'arr', type: 'INT', size: 3, value: [10, 20, 30] }]);
    const buf = encode(d);
    expect(buf.readInt16BE(0)).toBe(10);
    expect(buf.readInt16BE(2)).toBe(20);
    expect(buf.readInt16BE(4)).toBe(30);
  });

  it('S5TIME encode', () => {
    const d = def([{ name: 't', type: 'S5TIME', value: 5000 }]);
    const buf = encode(d);
    // Decode it back
    const r = decode(def([{ name: 't', type: 'S5TIME' }]), buf);
    expect(r[0].value).toBe(5000);
  });
});

// ─── Full encode/decode roundtrip ────────────────────────────────────────────

describe('encode→decode roundtrip', () => {
  it('mixed structure', () => {
    const struct = new DBStruct({
      name: 'MixedDB', db: 1, offset: 0,
      items: [
        { name: 'setpoint',  type: 'REAL',   value: 23.5 },
        { name: 'counter',   type: 'DINT',   value: 100000 },
        { name: 'enable',    type: 'BOOL',   value: true },
        { name: 'active',    type: 'BOOL',   value: false },
        { name: 'mode',      type: 'INT',    value: 3 },
        { name: 'label',     type: 'STRING', strlen: 10, value: 'Hello' },
        { name: 'temps',     type: 'REAL',   size: 2, value: [20.5, 21.0] },
      ],
    });

    const buf = struct.encode();
    expect(buf.length).toBe(struct.size);

    const result = struct.decode(buf);
    expect(result.length).toBe(7);

    const map = struct.decodeToMap(buf);
    expect(/** @type {number} */ (map['setpoint'])).toBeCloseTo(23.5, 1);
    expect(map['counter']).toBe(100000);
    expect(map['enable']).toBe(true);
    expect(map['active']).toBe(false);
    expect(map['mode']).toBe(3);
    expect(map['label']).toBe('Hello');
    const temps = /** @type {number[]} */ (map['temps']);
    expect(temps[0]).toBeCloseTo(20.5, 1);
    expect(temps[1]).toBeCloseTo(21.0, 1);
  });

  it('encodeValues convenience', () => {
    const struct = new DBStruct({
      name: 'DB2', db: 2, offset: 0,
      items: [
        { name: 'speed', type: 'REAL' },
        { name: 'run',   type: 'BOOL' },
      ],
    });
    const buf = struct.encodeValues({ speed: 50.5, run: true });
    const map = struct.decodeToMap(buf);
    expect(/** @type {number} */ (map['speed'])).toBeCloseTo(50.5, 1);
    expect(map['run']).toBe(true);
  });
});

// ─── DBStruct class ──────────────────────────────────────────────────────────

describe('DBStruct', () => {
  it('calculates size on construction', () => {
    const s = new DBStruct({
      name: 'Test', db: 1, offset: 0,
      items: [
        { name: 'a', type: 'INT' },
        { name: 'b', type: 'REAL' },
      ],
    });
    expect(s.size).toBe(6);
    expect(s.db).toBe(1);
    expect(s.name).toBe('Test');
  });
});
