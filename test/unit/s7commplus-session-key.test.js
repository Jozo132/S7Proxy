import { describe, expect, it, vi } from 'vitest';
import { createLegacySessionKey, encodeLegacySecurityKey, fingerprintChallenge, legacyKeyId } from '../../src/protocol/s7commplus/session-key.js';
import { Cursor, decodeValue, encodeOperation, PlusAssembler, responsePayload } from '../../src/protocol/s7commplus/codec.js';
import { createHmac } from 'node:crypto';
import { FragmentHMACVerifier } from '../../src/protocol/s7commplus/fragment-hmac.js';
import { S7CommPlusClient } from '../../src/client/s7commplus-client.js';
import { fixture } from '../s7commplus-fixture.js';

vi.mock('../../src/protocol/s7commplus/session-key.js', async importOriginal => {
  const actual = /** @type {typeof import('../../src/protocol/s7commplus/session-key.js')} */ (await importOriginal());
  /** @type {typeof actual.createLegacySessionKey} */
  const deterministic = (challenge, fingerprint, random = size => Buffer.alloc(size, 0x35)) => actual.createLegacySessionKey(challenge, fingerprint, random);
  return { ...actual, createLegacySessionKey: deterministic };
});

const fragmentVectors = [
  [976, 'fddc00b479d5a02c8d25fb7af591ebc4f7df0693b7b6a2348e8fc2635390ac13'],
  [976, 'a838a6d7ec24cfd6d9f4879bb57f42759075a909029b27c4f725903022798180'],
  [454, 'c551f7af6f3186dcca7ec4d0861e820afed3f86155f4d6dc1d42b707c9f2541b'],
  [55, '89f37b0b5d1fbbb883df4c0ab7f37e959336685dd8644b1f1e4e03528218110b'],
  [56, '755c7d5b46d547fcb908a2118e5cf64cd1db872c9b6e20c667844e751da9afa2'],
  [63, '7f58e4ce028844dd880f99d8aae481c572fd9e0a9f3635ee28799e0a7761ff0c'],
  [64, 'a57dff6df1f2988d41d2ec58fd745722d325772e220dbeff3b5fd158227a18f9'],
  [65, '797726ae7eda3b84783eb33034f7eb62130af2a6f71fb9f07aa81c0346888b9d'],
  [0, 'a445e1cf5260be0c2f15c62d54fe7998bf05bed1a5da17e4e258e5d0765b3894'],
].map(([size, digest]) => {
  const data = Buffer.from(Array.from({ length: Number(size) }, (_, index) => (index * 13 + Number(size)) % 256));
  return { data, protected: Buffer.concat([Buffer.from([32]), Buffer.from(String(digest), 'hex'), data]) };
});

describe('S7-1200 legacy SessionKey known answers', () => {
  it('completes owned-session setup, activation, health, discovery and cached process batches', async () => {
    const challenge = Buffer.alloc(20, 90);
    const material = createLegacySessionKey(challenge, '01:BD426B091F08731A');
    const server = await fixture({ legacyInit: 'error2', legacyKey: { challenge, ...material }, metadata: true, legacyInventoryDelayMs: 1100 });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, securityMode: 'legacy', limits: { maxRequests: 24, readPacingMs: 10 } });
    try {
      await client.connect();
      expect(client.report.securityMode).toBe('LEGACY_SESSION_KEY_INTEGRITY');
      expect(client.report.cpuState).toBe('RUN');
      expect(client.report.effectiveProtectionLevel).toBe(2);
      const discovered = await client.listBlockMembers({ type: 'DB', number: 7 }, { maxTypes: 1 });
      const member = discovered.members.find(candidate => candidate.readable);
      expect(member).toBeDefined();
      if (!member) throw new Error('Fixture must expose a readable member');
      const value = await client.readMember(member);
      expect(value.observation.quality).toBe('GOOD');
      const members = Array(65).fill(member);
      for (let scan = 0; scan < 2; scan++) {
        const results = await client.readMembers(members);
        expect(results).toHaveLength(65);
        expect(results.every(result => result.observation.quality === 'GOOD')).toBe(true);
      }
      expect(client.report.observations.some(observation => observation.kind === 'sessionConfirmation')).toBe(true);
      expect(server.requests.filter(request => request.functionCode === 0x04F2)).toHaveLength(1);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  }, 10000);

  it.each([
    ['legacyBadHmac', 'INTEGRITY_CHECK_FAILED'], ['legacyBadCounter', 'INDETERMINATE_PROTOCOL_ERROR'],
    ['legacyDowngrade', 'PROTOCOL_VERSION_UNSUPPORTED'],
  ])('stops authenticated session establishment on %s', async (option, code) => {
    const challenge = Buffer.alloc(20, 90);
    const material = createLegacySessionKey(challenge, '01:BD426B091F08731A');
    const server = await fixture({ legacyInit: 'rejected', legacyKey: { challenge, ...material }, [option]: true });
    const client = new S7CommPlusClient({ host: '127.0.0.1', port: server.port, securityMode: 'legacy' });
    try {
      await expect(client.connect()).rejects.toMatchObject({ code });
      expect(client.report.sessionEstablished).toBe(false);
      expect(server.requests).toHaveLength(4);
      expect(server.errors).toEqual([]);
    } finally { await client.disconnect(); await server.close(); }
  });
  it('matches every independent OpenSSL legacy multi-fragment HMAC vector', () => {
    const verifier = new FragmentHMACVerifier(Buffer.from(Array.from({ length: 24 }, (_, index) => index)));
    for (const fragment of fragmentVectors) expect(verifier.verify(fragment.protected)).toEqual(fragment.data);
  });
  it.each(fragmentVectors.map((_, index) => index))('rejects corruption at fragment %i', corruptIndex => {
    const verifier = new FragmentHMACVerifier(Buffer.from(Array.from({ length: 24 }, (_, index) => index)));
    for (let index = 0; index < corruptIndex; index++) verifier.verify(fragmentVectors[index].protected);
    const corrupt = Buffer.from(fragmentVectors[corruptIndex].protected); corrupt[1] ^= 1;
    expect(() => verifier.verify(corrupt)).toThrow(/HMAC/);
  });
  it('rejects wrong keys, reordered fragments and a continuation reused as a new response', () => {
    const key = Buffer.from(Array.from({ length: 24 }, (_, index) => index));
    expect(() => new FragmentHMACVerifier(Buffer.alloc(24)).verify(fragmentVectors[0].protected)).toThrow(/HMAC/);
    const verifier = new FragmentHMACVerifier(key); verifier.verify(fragmentVectors[0].protected);
    expect(() => verifier.verify(fragmentVectors[2].protected)).toThrow(/HMAC/);
    expect(() => new FragmentHMACVerifier(key).verify(fragmentVectors[1].protected)).toThrow(/HMAC/);
  });
  it.each([
    ['b80db1b3d9484c6e4240403f63c6b5012cc52e7f', 'e287c1cb659b9edf'],
    ['5b15b4694fc38a775e6778f0770c6e7a3118200d', '6ab5811de6d28746'],
  ])('matches the independent challenge fingerprint %s', (challenge, expected) => {
    expect(fingerprintChallenge(Buffer.from(challenge, 'hex')).toString('hex')).toBe(expected);
  });

  it('matches the complete HarpoS7 S7-1200 encrypted blob and session key vector', () => {
    const fills = [0x35, 0x35, 0x25, 0x2D, 0x2D];
    const material = createLegacySessionKey(Buffer.from('5a5d5ab443551d9f2e680adfc44b163468e42736', 'hex'),
      '01:BD426B091F08731A', size => Buffer.alloc(size, fills.shift()));
    const expected = 'addee1feb40000000100000001000000' +
      '4e0c313b5e08e43b0101000000000000' +
      '1a73081f096b42bd1001000000000000' +
      '4c5313aec96810ccfe3173f77a55540d' +
      'ef558e5197561ecb1aa3ef707a7acf18' +
      'a7d529fe219d55e72d2d2d2d2d2d2d2d' +
      '2d2d2d2d2d2d2d2d2d2d2d2d25252525' +
      '25252525252525252525252582af96f4' +
      '37c028164923a36c44d8061dbf580016' +
      '4bbc3dde0d15d69db76546f4491ca34f' +
      'ef12f959791f2d0e30de7be5af11234c' +
      '6007e47e';
    expect(material.blob.toString('hex')).toBe(expected);
    expect(material.sessionKey.toString('hex')).toBe('f18ce220f7ba175442cf1c4dddb59e82eafa62d5dd096e1a');
    expect(legacyKeyId(material.publicKey).toString('hex')).toBe('1a73081f096b42bd');
    const cursor = new Cursor(encodeLegacySecurityKey(material));
    const value = decodeValue(cursor);
    expect(value.structId).toBe(1800);
    expect(/** @type {{id:number}[]} */ (value.value).map(member => member.id)).toEqual([1801, 1802, 1803, 1804, 1805]);
    expect(cursor.offset).toBe(cursor.bytes.length);
  });

  it('rejects unknown, family-only and malformed key identities without guessing', () => {
    for (const fingerprint of ['01', '00:BD426B091F08731A', '01:0000000000000000']) {
      expect(() => createLegacySessionKey(Buffer.alloc(20), fingerprint)).toThrow(/exact advertised/);
    }
    expect(() => createLegacySessionKey(Buffer.alloc(19), '01:BD426B091F08731A')).toThrow(/20-byte/);
  });

  it('authenticates canonical session activation and rejects modified or unprotected replies', () => {
    const key = Buffer.alloc(24, 35);
    const request = encodeOperation({ kind: 'activateSession' }, { sessionId: 77, version: 1, sessionKey: key, integrityId: 0 }, 3);
    expect(request[1]).toBe(3);
    const body = request.subarray(37, -4);
    expect(request.subarray(5, 37)).toEqual(createHmac('sha256', key).update(body).digest());
    expect(body.readUInt16BE(3)).toBe(0x04F2);
    expect(body.subarray(14, 23).toString('hex')).toBe('0000004d0182430002');
    const assembler = new PlusAssembler(); assembler.setSessionKey(key);
    expect(assembler.feed(request)[0].body).toEqual(body);
    const corrupt = Buffer.from(request); corrupt[40] ^= 1;
    expect(() => assembler.feed(corrupt)).toThrow(/HMAC/);
    const unprotected = encodeOperation({ kind: 'explore' }, { sessionId: 77, version: 1 }, 4);
    expect(() => new PlusAssembler().feed(request)).toThrow(/authentication/);
    const strict = new PlusAssembler(); strict.setSessionKey(key);
    expect(() => strict.feed(unprotected)).toThrow(/authentication/);
    expect(() => encodeOperation({ kind: 'activateSession' }, { sessionId: 77, version: 1 }, 3)).toThrow(/owned authenticated/);
  });
  it('uses the V2 data qualifier inside authenticated V1-session DB reads', () => {
    const operation = { kind: 'read', accessArea: 0x8A0E0007, lids: [1, 2] };
    const authenticated = encodeOperation(operation, { sessionId: 77, version: 1, sessionKey: Buffer.alloc(24, 35), integrityId: 1 }, 4);
    const expected = encodeOperation(operation, { sessionId: 77, version: 2, integrityId: 1 }, 4);
    expect(authenticated.subarray(37, -4)).toEqual(expected.subarray(4, -4));
  });
  it('uses the generic V2 protection-read layout rather than the challenge-read layout', () => {
    const operation = { kind: 'readAttribute', attribute: 1842 };
    const authenticated = encodeOperation(operation, { sessionId: 77, version: 1, sessionKey: Buffer.alloc(24, 35), integrityId: 2 }, 5);
    const expected = encodeOperation(operation, { sessionId: 77, version: 2, integrityId: 2 }, 5);
    expect(authenticated.subarray(37, -4)).toEqual(expected.subarray(4, -4));
  });
  it('accepts activation status six only for an explicitly authenticated fixed activation', () => {
    const body = Buffer.from('32000004f200000003340600000000', 'hex');
    expect(() => responsePayload(body, 0x04F2, 3)).toThrow(/ReturnValue/);
    expect(responsePayload(body, 0x04F2, 3, false, false, true).statusDetails.serviceResultCode).toBe(6);
    const negative = Buffer.from(body); negative[10] = 127;
    expect(() => responsePayload(negative, 0x04F2, 3, false, false, true)).toThrow(/ReturnValue/);
  });
  it.each([0x322, 0x323, 0x443])('recognizes only bounded exact empty session confirmations after key establishment (%i)', code => {
    const confirmation = Buffer.from('72fe001000000000000003230000000000000000', 'hex');
    confirmation.writeUInt32BE(code, 8);
    const assembler = new PlusAssembler(); assembler.setSessionKey(Buffer.alloc(24, 35));
    expect(assembler.feed(confirmation.subarray(0, 8))).toEqual([]);
    expect(assembler.feed(confirmation.subarray(8))).toEqual([]);
    expect(assembler.sessionConfirmations).toBe(1);
    expect(() => new PlusAssembler().feed(confirmation)).toThrow(/SystemEvent/);
    const unknown = Buffer.from(confirmation); unknown[19] = 1;
    expect(() => assembler.feed(unknown)).toThrow(/SystemEvent/);
    const limited = new PlusAssembler(); limited.setSessionKey(Buffer.alloc(24, 35));
    for (let count = 0; count < 16; count++) limited.feed(confirmation);
    expect(() => limited.feed(confirmation)).toThrow(/excessive/);
  });
});