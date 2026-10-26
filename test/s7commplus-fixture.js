// @ts-check
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { Duplex } from 'node:stream';
import { TLSSocket, createSecureContext } from 'node:tls';
import { FrameAssembler } from '../src/protocol/frame-assembler.js';
import { Cursor, decodeObjects, u32, vlq } from '../src/protocol/s7commplus/codec.js';

/** @typedef {{state?:number,challenge?:boolean,stall?:boolean,wrongSequence?:boolean,oversized?:boolean,smallTpdu?:boolean,itemError?:boolean,badTail?:boolean,protectionMarker?:boolean,reject?:'initSSL'|'createSession'|'setupSession',badInitTail?:boolean,createVersion?:number,malformed?:'reserved'|'opcode'|'function'|'truncated'|'trailer'|'cotp'|'length'|'genericError'|'duplicate'|'empty',versionSchema?:'missing'|'duplicate'|'invalid'|'foreignOwner',terminate?:boolean,setupError?:boolean,badSetupTail?:boolean,tls?:{key:Buffer,cert:Buffer},badIntegrity?:boolean,reference?:boolean,capturedReject?:boolean}} FixtureOptions */

const stages = [0x05B3, 0x04CA, 0x0542];
const setupGolden = Buffer.from('0000004d010182320100170000013a823b00048400823f0015000000000004e88969001200000000896a001300896b00040000000000000000', 'hex');

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

/** @param {FixtureOptions} [options] */
export async function fixture(options = {}) {
  /** @type {import('node:net').Socket[]} */
  const sockets = [];
  /** @type {TLSSocket[]} */
  const secureSockets = [];
  /** @type {{functionCode:number,sequence:number,receivedAt:number,frame:Buffer}[]} */
  const requests = [];
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
      } else if (functionCode === 0x04BB) {
        const objectId = request.readUInt32BE(18);
        payload = Buffer.concat([Buffer.from([0]), object(objectId, objectId === 52 ? [{ id: 0x8BD,
          raw: Buffer.concat([Buffer.from([0, 23]), u32(0xD99), vlq(0xD9E), Buffer.from([0, 8, options.state ?? 8, 0])]) }] : [])]);
      } else if (functionCode === 0x0586) payload = Buffer.from(options.protectionMarker ? [0, 0, 0, 4, 2, 0] : [0, 0, 4, 2]);
      else if (functionCode === 0x054C) payload = options.itemError ? Buffer.concat([Buffer.from([0, 0, 1]), vlq(0x8104), Buffer.from([0])])
        : Buffer.from([0, 1, 0, 8, 42, 0, 0, ...(options.badTail ? [99] : [])]);
      if (stages.indexOf(functionCode) === ['initSSL', 'createSession', 'setupSession'].indexOf(options.reject ?? '') && options.reject) payload = Buffer.from([1, 0]);
      if (options.capturedReject && functionCode === 0x04CA) payload = Buffer.from('d180bae08087f3fdf80000000000', 'hex');
      if (secureSocket && sequence > 2) payload = Buffer.concat([payload, vlq(options.badIntegrity ? 99 : sequence - 3)]);
      if (options.malformed === 'reserved') header[1] = 1;
      if (options.malformed === 'opcode') header[0] = 0x31;
      if (options.malformed === 'function') header.writeUInt16BE(0x054C, 3);
      if (options.malformed === 'genericError') header.writeUInt16BE(0x04B1, 3);
      const body = Buffer.concat([header, payload]);
      const version = functionCode === 0x04CA ? options.createVersion ?? 1 : secureSocket && sequence >= 2 ? 2 : 1;
      const outer = Buffer.from([0x72, version, body.length >> 8, body.length & 255]);
      let plus = options.oversized ? Buffer.from('7201ffff', 'hex') : Buffer.concat([outer, body, Buffer.from([0x72, version, 0, 0])]);
      if (options.malformed === 'empty') plus = Buffer.from('72010000', 'hex');
      if (options.malformed === 'length') plus.writeUInt16BE(body.length + 1, 2);
      if (options.malformed === 'trailer') plus = plus.subarray(0, -4);
      if (options.malformed === 'truncated') plus = plus.subarray(0, 8);
      if (options.malformed === 'duplicate') plus = Buffer.concat([plus, plus]);
      if (options.malformed === 'cotp') { socket.write(Buffer.from('0300000702e080', 'hex')); return; }
      if (secureSocket) secureSocket.write(plus); else sendDT(plus);
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
            socket.write(Buffer.from(options.smallTpdu ? '0300000e09d00001000100c00107' : '0300000e09d00001000100c0010a', 'hex'));
          } else if (tunnel) { tlsRecords++; tunnel.push(frame.subarray(7)); }
          else onApplication(frame.subarray(7));
        }
      } catch (error) { errors.push(String(error)); socket.destroy(); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address');
  return { port: address.port, requests, errors, get tlsRecords() { return tlsRecords; }, close: async () => {
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