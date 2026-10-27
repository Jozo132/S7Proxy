// @ts-check
import { PlusError } from './codec.js';

/** @import { PlusObject, TypeMember, PlusValue } from './codec.js' */
export const SOFTWARE_TYPES = Object.freeze({
  1: 'BOOL', 2: 'BYTE', 3: 'CHAR', 4: 'WORD', 5: 'INT', 6: 'DWORD', 7: 'DINT',
  8: 'REAL', 9: 'DATE', 10: 'TIME_OF_DAY', 11: 'TIME', 12: 'S5TIME', 14: 'DATE_AND_TIME',
  16: 'ARRAY', 17: 'STRUCT', 18: 'END_STRUCT', 19: 'STRING', 20: 'POINTER',
  21: 'MULTI_FB', 22: 'ANY', 40: 'BBOOL', 48: 'LREAL', 49: 'ULINT', 50: 'LINT',
  51: 'LWORD', 52: 'USINT', 53: 'UINT', 54: 'UDINT', 55: 'SINT', 61: 'WCHAR',
  62: 'WSTRING', 63: 'VARIANT', 64: 'LTIME', 65: 'LTOD', 66: 'LDT', 67: 'DTL',
});
const WIRE_TYPES = new Map([[1, 1], [2, 10], [4, 11], [5, 7], [6, 12], [7, 8],
  [8, 14], [11, 8], [19, 2], [48, 15], [49, 5], [50, 9], [51, 13], [52, 2], [53, 3],
  [54, 4], [55, 6], [64, 17]]);
const VALUE_SIZES = new Map([[1, 3], [2, 3], [4, 4], [5, 4], [6, 6], [7, 7],
  [8, 6], [11, 7], [19, 260], [48, 10], [49, 11], [50, 11], [51, 10], [52, 3], [53, 4],
  [54, 7], [55, 3], [64, 11]]);

/** @typedef {{type:'DB',number:number,name:string|null,objectRid:number,typeInfoId:number|null,status:string,evidence:unknown}} BlockMetadata */
/** @typedef {{type:'I'|'Q'|'M',name:'I'|'Q'|'M',objectRid:number,typeInfoId:number|null,status:string,evidence:unknown}} AreaMetadata */
/** @typedef {{name:string|null,path:string|null,parentPath:string|null,datatype:string,softdatatype:number,memberId:number,typeInfoId:number,referencedTypeInfoId:number|null,accessPath:number[],symbolCrc:number,arrayDimensions:{lowerBound:number,count:number}[],status:string,readable:boolean}} RuntimeMember */

/** @template {{typeInfoId:number|null}} T @param {T} block @param {PlusObject[]} objects @param {number} [maxMembers] */
export function buildBlockMembers(block, objects, maxMembers = 4096) {
  if (!Number.isSafeInteger(maxMembers) || maxMembers < 1 || maxMembers > 1048576) throw new PlusError('ARGUMENT', 'Member budget must be 1..1048576');
  /** @type {Map<number, PlusObject[]>} */
  const types = new Map();
  for (const object of objects.filter(object => object.classId === 511)) types.set(object.rid, [...(types.get(object.rid) ?? []), object]);
  /** @type {RuntimeMember[]} */
  const members = [];
  /** @type {{code:string,typeInfoId:number,path:string|null}[]} */
  const diagnostics = [];
  /** @param {number} typeId @param {string|null} parent @param {number[]} prefix @param {Set<number>} ancestors */
  function visit(typeId, parent, prefix, ancestors) {
    if (ancestors.has(typeId)) { diagnostics.push({ code: 'RECURSIVE_TYPE', typeInfoId: typeId, path: parent }); return; }
    const matches = types.get(typeId) ?? [];
    if (matches.length !== 1) { diagnostics.push({ code: matches.length ? 'AMBIGUOUS_TYPE' : 'TYPE_UNAVAILABLE', typeInfoId: typeId, path: parent }); return; }
    if (prefix.length >= 16) { diagnostics.push({ code: 'ACCESS_PATH_LIMIT', typeInfoId: typeId, path: parent }); return; }
    const object = matches[0];
    const entries = object.typeMembers;
    const names = object.memberNames;
    if (!entries || !names || entries.length !== names.length) {
      diagnostics.push({ code: 'INCOMPLETE_MEMBER_NAMES', typeInfoId: typeId, path: parent });
      return;
    }
    const next = new Set(ancestors).add(typeId);
    const lidCounts = new Map();
    const nameCounts = new Map();
    for (const entry of entries) lidCounts.set(entry.lid, (lidCounts.get(entry.lid) ?? 0) + 1);
    for (const name of names) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    for (const [index, entry] of entries.entries()) {
      const name = names[index] || null;
      const path = name && parent !== null ? parent ? `${parent}.${name}` : name : null;
      const accessPath = [...prefix, entry.lid];
      const duplicate = lidCounts.get(entry.lid) !== 1 || (name !== null && nameCounts.get(name) !== 1);
      const relation = entry.offset.relationId;
      const dimensions = entry.offset.dimensions;
      const status = duplicate ? 'AMBIGUOUS' : !name ? 'NAME_UNAVAILABLE' : entry.offset.code === 0 ? 'UNSUPPORTED_FB_ARRAY'
        : relation ? 'CONTAINER' : dimensions.length ? 'ARRAY' : WIRE_TYPES.has(entry.softdatatype) ? 'READABLE' : 'UNSUPPORTED_DATATYPE';
      const member = append(entry, typeId, name, path, parent || null, accessPath, status, dimensions);
      if (duplicate || !name || entry.offset.code === 0) continue;
      if (dimensions.length) {
        const count = dimensions.reduce((total, axis) => total * axis.count, 1);
        if (!Number.isSafeInteger(count) || count === 0 || count > maxMembers - members.length) {
          member.status = 'ARRAY_EXPANSION_LIMIT'; diagnostics.push({ code: member.status, typeInfoId: typeId, path }); continue;
        }
        if (entry.softdatatype === 40) { member.status = 'UNSUPPORTED_PACKED_ARRAY'; continue; }
        for (let ordinal = 0; ordinal < count; ordinal++) {
          let remainder = ordinal;
          const indices = Array(dimensions.length);
          for (let axis = dimensions.length - 1; axis >= 0; axis--) {
            indices[axis] = dimensions[axis].lowerBound + remainder % dimensions[axis].count;
            remainder = Math.floor(remainder / dimensions[axis].count);
          }
          const elementPath = `${path}[${indices.join(',')}]`;
          const elementAccess = [...accessPath, ordinal, ...(relation ? [1] : [])];
          append(entry, typeId, `[${indices.join(',')}]`, elementPath, path, elementAccess, relation ? 'CONTAINER' : WIRE_TYPES.has(entry.softdatatype) ? 'READABLE' : 'UNSUPPORTED_DATATYPE', dimensions);
          if (relation) visit(relation, elementPath, elementAccess, next);
        }
      } else if (relation) visit(relation, path, accessPath, next);
    }
  }
  /** @param {TypeMember} entry @param {number} typeId @param {string|null} name @param {string|null} path @param {string|null} parentPath @param {number[]} accessPath @param {string} status @param {{lowerBound:number,count:number}[]} dimensions */
  function append(entry, typeId, name, path, parentPath, accessPath, status, dimensions) {
    if (members.length >= maxMembers) throw new PlusError('RESPONSE_LIMIT', 'Expanded member budget exceeded');
    if (accessPath.length > 16) status = 'ACCESS_PATH_LIMIT';
    const member = { name, path, parentPath, datatype: SOFTWARE_TYPES[/** @type {keyof typeof SOFTWARE_TYPES} */ (entry.softdatatype)] ?? `UNKNOWN_${entry.softdatatype}`,
      softdatatype: entry.softdatatype, memberId: entry.lid, typeInfoId: typeId, referencedTypeInfoId: entry.offset.relationId,
      accessPath, symbolCrc: entry.symbolCrc, arrayDimensions: dimensions, status, readable: status === 'READABLE' };
    members.push(member);
    return member;
  }
  if (block.typeInfoId) visit(block.typeInfoId, '', [], new Set());
  else diagnostics.push({ code: 'TYPE_UNAVAILABLE', typeInfoId: 0, path: null });
  const pathCounts = new Map();
  for (const member of members) pathCounts.set(member.path, (pathCounts.get(member.path) ?? 0) + 1);
  for (const member of members) if (member.path !== null && pathCounts.get(member.path) > 1) {
    member.status = 'AMBIGUOUS'; member.readable = false;
  }
  return { block, members, diagnostics, completeness: diagnostics.length || members.some(member => !member.readable && member.status !== 'CONTAINER' && member.status !== 'ARRAY') ? 'PARTIAL' : 'COMPLETE' };
}

/** @param {RuntimeMember} member @param {PlusValue} value */
export function validateMemberValue(member, value) {
  const expected = WIRE_TYPES.get(member.softdatatype);
  if (!member.readable || expected === undefined) throw new PlusError('UNSUPPORTED_DATATYPE', 'Member has no qualified scalar read representation');
  if (member.softdatatype === 19) {
    const bytes = value.value;
    if (value.flags !== 0x10 || value.datatype !== 2 || !Array.isArray(bytes) || bytes.length < 2 || bytes.length > 256
      || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)
      || bytes[0] < 1 || bytes[0] > 254 || bytes.length !== bytes[0] + 2 || bytes[1] > bytes[0]) {
      throw new PlusError('DATATYPE_MISMATCH', 'STRING requires a bounded byte array with valid capacity and length');
    }
    return { datatype: member.datatype, value: Buffer.from(bytes.slice(2, 2 + bytes[1])).toString('latin1'), native: value,
      representation: { encoding: 'latin1', maxLength: bytes[0], length: bytes[1] } };
  }
  if (value.flags !== 0 || value.datatype !== expected) throw new PlusError('DATATYPE_MISMATCH', 'Value does not match discovered member datatype', { expectedWireType: expected, actualWireType: value.datatype });
  return { datatype: member.datatype, value: value.value, native: value,
    representation: member.softdatatype === 11 ? { unit: 'ms', signed: true, bits: 32 }
      : member.softdatatype === 64 ? { unit: 'ns', signed: true, bits: 64 } : null };
}

/** @param {RuntimeMember} member */
export function memberValueSize(member) {
  const size = VALUE_SIZES.get(member.softdatatype);
  if (!member.readable || size === undefined) throw new PlusError('UNSUPPORTED_DATATYPE', 'Member has no qualified scalar read representation');
  return size;
}
