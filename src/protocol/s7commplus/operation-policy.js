// @ts-check
const policies = Object.freeze({
  initSSL: 'SESSION_HOUSEKEEPING',
  createSession: 'SESSION_HOUSEKEEPING',
  setupSession: 'SESSION_HOUSEKEEPING',
  explore: 'READ_ONLY_METADATA',
  read: 'READ_ONLY_VALUES',
  readAttribute: 'READ_ONLY_METADATA',
  readBlockContent: 'READ_ONLY_RESOURCE_BOUNDED_PROGRAM_CONTENT',
});

export const BLOCK_CONTENT_ATTRIBUTES = Object.freeze([233, 2521, 2580, 2533, 2544, 2546, 2582, 2583]);

/** @param {string} kind */
export function getOperationPolicy(kind) {
  if (Object.hasOwn(policies, kind)) return { classification: policies[/** @type {keyof typeof policies} */ (kind)], allowed: true };
  if (['cpuStop', 'cpuStart', 'cpuControl'].includes(kind)) return { classification: 'HIGH_IMPACT_MODE_CHANGE', allowed: false };
  if (['write', 'download', 'delete', 'force', 'setVariable', 'setSecurity'].includes(kind)) return { classification: 'FORBIDDEN_MODIFICATION', allowed: false };
  if (['uploadProgramBlock', 'uploadProgram', 'controllerBackup'].includes(kind)) return { classification: 'UNQUALIFIED_TRANSFER', allowed: false };
  return { classification: 'UNKNOWN', allowed: false };
}
