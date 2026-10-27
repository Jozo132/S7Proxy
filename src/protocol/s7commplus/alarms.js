// @ts-check
/** @import { PlusObject, PlusValue } from './codec.js' */

/** @param {PlusObject[]} objects @param {{languageId:number,maxAlarms:number}} options */
export function decodeCurrentAlarms(objects, { languageId, maxAlarms }) {
  /** @type {{code:string,alarmRid?:number,attributeId?:number}[]} */
  const diagnostics = [];
  const candidates = objects.filter(object => object.classId === 2681);
  for (const object of objects) {
    if (object.classId !== 2681 && object.rid !== 8) diagnostics.push({ code: 'UNRECOGNIZED_ALARM_OBJECT', alarmRid: object.rid });
  }
  const alarms = candidates.slice(0, maxAlarms).map(object => {
    const before = diagnostics.length;
    /** @param {string} code @param {number} attributeId */
    const note = (code, attributeId) => diagnostics.push({ code, alarmRid: object.rid, attributeId });
    /** @param {{id:number,value:PlusValue}[]} attributes @param {number} id @param {number} datatype */
    const value = (attributes, id, datatype) => {
      const matches = attributes.filter(attribute => attribute.id === id);
      if (matches.length !== 1) { note(matches.length ? 'AMBIGUOUS_ALARM_FIELD' : 'ALARM_FIELD_UNAVAILABLE', id); return null; }
      if (matches[0].value.flags !== 0 || matches[0].value.datatype !== datatype) { note('INVALID_ALARM_FIELD', id); return null; }
      return matches[0].value.value;
    };
    /** @param {{id:number,value:PlusValue}[]} attributes @param {number} id */
    const timestamp = (attributes, id) => {
      const raw = value(attributes, id, 16);
      if (raw === null) return null;
      if (typeof raw !== 'string' || !/^\d+$/.test(raw)) { note('INVALID_ALARM_TIMESTAMP', id); return null; }
      const nanoseconds = BigInt(raw);
      return { nanosecondsSinceUnixEpoch: raw, utc: nanoseconds === 0n ? null : new Date(Number(nanoseconds / 1000000n)).toISOString(),
        subMillisecondNanoseconds: Number(nanoseconds % 1000000n), clockSynchronized: 'UNKNOWN' };
    };
    /** @param {number} id */
    const transition = id => {
      if (!object.attributes.some(attribute => attribute.id === id)) return null;
      const members = value(object.attributes, id, 23);
      if (!Array.isArray(members)) return null;
      return { stateBits: value(members, 3474, 2), timestamp: timestamp(members, 3475),
        acknowledgementTimestamp: timestamp(members, 3646),
        associatedValues: members.find(member => member.id === 3476)?.value ?? null,
        associatedValuesDecoded: false };
    };
    const cpuAlarmId = value(object.attributes, 2670, 13);
    const stateBits = value(object.attributes, 2671, 2);
    const alarmDomain = value(object.attributes, 2672, 3);
    const messageType = value(object.attributes, 4079, 8);
    const sequenceCounter = value(object.attributes, 7917, 4);
    const name = value(object.attributes, 233, 21);
    const coming = transition(2673);
    const going = transition(2677);
    if (!coming && !going) note('ALARM_TRANSITION_UNAVAILABLE', 2673);
    /** @type {{key:number,languageId:number,textId:number,text:string}[]} */
    const texts = [];
    const textAttributes = object.attributes.filter(attribute => attribute.id === 2715);
    if (textAttributes.length !== 1 || textAttributes[0].value.flags !== 0x40 || textAttributes[0].value.datatype !== 20) {
      note('ALARM_TEXTS_UNAVAILABLE', 2715);
    } else {
      for (const entry of textAttributes[0].value.value) {
        try {
          texts.push({ key: entry.key, languageId: entry.key >>> 16, textId: entry.key & 0xFFFF,
            text: new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes) });
        } catch { note('INVALID_ALARM_TEXT', 2715); }
      }
    }
    const selected = texts.filter(text => text.languageId === languageId);
    if (!selected.some(text => text.textId === 2)) note('REQUESTED_ALARM_TEXT_UNAVAILABLE', 2715);
    return { objectRid: object.rid, cpuAlarmId, name, stateBits, alarmDomain, messageType, sequenceCounter,
      coming, going, languageId, text: selected.find(text => text.textId === 2)?.text ?? null,
      infoText: selected.find(text => text.textId === 1)?.text ?? null, texts,
      availableLanguages: [...new Set(texts.map(text => text.languageId))],
      status: diagnostics.length === before ? 'DECODED' : 'PARTIAL', evidence: object };
  });
  const truncated = candidates.length > maxAlarms;
  return { alarms, reportedAlarmCount: candidates.length, languageId, truncated,
    completeness: truncated ? 'TRUNCATED' : diagnostics.length ? 'PARTIAL' : 'BOUNDED_RESPONSE', diagnostics,
    scope: 'CURRENT_UPDATE_RELEVANT_ALARMS_NOT_DIAGNOSTIC_HISTORY', stateBitSemantics: 'UNQUALIFIED',
    alarmTextPlaceholdersExpanded: false };
}