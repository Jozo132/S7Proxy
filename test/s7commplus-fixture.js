// @ts-check
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { Duplex } from 'node:stream';
import { TLSSocket, createSecureContext } from 'node:tls';
import { FrameAssembler } from '../src/protocol/frame-assembler.js';
import { Cursor, decodeObjects, u32, vlq } from '../src/protocol/s7commplus/codec.js';
import { metadataExplore } from './s7commplus-metadata-fixture.js';

/** @typedef {{state?:number,challenge?:boolean,stall?:boolean,wrongSequence?:boolean,oversized?:boolean,smallTpdu?:boolean,itemError?:boolean,badTail?:boolean,protectionMarker?:boolean,reject?:'initSSL'|'createSession'|'setupSession',badInitTail?:boolean,createVersion?:number,initVersion?:number,malformed?:'reserved'|'opcode'|'function'|'truncated'|'trailer'|'cotp'|'length'|'genericError'|'duplicate'|'empty',versionSchema?:'missing'|'duplicate'|'invalid'|'foreignOwner',terminate?:boolean,setupError?:boolean,badSetupTail?:boolean,tls?:{key:Buffer,cert:Buffer},abortTLS?:boolean,stallTLS?:boolean,badIntegrity?:boolean,reference?:boolean,compositeReject?:boolean,nonzeroCreateStatus?:boolean,metadata?:boolean,memberError?:boolean,memberTypeMismatch?:boolean,programContent?:boolean,programFailure?:boolean,programStall?:boolean,programEmpty?:boolean}} FixtureOptions */

/** @param {bigint} value */
export function encodeTestUInt64(value) {
  const groups = [];
  for (let shift = 57; shift >= 8; shift -= 7) groups.push(0x80 | Number((value >> BigInt(shift)) & 0x7Fn));
  return Buffer.from([...groups, Number(value & 0xFFn)]);
}

const stages = [0x05B3, 0x04CA, 0x0542];
export const REFERENCE_CREATE_OBJECT = Object.freeze({
  source: 'https://github.com/gijzelaerr/s7commplus',
  commit: '245350ea0ca6327234e5032e781a99782334bc8f',
  origin: 'connection.py:_create_session; independently encoded, not a real-PLC request capture',
  sha256: '1097734503fe14af28a5b3ff6cd9861121f2a414dbb17d57f40bb67926972ed1',
  hex: '720100b031000004ca0000000100000120360000011d00040000000000a1000000d3821f0000a3816900150a7337636f6d6d706c7573a38221001513313a3a3a362e303a3a7337636f6d6d706c7573a3822800150a7337636f6d6d706c7573a38229001500a3822a00150a7337636f6d6d706c7573a3822b000401a3822c001280c3c901a3822d001500a1000000d3817f0000a38169001515537562736372697074696f6e436f6e7461696e6572a2a20000000072010000',
});
const setupGolden = Buffer.from('0000004d010182320100170000013a823b00048400823f0015000000000004e88969001200000000896a001300896b00040000000000000000', 'hex');

/** @param {Buffer} frame */
export function normalizedReferenceCreate(frame) {
  let result = Buffer.from(frame);
  for (const [prefixHex, reference, own] of [
    ['a381690015', 's7commplus', 'S7Proxy'],
    ['a382210015', '1:::6.0::s7commplus', '1:::6.0::S7Proxy'],
    ['a382280015', 's7commplus', 'S7Proxy'],
    ['a3822a0015', 's7commplus', 'S7Proxy'],
  ]) {
    const prefix = Buffer.from(prefixHex, 'hex');
    const before = Buffer.concat([prefix, Buffer.from([reference.length]), Buffer.from(reference)]);
    const after = Buffer.concat([prefix, Buffer.from([own.length]), Buffer.from(own)]);
    const offset = result.indexOf(before);
    assert.ok(offset >= 0 && result.indexOf(before, offset + 1) < 0, 'Exactly one declared reference identity attribute');
    result = Buffer.concat([result.subarray(0, offset), after, result.subarray(offset + before.length)]);
  }
  result.writeUInt16BE(result.length - 8, 2);
  return result;
}

/** @param {Buffer} request @param {number} index @param {boolean} secure @param {boolean} reference */
export function validateSessionRequest(request, index, secure = false, reference = false) {
  assert.equal(request[0], 0x72);
  assert.equal(request.readUInt16BE(2), request.length - 8);
  assert.deepEqual(request.subarray(-4), Buffer.from([0x72, request[1], 0, 0]));
  assert.deepEqual([...request.subarray(4, 7)], [0x31, 0, 0]);
  assert.equal(request.readUInt16BE(9), 0);
  const functionCode = request.readUInt16BE(7);
  assert.equal(request.readUInt16BE(11), index);
  assert.equal(request.readUInt32BE(13), index === 0 ? 0 : index === 1 ? 288 : 77);
  assert.equal(request[17], index === 0 ? 0x30 : index === 1 ? 0x36 : 0x34);
  assert.equal(request[1], index < 2 ? 1 : index === 2 || secure ? 2 : 1);
  if (index < 3) assert.equal(functionCode, stages[index]);
  else assert.ok([0x04BB, 0x054C, 0x0586].includes(functionCode), 'Fixture accepts no process writes or control');
  const payload = request.subarray(18, -4);
  if (index === 0) assert.deepEqual(payload, Buffer.alloc(4));
  if (index === 1) {
    const golden = Buffer.from(REFERENCE_CREATE_OBJECT.hex, 'hex');
    assert.deepEqual(request, reference ? golden : normalizedReferenceCreate(golden), 'Complete independent reference CreateObject bytes');
    assert.deepEqual(payload.subarray(0, 11), Buffer.from('0000011d00040000000000', 'hex'));
    const objects = decodeObjects(new Cursor(payload.subarray(11)));
    assert.equal(objects.length, 2);
    assert.deepEqual(objects.map(entry => [entry.rid, entry.classId, entry.classFlags, entry.attributeId]), [[211, 287, 0, 0], [211, 255, 0, 0]]);
    assert.deepEqual(objects[0].attributes.map(attribute => attribute.id), [233, 289, 296, 297, 298, 299, 300, 301]);
    if (!reference) assert.deepEqual(objects[0].attributes.map(attribute => attribute.value.value), ['S7Proxy', '1:::6.0::S7Proxy', 'S7Proxy', '', 'S7Proxy', 1, 0x80C3C901, '']);
    assert.equal(objects[1].attributes[0].value.value, 'SubscriptionContainer');
    assert.deepEqual(payload.subarray(-4), Buffer.alloc(4));
  }
  if (index === 2) assert.deepEqual(payload, secure ? setupGolden.subarray(0, -2) : setupGolden, 'Only the owned session version may be echoed; retain member 315 and blank member 319');
  return functionCode;
}

/** @param {FixtureOptions & {programProtected?:boolean,states?:number[]}} [options] */
export async function fixture(options = {}) {
  /** @type {import('node:net').Socket[]} */
  const sockets = [];
  /** @type {TLSSocket[]} */
  const secureSockets = [];
  /** @type {{functionCode:number,sequence:number,receivedAt:number,frame:Buffer}[]} */
  const requests = [];
  /** @type {Buffer[]} */
  const cotpRequests = [];
  /** @type {string[]} */
  const errors = [];
  let tlsRecords = 0;
  const server = createServer(socket => {
    sockets.push(socket);
    const assembler = new FrameAssembler();
    /** @type {Duplex|undefined} */
    let tunnel;
    /** @type {TLSSocket|undefined} */
    let secureSocket;
    let application = Buffer.alloc(0);
    let stateReads = 0;
    /** @param {Buffer} data */
    function sendDT(data) {
      for (let offset = 0; offset < data.length; offset += 1000) {
        const part = data.subarray(offset, offset + 1000);
        const response = Buffer.concat([Buffer.from([3, 0, (part.length + 7) >> 8, (part.length + 7) & 255, 2, 0xF0, offset + 1000 >= data.length ? 0x80 : 0]), part]);
        socket.write(response.subarray(0, 5));
        socket.write(response.subarray(5));
      }
    }
    /** @param {Buffer} bytes */
    function onApplication(bytes) {
      application = Buffer.concat([application, bytes]);
      if (application.length < 4) return;
      const length = application.readUInt16BE(2) + 8;
      if (application.length < length) return;
      const request = application.subarray(0, length);
      application = application.subarray(length);
      const sequence = request.readUInt16BE(11);
      const functionCode = validateSessionRequest(request, requests.length, !!secureSocket, options.reference ?? false);
      requests.push({ functionCode, sequence, receivedAt: Date.now(), frame: Buffer.from(request) });
      if (options.terminate) { socket.end(); return; }
      if (options.stall) return;
      const header = Buffer.alloc(10);
      header[0] = 0x32; header.writeUInt16BE(functionCode, 3);
      header.writeUInt16BE(options.wrongSequence ? sequence + 1 : sequence, 7);
      let payload = Buffer.from([0, 0]);
      if (functionCode === 0x05B3) payload = options.badInitTail ? Buffer.from([0, 0, 0, 0, 1]) : Buffer.alloc(5);
      else if (functionCode === 0x0542) payload = options.setupError ? Buffer.from([0, 1]) : options.badSetupTail ? Buffer.from([0, 0, 99]) : Buffer.alloc(7);
      else if (functionCode === 0x04CA) {
        const paom = Buffer.from('1;TEST-ORDER;V0.0');
        const version = Buffer.concat([Buffer.from([0, 23]), u32(314), Buffer.from('823b00048400', 'hex'), vlq(319), Buffer.from([0, 21]), vlq(paom.length), paom, Buffer.from([0])]);
        const attributes = options.versionSchema === 'missing' ? [] : [{ id: 306, raw: options.versionSchema === 'invalid' ? Buffer.from([0, 1, 1]) : version }];
        if (options.versionSchema === 'duplicate') attributes.push({ id: 306, raw: version });
        if (options.challenge) attributes.push({ id: 303, raw: Buffer.from([0x10, 2, 1, 42]) });
        payload = Buffer.concat([Buffer.from([0, 1]), vlq(77), object(options.versionSchema === 'foreignOwner' ? 88 : 288, attributes, 287)]);
        if (options.nonzeroCreateStatus) payload[0] = 18;
      } else if (functionCode === 0x04BB) {
        const objectId = request.readUInt32BE(18);
        payload = Buffer.concat([Buffer.from([0]), object(objectId, objectId === 52 ? [{ id: 0x8BD,
          raw: Buffer.concat([Buffer.from([0, 23]), u32(0xD99), vlq(0xD9E), Buffer.from([0, 8, options.states?.[stateReads++] ?? options.state ?? 8, 0])]) }] : [])]);
      } else if (functionCode === 0x0586) payload = Buffer.from(options.programContent ? [0, 0, 4, 1] : options.protectionMarker ? [0, 0, 0, 4, 2, 0] : [0, 0, 4, 2]);
      else if (functionCode === 0x054C) payload = options.itemError ? Buffer.concat([Buffer.from([0, 0, 1]), vlq(0x8104), Buffer.from([0])])
        : Buffer.from([0, 1, 0, 8, 42, 0, 0, ...(options.badTail ? [99] : [])]);
      if (options.metadata && functionCode === 0x04BB && request.readUInt32BE(18) !== 52) {
        payload = Buffer.concat([Buffer.from([0]), metadataExplore(request.readUInt32BE(18))]);
      }
      if (options.programContent && functionCode === 0x04BB && request.readUInt32BE(18) !== 52) {
        const rid = request.readUInt32BE(18);
        if (options.programStall && rid !== 3) return;
        payload = options.programFailure && rid === 0x8A130008 ? Buffer.from([1])
          : Buffer.concat([Buffer.from([0]), programExplore(rid, options.programEmpty ?? false, options.programProtected ? 1 : 0)]);
      }
      if (options.metadata && functionCode === 0x054C && !options.itemError) {
        const cursor = new Cursor(request.subarray(18, -4));
        cursor.uint32(); cursor.uint(); cursor.uint();
        assert.equal(cursor.uint(), 0, 'Browsed type-entry CRC must not be used as an address CRC');
        cursor.uint();
        const count = cursor.uint() - 1;
        cursor.uint();
        const path = Array.from({ length: count }, () => cursor.uint());
        const value = path[0] === 1 ? Buffer.concat([Buffer.from([0, 18]), u32(0x92000007)])
          : path.at(-1) === 107 ? Buffer.from([0, 7, 0xFF, 0x85])
          : path.at(-1) === 112 ? Buffer.from([0, 8, 0x7F]) : Buffer.from([0, 1, 1]);
        payload = options.memberError && path[0] !== 1 ? Buffer.concat([Buffer.from([0, 0, 1]), vlq(0x8104), Buffer.from([0])])
          : Buffer.concat([Buffer.from([0, 1]), options.memberTypeMismatch && path[0] !== 1 ? Buffer.from([0, 7, 0, 1]) : value, Buffer.from([0, 0])]);
      }
      if (stages.indexOf(functionCode) === ['initSSL', 'createSession', 'setupSession'].indexOf(options.reject ?? '') && options.reject) payload = Buffer.from([1, 0]);
      if (options.compositeReject && functionCode === 0x04CA) payload = Buffer.concat([encodeTestUInt64(0x8000000000008001n), Buffer.alloc(5)]);
      if (secureSocket && sequence > 2) {
        const integrity = vlq(options.badIntegrity ? 99 : sequence + sequence - 3);
        if (functionCode === 0x04BB) payload = Buffer.concat([payload.subarray(0, 1), u32(request.readUInt32BE(18)), integrity, payload.subarray(1), Buffer.alloc(4)]);
        else payload = Buffer.concat([payload, integrity]);
      }
      if (options.malformed === 'reserved') header[1] = 1;
      if (options.malformed === 'opcode') header[0] = 0x31;
      if (options.malformed === 'function') header.writeUInt16BE(0x054C, 3);
      if (options.malformed === 'genericError') header.writeUInt16BE(0x04B1, 3);
      const body = Buffer.concat([header, payload]);
      const version = functionCode === 0x05B3 ? options.initVersion ?? 1 : functionCode === 0x04CA ? options.createVersion ?? 1 : secureSocket && sequence >= 2 ? 2 : 1;
      const outer = Buffer.from([0x72, version, body.length >> 8, body.length & 255]);
      let plus = options.oversized ? Buffer.from('7201ffff', 'hex') : Buffer.concat([outer, body, Buffer.from([0x72, version, 0, 0])]);
      if (options.programContent && functionCode === 0x04BB && ![3, 52].includes(request.readUInt32BE(18))) {
        const split = Math.floor(body.length / 2);
        plus = Buffer.concat([Buffer.from([0x72, version, split >> 8, split & 255]), body.subarray(0, split),
          Buffer.from([0x72, version, (body.length - split) >> 8, (body.length - split) & 255]), body.subarray(split),
          Buffer.from([0x72, version, 0, 0])]);
      }
      if (options.malformed === 'empty') plus = Buffer.from('72010000', 'hex');
      if (options.malformed === 'length') plus.writeUInt16BE(body.length + 1, 2);
      if (options.malformed === 'trailer') plus = plus.subarray(0, -4);
      if (options.malformed === 'truncated') plus = plus.subarray(0, 8);
      if (options.malformed === 'duplicate') plus = Buffer.concat([plus, plus]);
      if (options.malformed === 'cotp') { socket.write(Buffer.from('0300000702e080', 'hex')); return; }
      if (secureSocket) secureSocket.write(plus); else sendDT(plus);
      if (options.abortTLS && functionCode === 0x05B3) { socket.end(); return; }
      if (options.malformed === 'truncated') socket.end();
      if (options.tls && functionCode === 0x05B3) {
        tunnel = new Duplex({ read() {}, write(chunk, encoding, callback) { sendDT(Buffer.from(chunk)); callback(); } });
        tunnel.on('error', () => {});
        secureSocket = new TLSSocket(tunnel, { isServer: true, secureContext: createSecureContext(options.tls), minVersion: 'TLSv1.2' });
        secureSockets.push(secureSocket);
        secureSocket.on('error', () => {});
        secureSocket.on('data', (/** @type {Buffer} */ chunk) => {
          try { onApplication(chunk); } catch (error) { errors.push(String(error)); socket.destroy(); }
        });
      }
    }
    socket.on('error', () => {});
    socket.on('data', (/** @type {Buffer} */ bytes) => {
      try {
        for (const frame of assembler.feed(bytes)) {
          if (frame[5] === 0xE0) {
            cotpRequests.push(Buffer.from(frame));
            socket.write(Buffer.from(options.smallTpdu ? '0300000e09d00001000100c00107' : '0300000e09d00001000100c0010a', 'hex'));
          } else if (tunnel) { tlsRecords++; if (!options.stallTLS) tunnel.push(frame.subarray(7)); }
          else onApplication(frame.subarray(7));
        }
      } catch (error) { errors.push(String(error)); socket.destroy(); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address');
  return { port: address.port, requests, cotpRequests, errors, get tlsRecords() { return tlsRecords; }, close: async () => {
    for (const socket of secureSockets) socket.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(() => resolve(undefined)));
  } };
}

/** @param {number} rid @param {{id:number,raw:Buffer}[]} attributes @param {number} [classId] */
function object(rid, attributes, classId = 1) {
  return Buffer.concat([Buffer.from([0xA1]), u32(rid), vlq(classId), Buffer.from([0, 0]),
    ...attributes.map(attribute => Buffer.concat([Buffer.from([0xA3]), vlq(attribute.id), attribute.raw])), Buffer.from([0xA2])]);
}

/** @param {number} rid @param {boolean} empty @param {number} [protectionMode] */
export function programExplore(rid, empty, protectionMode = 0) {
  const blocks = [[0x8A0E0007, 2574, 7, 'Storage'], [0x8A130008, 2579, 8, 'Routine'], [0x8A320009, 2647, 9, 'Cycle']];
  const objects = blocks.filter(block => rid === 3 || block[0] === rid).map(block => {
    const [id, classId, number, name] = block;
    const text = Buffer.from(String(name));
    const attributes = [{ id: 233, raw: Buffer.concat([Buffer.from([0, 21]), vlq(text.length), text]) },
      { id: 2521, raw: Buffer.from([0, 3, Number(number) >>> 8, Number(number) & 255]) },
      { id: 2524, raw: Buffer.concat([Buffer.from([0, 23]), u32(3447), vlq(3448), Buffer.from([0, 11, 0, id === 0x8A130008 ? protectionMode : 0, 0])]) }];
    if (rid !== 3) {
      const bytes = empty ? Buffer.alloc(0) : Buffer.from([0x10, Number(number), 0, 0xFF]);
      attributes.push({ id: id === 0x8A0E0007 ? 2544 : 2580, raw: Buffer.concat([Buffer.from([0, 20, 0]), vlq(bytes.length), bytes]) });
    }
    return object(Number(id), attributes, Number(classId));
  });
  return rid === 3 ? Buffer.concat([object(3, [], 2520).subarray(0, -1), ...objects, Buffer.from([0xA2])]) : Buffer.concat(objects);
}