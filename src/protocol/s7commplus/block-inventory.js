// @ts-check
import { PlusError } from './codec.js';

/** @import { PlusObject } from './codec.js' */
const blockClasses = new Map([
  [2574, { type: 'DB', prefix: 0x8A0E }],
  [2579, { type: 'FC', prefix: 0x8A13 }],
  [2647, { type: 'OB', prefix: 0x8A32 }],
]);

export const PROGRAM_INVENTORY_ATTRIBUTES = Object.freeze([233, 2521, 2523, 2524, 2527, 2532]);

/** @param {PlusObject} object @param {number} id */
function attribute(object, id) {
  const matches = object.attributes.filter(attribute => attribute.id === id);
  if (matches.length > 1) throw new PlusError('AMBIGUOUS_METADATA', 'Repeated program-block attribute', { objectRid: object.rid, attributeId: id });
  return matches[0]?.value ?? null;
}

/** @param {{objectId:number,objects:PlusObject[],receivedAt:string}} evidence */
export function decodeProgramInventory(evidence) {
  const roots = evidence.objects.filter(object => object.rid === 3 && object.classId === 2520 && object.parentRid === null);
  if (evidence.objectId !== 3 || roots.length !== 1) throw new PlusError('MALFORMED_METADATA', 'Expected exactly one native program root');
  const seen = new Set();
  const blocks = [];
  const otherObjects = [];
  for (const object of evidence.objects) {
    if (seen.has(object.rid)) throw new PlusError('AMBIGUOUS_METADATA', 'Repeated native program object RID');
    if (object.rid !== 3 && (object.parentRid === null || !seen.has(object.parentRid))) {
      throw new PlusError('MALFORMED_METADATA', 'Program inventory contains an object outside its native root');
    }
    seen.add(object.rid);
    if (object.rid === 3) continue;
    const classification = blockClasses.get(object.classId);
    const numberValue = attribute(object, 2521);
    if (!classification && !numberValue) {
      otherObjects.push({ objectRid: object.rid, classId: object.classId, parentRid: object.parentRid });
      continue;
    }
    const nameValue = attribute(object, 233);
    if (nameValue && (nameValue.flags !== 0 || nameValue.datatype !== 21 || typeof nameValue.value !== 'string')) {
      throw new PlusError('MALFORMED_METADATA', 'Program-block name is not a scalar native string');
    }
    if (numberValue && (numberValue.flags !== 0 || ![3, 4].includes(numberValue.datatype)
      || !Number.isInteger(numberValue.value) || numberValue.value < 0 || numberValue.value > 65535)) {
      throw new PlusError('MALFORMED_METADATA', 'Invalid native program-block number');
    }
    const number = numberValue ? Number(numberValue.value) : null;
    if (classification && ((object.rid >>> 16) !== classification.prefix
      || (number !== null && (object.rid & 0xFFFF) !== number))) {
      throw new PlusError('METADATA_MISMATCH', 'Program-block class, RID and number disagree', { objectRid: object.rid, classId: object.classId, number });
    }
    const language = attribute(object, 2523);
    const languageCode = language?.flags === 0 && typeof language.value === 'number' && Number.isInteger(language.value) ? language.value : null;
    blocks.push({
      type: classification?.type ?? 'UNKNOWN', number, name: nameValue ? String(nameValue.value) : null,
      objectRid: object.rid, classId: object.classId, parentRid: object.parentRid,
      status: !classification ? 'UNSUPPORTED_BLOCK_CLASS' : number === null ? 'INCOMPLETE_METADATA' : 'IDENTIFIED',
      languageCode,
      diagnostics: language && languageCode === null ? [{ code: 'UNSUPPORTED_ATTRIBUTE_ENCODING', attributeId: 2523,
        flags: language.flags, datatype: language.datatype }] : [],
      knowHowProtection: attribute(object, 2524) ? 'REPORTED_UNINTERPRETED' : 'UNKNOWN',
      nativeAttributes: structuredClone(object.attributes),
      definitionKind: 'UNKNOWN', dependencies: { status: 'UNAVAILABLE', objectRids: [] },
      content: { status: 'NOT_RETRIEVED', byteCount: null },
    });
  }
  return { blocks, otherObjects, receivedAt: evidence.receivedAt,
    completeness: 'BOUNDED_NATIVE_INVENTORY_NOT_PROVEN_EXHAUSTIVE', evidence };
}
