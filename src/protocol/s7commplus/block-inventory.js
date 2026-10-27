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

/** @param {ReturnType<typeof decodeProgramInventory>} inventory @param {{objectId:number,objects:PlusObject[],receivedAt:string}} evidence @param {number} [maxEvents] */
export function decodeProgramEventMetadata(inventory, evidence, maxEvents = 128) {
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 128) throw new PlusError('ARGUMENT', 'Select maxEvents in 1..128');
  const advertised = inventory.evidence.objects.filter(object => object.rid === 10 && object.classId === 2483 && object.parentRid === 3);
  const roots = evidence.objects.filter(object => object.rid === 10 && object.classId === 2483 && object.parentRid === null);
  if (evidence.objectId !== 10 || advertised.length !== 1 || roots.length !== 1
    || attribute(advertised[0], 233)?.value !== 'SWEvents' || attribute(roots[0], 233)?.value !== 'SWEvents') {
    throw new PlusError('METADATA_MISMATCH', 'Software-event root does not match the observed program inventory');
  }
  const seen = new Set();
  const events = [];
  /** @type {{code:string,objectRid:number,relationId?:number,targetRid?:number}[]} */
  const diagnostics = [];
  for (const object of evidence.objects) {
    if (seen.has(object.rid)) throw new PlusError('AMBIGUOUS_METADATA', 'Repeated software-event object RID');
    if (object.rid !== 10 && (object.parentRid !== 10 || !seen.has(10))) {
      throw new PlusError('MALFORMED_METADATA', 'Software-event object is outside the expected container');
    }
    seen.add(object.rid);
    const nameValue = attribute(object, 233);
    if (nameValue && (nameValue.flags !== 0 || nameValue.datatype !== 21 || typeof nameValue.value !== 'string')) {
      throw new PlusError('MALFORMED_METADATA', 'Software-event name is not a scalar native string');
    }
    if (object.rid === 10) continue;
    if (events.length >= maxEvents) throw new PlusError('RESPONSE_LIMIT', 'Software-event count exceeds maxEvents');
    if (!nameValue) diagnostics.push({ code: 'EVENT_NAME_UNAVAILABLE', objectRid: object.rid });
    const relations = (object.relations ?? []).map(relation => {
      const matches = inventory.blocks.filter(block => block.objectRid === relation.targetRid && block.status === 'IDENTIFIED');
      const target = matches.length === 1 ? matches[0] : null;
      if (!target) diagnostics.push({ code: 'RELATION_TARGET_UNRESOLVED', objectRid: object.rid, relationId: relation.id, targetRid: relation.targetRid });
      return { id: relation.id, targetRid: relation.targetRid,
        status: target ? 'RESOLVED_IN_INVENTORY' : 'UNRESOLVED',
        targetBlock: target ? { type: target.type, number: target.number, name: target.name, objectRid: target.objectRid, classId: target.classId } : null };
    });
    events.push({ objectRid: object.rid, classId: object.classId, parentRid: object.parentRid,
      name: nameValue ? String(nameValue.value) : null, relations, nativeAttributes: structuredClone(object.attributes) });
  }
  return { status: diagnostics.length ? 'PARTIAL' : 'BOUNDED_METADATA', events, diagnostics,
    completeness: 'BOUNDED_EVENT_METADATA_NOT_EXECUTION_HISTORY', revisionStatus: 'UNKNOWN', atomicSnapshot: false,
    relationSemantics: 'UNINTERPRETED_NATIVE_RELATIONS', blockContentRetrieved: false,
    receivedAt: evidence.receivedAt, inventoryReceivedAt: inventory.receivedAt, evidence, inventory };
}
