// @ts-check
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { PlusError, u32, vlq } from './codec.js';

const PUBLIC_KEYS = new Map([
  ['01:A95850575DF7B3DE', 'dead01d78404e753f0804d1038ebd16cef9788ccc3c78a972c978ce7efd3baf5002cb03e4fce1128'],
  ['01:AC9BE476CB324E65', '6c71ed8fcc1ae94172040a14b8b1af7501b81e4cb99937491691075109300866557136c8ae848cad'],
  ['01:BD426B091F08731A', 'e0e1f04a5ca3f90148178689bd0c930ab9db867b4f0ab109623959aa32316b7880ed1b4f9a9b189f'],
]);
const FIELD = (1n << 160n) - 47n;
const CURVE_B = 0xFDEC56A0F1A148A7CA6F04463A24F5F56C3F3A4Fn;
const GENERATOR = 0x7D2ED8E2846E58D74A7A613285471707A39D0C8En;
const MASK_80 = (1n << 80n) - 1n;
const SBOX = [12, 5, 6, 11, 9, 0, 10, 13, 3, 14, 15, 8, 4, 7, 1, 2];
const INV_SBOX = Buffer.from(
  '52096ad53036a538bf40a39e81f3d7fb7ce339829b2fff87348e4344c4dee9cb' +
  '547b9432a6c2233dee4c950b42fac34e082ea16628d924b2765ba2496d8bd125' +
  '72f8f66486689816d4a45ccc5d65b6926c704850fdedb9da5e154657a78d9d84' +
  '90d8ab008cbcd30af7e45805b8b34506d02c1e8fca3f0f02c1afbd0301138a6b' +
  '3a9111414f67dcea97f2cfcef0b4e67396ac7422e7ad3585e2f937e81c75df6e' +
  '47f11a711d29c5896fb7620eaa18be1bfc563e4bc6d279209adbc0fe78cd5af4' +
  '1fdda8338807c731b11210592780ec5f60517fa919b54a0d2de57a9f93c99cef' +
  'a0e03b4dae2af5b0c8ebbb3c83539961172b047eba77d626e169146355210c7d', 'hex');
const INPUT_KEY = Buffer.from('84bf37e056af421191579ebc641c9fb3', 'hex');
const ROUND_KEYS = ['3be4b25d87bcc3db', 'ad4c460f7324d5cf', '643ee25f3892b80e', 'd352fe09ba330dea',
  '2525c6a827cee55b', '71f7c262b60c0900', '54f7229eba99cbc6', '40a2f2cad7bfe29d', 'bda945cd3d9beef6',
  'd2a3717b0ee1b5a4', 'daa465fa78e749e0', '7600329783ca7cfe', 'fe5240529c64dfd6'].map(hex => Buffer.from(hex, 'hex'));
const ROUND_WIRING = [
  '17654 03210 07654 13210 27654 23210 37654 33210',
  '22103 32103 12103 02103 24567 34567 14567 04567',
  '30415 20415 00415 10415 33726 23726 03726 13726',
  '25140 15140 05140 35140 26273 36273 16273 06273',
  '34053 24053 14053 04053 07261 17261 37261 27261',
  '14352 34352 04352 24352 27160 07160 17160 37160',
  '03417 22506 32506 23417 13417 33417 12506 02506',
  '31325 21325 01325 27064 11325 07064 17064 37064',
  '05264 13170 15264 33170 25264 23170 35264 03170',
  '20721 04563 30721 14563 34563 10721 24563 00721',
  '20624 30624 00624 37153 27153 17153 10624 07153',
  '34031 04031 24031 17256 27256 07256 37256 14031',
  '34260 14260 25137 24260 04260 15137 35137 05137',
].map(round => round.split(' ').map(item => [...item].map(Number)));
const OUTPUT_BYTES = [[0, 6], [3, 2], [1, 5], [4, 7]];
const OUTPUT_ENCODING = ['39fc6a4710bed285', 'd3e086192cb475fa', '4813eb0752dfa9c6', '8f5ac7219d406e3b',
  '16d9f3e4ab25c870', '687c139af052dbe4', '5cb2ad73680e49f1', 'd9a42f187b65e03c',
  '1c3e92d587bfa406', '218bd470a3cfe659', '14af6dbe970c5832', '2085fde91ca376b4',
  'f2d5a8961be3c704', '814e0635d9cf7ab2', '3ec4715b2680fad9', 'e87d946c2a5b03f1']
  .map(table => [...table].map(nibble => parseInt(nibble, 16)));

/** @param {Buffer} bytes */
function fromLE(bytes) { return BigInt(`0x${Buffer.from(bytes).reverse().toString('hex')}`); }
/** @param {bigint} value @param {number} size */
function toLE(value, size) { return Buffer.from(value.toString(16).padStart(size * 2, '0'), 'hex').reverse(); }
/** @param {bigint} value */
function mod(value) { return ((value % FIELD) + FIELD) % FIELD; }
/** @param {bigint} base @param {bigint} exponent */
function power(base, exponent) {
  let result = 1n;
  while (exponent) {
    if (exponent & 1n) result = result * base % FIELD;
    base = base * base % FIELD;
    exponent >>= 1n;
  }
  return result;
}
/** @param {bigint} scalar @param {bigint} source */
function multiplyPoint(scalar, source) {
  /** @param {bigint[]} point */
  const double = ([coord, scale]) => {
    const square = coord * coord % FIELD;
    const scaleSquare = scale * scale % FIELD;
    return [mod((square + scaleSquare) ** 2n - 8n * CURVE_B * coord * scale * scaleSquare),
      mod(4n * scale * (coord * square - coord * scaleSquare + CURVE_B * scale * scaleSquare))];
  };
  let low = [1n, 0n], high = [source, 1n];
  for (let bit = 159; bit >= 0; bit--) {
    const [left, leftScale] = low, [right, rightScale] = high;
    const cross = (left * rightScale - right * leftScale) ** 2n;
    const total = [mod(2n * (left * rightScale + right * leftScale) * (left * right - leftScale * rightScale)
      + 4n * CURVE_B * (leftScale * rightScale) ** 2n - source * cross), mod(cross)];
    if ((scalar >> BigInt(bit)) & 1n) { low = total; high = double(high); }
    else { low = double(low); high = total; }
  }
  return low[1] ? low[0] * power(low[1], FIELD - 2n) % FIELD : 0n;
}
/** @param {Buffer} block @param {bigint} key */
function present(block, key) {
  /** @param {bigint} register @param {number} counter */
  const update = (register, counter) => {
    register = ((register << 61n) | (register >> 19n)) & MASK_80;
    return (BigInt(SBOX[Number(register >> 76n)]) << 76n | (register & ((1n << 76n) - 1n))) ^ (BigInt(counter) << 15n);
  };
  let state = block.readBigUInt64BE();
  let roundKey = (key >> 16n) ^ 0x0000081000000000n;
  let register = update(key ^ 0x87CA995217BA31853DCEn, 1);
  for (let round = 0; round < 31; round++) {
    state ^= roundKey;
    let substituted = 0n;
    for (let nibble = 0; nibble < 16; nibble++) substituted |= BigInt(SBOX[Number((state >> BigInt(4 * nibble)) & 15n)]) << BigInt(4 * nibble);
    state = 0n;
    for (let bit = 0; bit < 64; bit++) state |= ((substituted >> BigInt(bit)) & 1n) << BigInt(bit === 63 ? 63 : 16 * bit % 63);
    roundKey = register >> 16n;
    register = update(register, round + 2) ^ (round === 0 ? 0x40n : 0n);
  }
  return toLE(state ^ roundKey, 8).reverse();
}
/** @param {bigint} value */
function keyHalves(value) {
  return [BigInt(`0x${toLE(value & MASK_80, 10).toString('hex')}`), BigInt(`0x${toLE(value >> 80n, 10).toString('hex')}`)];
}
/** @param {number} value @param {number} index */
function crumb(value, index) { return ((value >> index) & 1) | (((value >> (index + 4)) & 1) << 1); }
/** @param {Buffer} challenge */
export function fingerprintChallenge(challenge) {
  if (challenge.length !== 20) throw new PlusError('LEGACY_CHALLENGE', 'Expected a 20-byte legacy challenge');
  const substituted = [...challenge.subarray(2, 18)].map((value, index) => INV_SBOX[value ^ INPUT_KEY[index]]);
  let state = substituted.slice(0, 8).map((value, index) => value ^ substituted[index + 8]);
  for (let round = 0; round < 13; round++) state = ROUND_WIRING[round].map(([index, ...sources], byte) => {
    const combined = sources.reduce((value, source, position) => value | (crumb(state[source], index) << (2 * position)), 0);
    return INV_SBOX[combined ^ ROUND_KEYS[round][byte]];
  });
  const nibbles = OUTPUT_ENCODING.map((table, index) => {
    const [left, right] = OUTPUT_BYTES[index % 4];
    const bit = 3 - Math.floor(index / 4);
    return table[crumb(state[left], bit) | (crumb(state[right], bit) << 2)];
  });
  return Buffer.from(Array.from({ length: 8 }, (_, index) => (nibbles[index * 2] << 4) | nibbles[index * 2 + 1]));
}
/** @param {bigint} left @param {bigint} right */
function checksumMultiply(left, right) {
  let product = 0n;
  for (let bit = 0; bit < 128; bit++) {
    if (right & 1n) product ^= left;
    right >>= 1n;
    left <<= 1n;
    if (left >> 128n) left ^= (1n << 128n) | (1n << 32n) | (1n << 15n) | 5n;
  }
  return product;
}
/** @param {Buffer} key @param {Buffer} block */
function aes(key, block) {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block), cipher.final()]);
}
/** @param {Buffer} key */
export function legacyKeyId(key) { return createHash('sha256').update(key.subarray(0, 24)).update('DERIVE').digest().subarray(0, 8); }

/** @param {Buffer} challenge @param {string} fingerprint @param {(size:number)=>Buffer} [random] */
export function createLegacySessionKey(challenge, fingerprint, random = randomBytes) {
  const encoded = PUBLIC_KEYS.get(fingerprint);
  if (!encoded) throw new PlusError('LEGACY_PUBLIC_KEY_UNKNOWN', 'No supported exact advertised S7-1200 public key; key guessing is disabled', { fingerprint });
  if (challenge.length !== 20) throw new PlusError('LEGACY_CHALLENGE', 'Expected exactly one 20-byte legacy challenge');
  const publicKey = Buffer.from(encoded, 'hex');
  const key2 = random(24), key1 = random(24), initialCounter = random(16), blinding = random(20);
  const preSeed = fromLE(Buffer.concat([0, 1, 2].map(index => present(key1.subarray(index * 8, index * 8 + 8), 0xA98DE7C5164AD032538Fn))).subarray(0, 20));
  let ephemeral = 0n, shared = 0n;
  for (let attempt = 0; attempt < 4 && !ephemeral; attempt++) {
    const scalar = fromLE(random(20)) ^ 0xF8E62E8673B79CA477A1D36333B1C0DE6C706448n;
    ephemeral = multiplyPoint(scalar, GENERATOR);
    shared = multiplyPoint(scalar, fromLE(publicKey.subarray(0, 20)));
  }
  if (!ephemeral || !shared) throw new PlusError('LEGACY_KEY_EXCHANGE', 'Ephemeral key agreement failed');
  const [sharedLow, sharedHigh] = keyHalves(shared);
  const mask = fromLE(Buffer.concat([0xF5EA1E69CBDF8EF1n, 0xF4C52FEBC1C01D1An, 0xADF3602156A724DEn]
    .map((value, index) => present(toLE(value, 8), index === 2 ? sharedHigh : sharedLow))).subarray(0, 20));
  const [low, high] = keyHalves(preSeed);
  const derived = Buffer.concat([0xEFFCB975BC8864FDn, 0x20B6407AF0433F14n, 0x610806EFE0358644n,
    0xFF78C6D5C660CEDCn, 0xC5E88FDB01AF4AE1n, 0x2AE2BA517C0D93F6n]
    .map((value, index) => present(toLE(value, 8), index < 3 ? low : high)));
  const blob = Buffer.alloc(180);
  [0xFEE1DEAD, 180, 1, 1].forEach((value, index) => blob.writeUInt32LE(value, index * 4));
  legacyKeyId(key2).copy(blob, 16); blob.writeUInt32LE(0x101, 24);
  legacyKeyId(publicKey).copy(blob, 32); blob.writeUInt32LE(0x110, 40);
  toLE(preSeed ^ mask, 20).copy(blob, 48); toLE(ephemeral, 20).copy(blob, 68); blinding.copy(blob, 88);
  initialCounter.copy(blob, 108);
  let counter = fromLE(initialCounter);
  const hashKey = fromLE(derived.subarray(32, 48));
  let checksum = checksumMultiply(counter, hashKey);
  const plaintext = Buffer.concat([challenge.subarray(2, 18), key2]);
  for (let offset = 0; offset < plaintext.length; offset += 16) {
    const maskBytes = aes(derived.subarray(0, 16), toLE(counter, 16));
    const ciphertext = Buffer.alloc(16);
    const length = Math.min(16, plaintext.length - offset);
    for (let index = 0; index < length; index++) ciphertext[index] = plaintext[offset + index] ^ maskBytes[index];
    ciphertext.copy(blob, 124 + offset, 0, length);
    checksum = checksumMultiply(checksum ^ fromLE(ciphertext), hashKey);
    counter = (counter >> 1n) ^ ((counter & 1n) ? 0xE1n << 120n : 0n);
  }
  checksum = checksumMultiply(checksum ^ (40n << 96n), hashKey);
  aes(derived.subarray(16, 32), toLE(checksum, 16)).copy(blob, 164);
  const sessionKey = createHmac('sha256', key2).update(fingerprintChallenge(challenge)).update(challenge.subarray(2, 18)).digest().subarray(0, 24);
  key1.fill(0); key2.fill(0); derived.fill(0);
  return { blob, sessionKey, publicKey, fingerprint };
}

/** @param {bigint} value */
function uint64(value) {
  const bytes = [];
  if (value >= (1n << 56n)) {
    bytes.unshift(Number(value & 255n)); value >>= 8n;
    for (let index = 0; index < 8; index++) { bytes.unshift(Number(value & 127n) | 128); value >>= 7n; }
  } else {
    bytes.unshift(Number(value & 127n));
    while ((value >>= 7n)) bytes.unshift(Number(value & 127n) | 128);
  }
  return Buffer.from(bytes);
}
/** @param {ReturnType<typeof createLegacySessionKey>} material */
export function encodeLegacySecurityKey(material) {
  /** @param {number} id @param {Buffer} key @param {number} flags */
  const descriptor = (id, key, flags) => Buffer.concat([vlq(id), Buffer.from([0, 23]), u32(1825),
    vlq(1826), Buffer.from([0, 5]), uint64(fromLE(legacyKeyId(key))), vlq(1827), Buffer.from([0, 4]), vlq(flags),
    vlq(1828), Buffer.from([0, 4, 0, 0])]);
  return Buffer.concat([Buffer.from([0, 23]), u32(1800), vlq(1801), Buffer.from([0, 4, 0]),
    vlq(1802), Buffer.from([0, 2, 0]), descriptor(1803, material.publicKey, 0x110),
    descriptor(1804, material.sessionKey, 0x10101), vlq(1805), Buffer.from([0, 20, 0]), vlq(180), material.blob, Buffer.from([0])]);
}