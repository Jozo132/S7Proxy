// @ts-check
import { u32, vlq } from '../src/protocol/s7commplus/codec.js';

/** @typedef {{name:string,lid:number,type:number,code?:number,relation?:number,count?:number,lower?:number,dimensions?:{lowerBound:number,count:number}[],crc?:number}} SyntheticMember */
/** @param {number} value */
export function le32(value) { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; }
/** @param {number} value */
function be16(value) { const bytes = Buffer.alloc(2); bytes.writeUInt16BE(value); return bytes; }

/** @param {number} rid @param {SyntheticMember[]} members */
export function typeObject(rid, members) {
  const entries = members.map(member => {
    const code = member.code ?? 8;
    const offset = Buffer.alloc([104, 4, 12, 20, 68, 32, 48, 96, 4, 12, 20, 68, 32, 48, 96, 40][code]);
    if ([3, 6, 10, 13].includes(code)) {
      offset.writeInt32LE(member.lower ?? 0, 12); offset.writeUInt32LE(member.count ?? 1, 16);
    }
    if ([4, 7, 11, 14].includes(code)) {
      const dimensions = [...(member.dimensions ?? [])].reverse();
      offset.writeUInt32LE(dimensions.reduce((total, axis) => total * axis.count, 1), 16);
      for (const [index, axis] of dimensions.entries()) {
        offset.writeInt32LE(axis.lowerBound, 20 + 4 * index);
        offset.writeUInt32LE(axis.count, 44 + 4 * index);
      }
    }
    if (member.relation) offset.writeUInt32LE(member.relation, [5, 12, 15].includes(code) ? 12 : [6, 13].includes(code) ? 28 : 76);
    return Buffer.concat([le32(member.lid), le32(member.crc ?? 0), Buffer.from([member.type]), be16(code << 12), Buffer.from([0]), offset]);
  });
  const names = members.map(member => {
    const name = Buffer.from(member.name);
    return Buffer.concat([Buffer.from([name.length]), name, Buffer.from([0])]);
  });
  const types = Buffer.concat([le32(0), ...entries]);
  const nameBytes = Buffer.concat(names);
  return Buffer.concat([Buffer.from([0xA1]), u32(rid), vlq(511), Buffer.from([0, 0, 0xAB]),
    be16(types.length), types, be16(0), Buffer.from([0xAC]), be16(nameBytes.length), nameBytes, be16(0), Buffer.from([0xA2])]);
}

export const syntheticMembers = [
  { name: 'Enabled', lid: 101, type: 1, crc: 0x10203040 },
  { name: 'Count', lid: 107, type: 5 },
  { name: 'Delay', lid: 112, type: 11 },
  { name: 'Details', lid: 120, type: 17, code: 12, relation: 0x92000009 },
  { name: 'Samples', lid: 125, type: 5, code: 10, lower: -2, count: 3 },
];

/** @param {number} id */
export function metadataExplore(id) {
  if (id === 3) {
    const name = Buffer.from('SampleDB');
    return Buffer.concat([Buffer.from([0xA1]), u32(3), vlq(2520), Buffer.from([0, 0, 0xA1]),
      u32(0x8A0E0007), vlq(2574), Buffer.from([0, 0, 0xA3]),
      vlq(233), Buffer.from([0, 21, name.length]), name,
      Buffer.from([0xA3]), vlq(2521), Buffer.from([0, 3, 0, 7, 0xA2, 0xA2])]);
  }
  return id === 0x92000007 ? typeObject(id, syntheticMembers)
    : typeObject(id, [{ name: 'Ready', lid: 132, type: 1 }]);
}
