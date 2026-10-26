// @ts-check
import { createHash } from 'node:crypto';
import { PlusError } from './codec.js';

/** @import { decodeProgramInventory } from './block-inventory.js' */
/** @import { PlusValue } from './codec.js' */
/** @typedef {ReturnType<typeof decodeProgramInventory>['blocks'][number]} ProgramBlock */
export { BLOCK_CONTENT_ATTRIBUTES } from './operation-policy.js';
const components = new Map([
  [2580, 'CODE_BLOCK'], [2533, 'BODY_DESCRIPTION'], [2544, 'INTERFACE_DESCRIPTION'],
  [2546, 'LINE_COMMENTS'], [2582, 'EXTERNAL_REFERENCE_DATA'], [2583, 'INTERNAL_REFERENCE_DATA'],
]);

/** @param {Buffer} bytes */
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

/** @param {PlusValue} value @returns {{key:number|null,blobRootId:number|null,byteCount:number,bytes:Buffer}[]|null} */
function contentParts(value) {
  if (value.datatype !== 20) return null;
  if (value.flags === 0 && Buffer.isBuffer(value.value) && value.blobLength === value.value.length) {
    return [{ key: null, blobRootId: value.blobRootId ?? null, byteCount: value.value.length, bytes: Buffer.from(value.value) }];
  }
  if (value.flags === 0x40 && Array.isArray(value.value)) return value.value.map((/** @type {{key:number,blobRootId:number,byteCount:number,bytes:Buffer}} */ entry) => {
    if (!Buffer.isBuffer(entry.bytes) || entry.byteCount !== entry.bytes.length) throw new PlusError('MALFORMED_RESPONSE', 'Sparse BLOB declared length differs from content');
    return { ...entry, bytes: Buffer.from(entry.bytes) };
  });
  return null;
}

/** @param {ProgramBlock} block @param {{objects:import('./codec.js').PlusObject[],receivedAt:string,correlation:{fragmentCount:number,responseBody:Buffer,sequence?:number,functionCode?:number,integrityId?:number|null,request?:import('./codec.js').PlusOperation}}} evidence */
export function decodeBlockContent(block, evidence) {
  const matches = evidence.objects.filter(object => object.rid === block.objectRid && object.classId === block.classId && object.parentRid === null);
  if (matches.length !== 1 || evidence.objects.length !== 1) throw new PlusError('CORRELATION', 'Block response contains a foreign or ambiguous native object');
  const object = matches[0];
  if (new Set(object.attributes.map(attribute => attribute.id)).size !== object.attributes.length) throw new PlusError('AMBIGUOUS_METADATA', 'Repeated block-content attribute');
  const number = object.attributes.find(attribute => attribute.id === 2521)?.value;
  const name = object.attributes.find(attribute => attribute.id === 233)?.value;
  if (!number || number.flags !== 0 || ![3, 4].includes(number.datatype) || number.value !== block.number
    || !name || name.flags !== 0 || name.datatype !== 21 || name.value !== block.name) {
    throw new PlusError('CORRELATION', 'Returned block name or number differs from the inventoried object');
  }
  let byteCount = 0;
  const artifacts = [...components].map(([attributeId, role]) => {
    const value = object.attributes.find(attribute => attribute.id === attributeId)?.value;
    const parts = value ? contentParts(value) : null;
    const size = parts?.reduce((sum, part) => sum + part.byteCount, 0) ?? 0;
    byteCount += size;
    return { attributeId, role, status: !value ? 'ABSENT' : !parts ? 'UNSUPPORTED_ENCODING' : !size ? 'EMPTY' : 'RETRIEVED',
      byteCount: size, parts, rawAttribute: value ? Buffer.from(value.raw) : null,
      rawAttributeSha256: value ? digest(value.raw) : null };
  });
  const code = artifacts.find(artifact => artifact.role === 'CODE_BLOCK' && artifact.status === 'RETRIEVED');
  const primary = code ?? artifacts.find(artifact => artifact.role === 'INTERFACE_DESCRIPTION' && artifact.status === 'RETRIEVED');
  const primaryPart = primary?.parts?.length === 1 ? primary.parts[0] : null;
  const rawBytes = primaryPart ? Buffer.from(primaryPart.bytes) : primary?.rawAttribute ? Buffer.from(primary.rawAttribute) : null;
  const identity = { type: block.type, number: block.number, name: block.name, objectRid: block.objectRid, classId: block.classId };
  const files = artifacts.flatMap(artifact => {
    const nativeAttribute = artifact.rawAttribute;
    if (!nativeAttribute || !['RETRIEVED', 'UNSUPPORTED_ENCODING'].includes(artifact.status)) return [];
    const part = artifact.parts?.length === 1 ? artifact.parts[0] : null;
    const bytes = Buffer.from(part ? part.bytes : nativeAttribute);
    return [{
      name: `${block.type}${block.number}-${artifact.role.toLowerCase().replaceAll('_', '-')}.bin`,
      bytes, byteCount: bytes.length, sha256: digest(bytes), block: { ...identity },
      component: artifact.role, attributeId: artifact.attributeId, status: artifact.status,
      format: part ? 'BLOB_PAYLOAD' : 'NATIVE_PVALUE', nativeAttribute: Buffer.from(nativeAttribute),
    }];
  });
  return {
    artifactClass: primary ? 'BLOCK_CONTENT' : null,
    status: code ? 'CODE_CONTENT_RETRIEVED' : primary ? 'DEFINITION_ONLY' : 'UNAVAILABLE',
    block: identity, files,
    contentKind: code ? 'OPAQUE_NATIVE_CODE_BLOCK' : primary ? 'INTERFACE_DEFINITION_ONLY' : null,
    primaryComponent: primary?.role ?? null, rawFormat: primaryPart ? 'BLOB_PAYLOAD' : rawBytes ? 'NATIVE_PVALUE' : null,
    rawBytes, sha256: rawBytes ? digest(rawBytes) : null, byteCount: rawBytes?.length ?? 0,
    totalComponentBytes: byteCount, components: artifacts,
    retrievedAt: evidence.receivedAt,
    transfer: { operation: 'EXPLORE_ATTRIBUTE_READ', protocolFragmentCount: evidence.correlation.fragmentCount,
      completeness: 'COMPLETE_FRAMED_RESPONSE_AND_LENGTH_CHECKED_VALUES', substreamedTransfer: false },
    completeness: { block: 'AVAILABLE_NATIVE_COMPONENTS_ONLY', fullLoadMemory: 'UNVERIFIED', restore: 'UNVERIFIED' },
    restorable: false, evidence,
  };
}
