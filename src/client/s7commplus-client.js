// @ts-check
import { Socket, isIP } from 'node:net';
import { constants, createHash, timingSafeEqual } from 'node:crypto';
import { Duplex } from 'node:stream';
import { connect as connectTLS, checkServerIdentity } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { getProductionHost } from '../protocol/production-policy.js';
import {
  PlusError, PLUS_FUNCTION, PlusAssembler, Cursor, decodeValue, decodeObjects,
  encodeOperation, assertOutgoing, responsePayload,
} from '../protocol/s7commplus/codec.js';
import { buildBlockMembers, validateMemberValue } from '../protocol/s7commplus/type-info.js';
import { decodeProgramInventory, PROGRAM_INVENTORY_ATTRIBUTES } from '../protocol/s7commplus/block-inventory.js';
import { BLOCK_CONTENT_ATTRIBUTES, decodeBlockContent } from '../protocol/s7commplus/block-upload.js';
import { createLegacySessionKey, encodeLegacySecurityKey } from '../protocol/s7commplus/session-key.js';

/** @import { PlusOperation, PlusObject, PlusValue } from '../protocol/s7commplus/codec.js' */
/** @import { BlockMetadata, RuntimeMember } from '../protocol/s7commplus/type-info.js' */
export { getProductionHost } from '../protocol/production-policy.js';
const activeHosts = new Set();
const DEFAULT_LIMITS = Object.freeze({
  requestTimeoutMs: 5000, tlsHandshakeTimeoutMs: 10000, sessionDurationMs: 60000, maxRequests: 12,
  maxRequestBytes: 900, maxResponseBytes: 65536, maxSessionBytes: 262144,
  maxUploadBytes: 1048576, pacingMs: 250, maxObjects: 65536, maxDepth: 256, maxDiagnosticEntries: 128,
  maxLatencyMs: 4000, latencyFactor: 5,
});

/** @typedef {Partial<Record<keyof typeof DEFAULT_LIMITS,number>>} PlusLimits */
/** @typedef {{host?:string,port?:number,productionReadOnly?:boolean,securityMode?:'discovery'|'legacy'|'tls',tls?:{ca?:string|Buffer,servername?:string,certificateSha256?:string,allowAnyCertificate?:boolean,minVersion?:'TLSv1.2'|'TLSv1.3'},limits?:PlusLimits}} PlusOptions */
/** @typedef {{resolve:(value:any)=>void,reject:(error:Error)=>void,timer:ReturnType<typeof setTimeout>}} Pending */

export class S7CommPlusClient {
  /** @type {Socket|null} */
  #socket = null;
  #closed = Promise.resolve();
  /** @type {import('node:tls').TLSSocket|null} */
  #tls = null;
  /** @type {Duplex|null} */
  #tunnel = null;
  /** @type {Pending|null} */
  #pending = null;
  /** @type {Buffer} */
  #tcp = Buffer.alloc(0);
  /** @type {Buffer[]} */
  #cotp = [];
  #cotpBytes = 0;
  #plus;
  #sequence = 0;
  #sessionId = 0;
  #version = 1;
  #integrityId = 0;
  #writeIntegrityId = 0;
  /** @type {Buffer|undefined} */
  #sessionKey;
  /** @type {Buffer|undefined} */
  #securityKey;
  #legacyAuthenticated = false;
  /** @type {Buffer|undefined} */
  #serverVersion;
  #busy = false;
  #started = 0;
  #lastRequest = 0;
  /** @type {Map<string,number>} */
  #baselines = new Map();
  #ready = false;
  #established = false;
  #phase = 'idle';
  /** @type {string|undefined} */
  #failurePhase;
  #cpuState = 'UNKNOWN';
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  #durationTimer;
  /** @type {PlusError|undefined} */
  #failure;
  /** @type {PlusOptions} */
  #options;
  /** @type {string} */
  #host;
  #port;
  #limits;
  #requests = 0;
  #rxBytes = 0;
  #txBytes = 0;
  /** @type {any[]} */
  #observations = [];
  /** @type {any[]} */
  #transcript = [];
  /** @type {{deviceString:string|null,orderNumber:string|null,firmware:string|null,model:null}} */
  #identity = { deviceString: null, orderNumber: null, firmware: null, model: null };
  /** @type {number|null} */
  #protection = null;
  /** @type {string|null} */
  #peerCertificateSha256 = null;
  #tlsVerified = false;
  #tlsEstablished = false;
  /** @type {Map<number, BlockMetadata>} */
  #blocks = new Map();
  /** @type {Awaited<ReturnType<S7CommPlusClient['listDataBlocks']>>|undefined} */
  #inventory;
  /** @type {Map<number, Awaited<ReturnType<S7CommPlusClient['explore']>>>} */
  #types = new Map();
  /** @type {WeakMap<RuntimeMember,{block:BlockMetadata,member:RuntimeMember,metadataEvidence:unknown}>} */
  #memberBindings = new WeakMap();
  /** @type {{name:string,member:RuntimeMember}[]} */
  #namedMembers = [];
  #uploadBusy = false;

  /** @param {PlusOptions} [options] */
  constructor(options = {}) {
    const host = options.host ?? getProductionHost();
    if (!host) throw new PlusError('TARGET_DENIED', 'An explicit host or local production target configuration is required');
    if (typeof host !== 'string' || host.length > 253 || (!isIP(host) && !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) || ['0.0.0.0', '::'].includes(host)) {
      throw new PlusError('TARGET_DENIED', 'Expected a PLC IP address or hostname');
    }
    this.#host = host;
    this.#port = options.port ?? 102;
    if (options.productionReadOnly === false) throw new PlusError('READ_ONLY_DENIED', 'This backend cannot disable productionReadOnly');
    if (!Number.isInteger(this.#port) || this.#port < 1 || this.#port > 65535) {
      throw new PlusError('TARGET_DENIED', 'Invalid target port');
    }
    if (options.securityMode && !['discovery', 'legacy', 'tls'].includes(options.securityMode)) throw new PlusError('UNSUPPORTED_SECURITY_PROFILE', 'Select an explicit legacy or TLS profile; automatic fallback is not supported');
    if ('password' in options || 'username' in options || 'sessionKey' in options) throw new PlusError('AUTHENTICATION_UNSUPPORTED', 'Username/password authentication and externally supplied session keys are not supported; nothing transmitted');
    if (options.tls && options.securityMode !== 'tls') throw new PlusError('SECURITY_REQUIRED', 'TLS configuration cannot be used in plaintext');
    if (options.tls?.allowAnyCertificate !== undefined && typeof options.tls.allowAnyCertificate !== 'boolean') throw new PlusError('ARGUMENT', 'allowAnyCertificate must be a boolean');
    if (options.tls?.minVersion !== undefined && !['TLSv1.2', 'TLSv1.3'].includes(options.tls.minVersion)) throw new PlusError('ARGUMENT', 'TLS minVersion must be TLSv1.2 or TLSv1.3');
    if (options.securityMode === 'tls' && options.tls?.allowAnyCertificate !== true && !options.tls?.ca) throw new PlusError('SECURITY_REQUIRED', 'Verified TLS requires an authorized CA certificate');
    if (options.securityMode === 'tls' && options.tls?.allowAnyCertificate !== true && !/^[a-fA-F0-9]{64}$/.test(options.tls?.certificateSha256 ?? '')) {
      throw new PlusError('CERTIFICATE_PIN_REQUIRED', 'Verified TLS requires an independently approved SHA-256 certificate pin');
    }
    this.#limits = Object.freeze({ ...DEFAULT_LIMITS, ...options.limits });
    for (const [name, value] of Object.entries(this.#limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new PlusError('ARGUMENT', `Invalid budget ${name}`);
    }
    if (this.#limits.pacingMs < 250 || this.#limits.maxRequestBytes > 900 || this.#limits.maxResponseBytes > 16777216 || this.#limits.maxObjects > 262144 || this.#limits.maxDepth > 1024 || this.#limits.maxDiagnosticEntries > 4096 || this.#limits.maxRequests > 10000000) {
      throw new PlusError('ARGUMENT', 'Pacing or allocation exceeds the qualified envelope');
    }
    this.#options = { ...options, tls: options.tls ? { ...options.tls } : undefined };
    this.#plus = new PlusAssembler(this.#limits.maxResponseBytes);
  }

  get productionReadOnly() { return true; }
  get connected() { return this.#ready && !this.#failure && !!this.#socket && !this.#socket.destroyed; }
  get report() {
    return structuredClone({
      target: { host: this.#host, port: this.#port }, productionReadOnly: true, phase: this.#phase,
      connected: this.connected, protocol: 'S7CommPlus', protocolVersion: this.#version,
      sessionEstablished: this.#established, securityMode: this.#tlsVerified ? 'TLS_VERIFIED' : this.#options.securityMode === 'tls' ? 'TLS_UNVERIFIED' : this.#legacyAuthenticated ? 'LEGACY_SESSION_KEY_INTEGRITY' : 'UNAUTHENTICATED_DISCOVERY',
      selectedProfile: this.#options.securityMode === 'tls' ? 'TLS' : 'LEGACY_PLAINTEXT',
      allowAnyCertificate: this.#options.tls?.allowAnyCertificate === true,
      peerCertificateSha256: this.#peerCertificateSha256,
      identity: this.#identity, cpuState: this.#cpuState, effectiveProtectionLevel: this.#protection,
      capabilities: { objectExplore: this.#ready, symbolicLidRead: this.#ready && this.#cpuState === 'RUN',
        namedSymbolResolution: this.#ready && this.#cpuState === 'RUN' && this.#namedMembers.length > 0,
        blockUpload: this.#tlsVerified && this.#protection === 1 ? 'BOUNDED_NATIVE_ATTRIBUTE_CONTENT' : 'UNSUPPORTED_PROFILE',
        controllerBackup: 'UNSUPPORTED_UNQUALIFIED', cpuModeControl: 'DENIED', recurringUploads: false },
      limits: this.#limits, statistics: { requests: this.#requests, receivedBytes: this.#rxBytes,
        sentBytes: this.#txBytes, elapsedMs: this.#started ? Math.round(performance.now() - this.#started) : 0 },
      observations: this.#observations, transcript: this.#transcript,
      failure: this.#failure ? { code: this.#failure.code, message: this.#failure.message, phase: this.#failurePhase, details: this.#failure.details } : null,
      machineImpactVerified: false,
    });
  }

  async connect() {
    if (this.#phase !== 'idle') throw new PlusError('SESSION_STATE', 'Create a new client for an explicit new attempt');
    if (activeHosts.has(this.#host)) throw new PlusError('SESSION_LIMIT', 'One active connection per target is permitted');
    activeHosts.add(this.#host);
    this.#started = performance.now();
    this.#durationTimer = setTimeout(() => this.#stop(new PlusError('SESSION_LIMIT', 'Session duration budget exhausted')), this.#limits.sessionDurationMs);
    try {
      this.#phase = 'tcp';
      const socket = new Socket();
      this.#socket = socket;
      this.#closed = new Promise(resolve => socket.once('close', () => { activeHosts.delete(this.#host); resolve(); }));
      socket.setNoDelay(true);
      socket.on('data', (/** @type {Buffer} */ bytes) => {
        try { this.#onTCP(bytes); } catch (error) { this.#stop(this.#asError(error)); }
      });
      socket.on('error', error => this.#stop(new PlusError('TRANSPORT_REJECTED', `${this.#phase}: ${error.message}`, { transportCode: /** @type {NodeJS.ErrnoException} */ (error).code })));
      socket.on('close', () => {
        activeHosts.delete(this.#host);
        if (this.#phase !== 'closed' && !this.#failure) this.#stop(new PlusError('PEER_CLOSED', `Peer closed during ${this.#phase}`));
      });
      await this.#wait(() => socket.connect(this.#port, this.#host, () => this.#settle(true)));
      this.#phase = 'cotp';
      const tsap = Buffer.from('SIMATIC-ROOT-HMI');
      const cr = Buffer.concat([Buffer.from([6 + 4 + 2 + tsap.length + 3, 0xE0, 0, 0, 0, 1, 0, 0xC1, 2, 6, 0, 0xC2, tsap.length]), tsap, Buffer.from([0xC0, 1, 10])]);
      const confirmation = /** @type {Buffer} */ (await this.#wait(() => this.#writeTPKT(cr)));
      if (confirmation.length < 7 || confirmation[1] !== 0xD0 || confirmation.readUInt16BE(2) !== 1 || confirmation[6] !== 0) {
        throw new PlusError('COTP_REJECTED', 'Expected class-0 COTP connection confirm for source reference 1');
      }
      const parameters = new Cursor(confirmation.subarray(7));
      let tpduSizeSeen = false;
      while (parameters.offset < parameters.bytes.length) {
        const code = parameters.byte();
        const value = parameters.take(parameters.byte());
        if (code === 0xC0 && !tpduSizeSeen && value.length === 1 && value[0] === 10) tpduSizeSeen = true;
        else if (code !== 0xC1 && code !== 0xC2) throw new PlusError('UNSUPPORTED_TRANSPORT', 'Only the offered 1024-byte COTP TPDU profile is qualified');
      }
      if (!tpduSizeSeen) throw new PlusError('UNSUPPORTED_TRANSPORT', 'Missing qualified COTP TPDU size');
      this.#phase = 'initSSL';
      const initialized = await this.#exchange({ kind: 'initSSL' });
      const initTail = initialized.cursor.take(initialized.cursor.bytes.length - initialized.cursor.offset);
      if (![4, 5].includes(initTail.length) || initTail.some(byte => byte !== 0)) throw new PlusError('MALFORMED_RESPONSE', 'Unqualified InitSSL suffix');
      if (this.#options.securityMode === 'tls') await this.#activateTLS();
      this.#phase = 'createSession';
      const created = await this.#exchange({ kind: 'createSession' });
      const count = created.cursor.byte();
      if (count < 1 || count > 2) throw new PlusError('SESSION_CREATE_REJECTED', `Unexpected session object count ${count}`, created.statusDetails);
      this.#sessionId = created.cursor.uint();
      if (!this.#sessionId) throw new PlusError('SESSION_CREATE_REJECTED', 'PLC returned null session ID');
      if (count === 2) created.cursor.uint();
      const objects = decodeObjects(created.cursor, this.#limits.maxObjects, this.#limits.maxDepth);
      const attributes = objects.flatMap(object => object.attributes);
      const versions = attributes.filter(attribute => attribute.id === 306);
      const sessionObjects = objects.filter(object => object.rid === 288 && object.classId === 287 && object.parentRid === null);
      if (versions.length !== 1 || sessionObjects.length !== 1 || !sessionObjects[0].attributes.includes(versions[0])) {
        throw new PlusError('SESSION_CREATE_REJECTED', 'Missing, foreign or ambiguous ServerSessionVersion');
      }
      const versionValue = versions[0].value;
      this.#serverVersion = versionValue.raw;
      this.#extractIdentity(versionValue);
      const securedRole = attributes.some(attribute => attribute.id === 299 && (Number(attribute.value.value) & 0x20000000));
      const challenges = sessionObjects[0].attributes.filter(attribute => attribute.id === 303);
      let legacyMaterial;
      if (!this.#tlsEstablished && this.#options.securityMode === 'legacy' && challenges.length === 1) {
        const fingerprints = sessionObjects[0].attributes.filter(attribute => attribute.id === 233 && typeof attribute.value.value === 'string');
        if (fingerprints.length !== 1 || challenges[0].value.flags !== 0x10 || challenges[0].value.datatype !== 2) {
          throw new PlusError('LEGACY_SESSION_KEY_REQUIRED', 'Missing unambiguous supported session challenge and exact public-key identity');
        }
        legacyMaterial = createLegacySessionKey(Buffer.from(challenges[0].value.value), fingerprints[0].value.value);
        this.#securityKey = encodeLegacySecurityKey(legacyMaterial);
      } else if (securedRole || (!this.#tlsEstablished && challenges.length)) {
        throw new PlusError(this.#tlsEstablished ? 'AUTHENTICATION_REQUIRED' : 'LEGACY_SESSION_KEY_REQUIRED', 'PLC advertises a challenge or secured role; the selected profile requires unsupported authentication; no key probing or bypass attempted');
      }
      if (created.version === 2 && !this.#tls) throw new PlusError('SECURITY_REQUIRED', 'PLC replied V2; verified TLS required; no plaintext fallback');
      this.#version = this.#tls ? 2 : created.version;
      this.#phase = 'setupSession';
      const setup = await this.#exchange({ kind: 'setupSession' });
      const errorItem = setup.cursor.uint();
      if (errorItem !== 0) throw new PlusError('SESSION_SETUP_REJECTED', 'Session setup contains item errors', { errorItem });
      const setupTail = setup.cursor.take(setup.cursor.bytes.length - setup.cursor.offset);
      if (![0, 1, 4, 5].includes(setupTail.length) || setupTail.some(byte => byte !== 0)) throw new PlusError('MALFORMED_RESPONSE', 'Unqualified session setup fill or initial integrity value');
      if (legacyMaterial) {
        this.#sessionKey = legacyMaterial.sessionKey;
        this.#plus.setSessionKey(this.#sessionKey);
        this.#phase = 'activateSession';
        const activated = await this.#exchange({ kind: 'activateSession' });
        if (activated.cursor.take(activated.cursor.bytes.length - activated.cursor.offset).some(byte => byte !== 0)) throw new PlusError('MALFORMED_RESPONSE', 'Unqualified session activation response');
        this.#integrityId++;
        this.#writeIntegrityId++;
        this.#legacyAuthenticated = true;
        this.#record(this.#observations, { kind: 'legacySessionKey', fingerprint: legacyMaterial.fingerprint, authenticatedPackets: true, encryptedTransport: false });
      }
      this.#established = true;
      this.#ready = true;
      this.#phase = 'ready';
      await this.readCpuState();
      await this.#readProtection();
      return this.report;
    } catch (error) {
      const failure = this.#asError(error);
      this.#stop(failure);
      await this.disconnect();
      throw failure;
    }
  }

  /** @param {number} objectId @param {{attributes?:number[],recursive?:boolean}} [options] */
  async explore(objectId, options = {}) {
    this.#requireReady();
    this.#requireMetadataState();
    return this.#explore(objectId, options);
  }

  /** @param {number} objectId @param {{attributes?:number[],recursive?:boolean}} options @param {'explore'|'readBlockContent'} [kind] */
  async #explore(objectId, options, kind = 'explore') {
    try {
      const response = await this.#exchange({ kind, objectId, ...options });
      let returnedExploreId;
      if (response.expectedIntegrityId !== undefined || response.cursor.bytes[response.cursor.offset] !== 0xA1) {
        returnedExploreId = response.cursor.uint32();
        this.#checkIntegrity(response.cursor, response.expectedIntegrityId);
      }
      const objects = decodeObjects(response.cursor, this.#limits.maxObjects, this.#limits.maxDepth);
      return { objectId, returnedExploreId, objects, receivedAt: new Date().toISOString(), completeness: 'BOUNDED_RESPONSE_NOT_FULL_INVENTORY',
        correlation: response.correlation };
    } catch (error) { this.#stop(this.#asError(error)); throw error; }
  }

  async readCpuState() {
    this.#requireReady();
    const result = await this.#explore(52, { attributes: [0x8BD] });
    const codes = result.objects.filter(object => object.rid === 52)
      .flatMap(object => object.attributes.filter(attribute => attribute.id === 0x8BD && attribute.value.structId === 0xD99))
      .flatMap(attribute => /** @type {{id:number,value:PlusValue}[]} */ (attribute.value.value))
      .filter(member => member.id === 0xD9E && member.value.datatype === 8).map(member => member.value.value);
    this.#cpuState = codes.length && codes.every(code => code === 8) ? 'RUN' : codes.length && codes.every(code => code === 4) ? 'STOP' : 'UNKNOWN';
    this.#record(this.#observations, { kind: 'cpuState', value: this.#cpuState, evidence: result });
    if (this.#cpuState === 'UNKNOWN') {
      const error = new PlusError('CPU_STATE', 'CPU operating state is unknown; acquisition stopped');
      this.#stop(error);
      throw error;
    }
    return this.#cpuState;
  }

  async #readProtection() {
    const response = await this.#exchange({ kind: 'readAttribute', attribute: 1842 });
    const cursor = response.cursor;
    if (cursor.bytes[cursor.offset] === 0 && cursor.bytes[cursor.offset + 1] === 0 && cursor.bytes[cursor.offset + 2] === 4) cursor.byte();
    const value = decodeValue(response.cursor);
    if (value.flags || value.datatype !== 4) throw new PlusError('UNSUPPORTED_DECODING', 'Expected scalar UDInt protection level');
    this.#checkScalarTail(cursor, response.expectedIntegrityId);
    this.#protection = value.value;
    if (this.#protection === null || this.#protection > 2) throw new PlusError('ACCESS_RESTRICTED', `Protection level ${this.#protection}; stop before program exploration`);
  }

  async listDataBlocks() {
    this.#requireReady();
    if (this.#inventory) return this.#inventory;
    const evidence = await this.#explore(3, { recursive: true, attributes: [233, 2521] });
    const blocks = evidence.objects.filter(object => object.classId === 2574 && (object.rid >>> 16) === 0x8A0E).map(object => {
      const names = object.attributes.filter(attribute => attribute.id === 233 && typeof attribute.value.value === 'string');
      if (names.length > 1) throw new PlusError('AMBIGUOUS_METADATA', 'DB has multiple native names');
      return { type: /** @type {const} */ ('DB'), number: object.rid & 0xFFFF,
        name: names[0]?.value.value ?? null, objectRid: object.rid, typeInfoId: null,
        status: 'TYPE_UNRESOLVED', evidence: { objectRid: object.rid, attributes: object.attributes,
          correlation: evidence.correlation, receivedAt: evidence.receivedAt } };
    });
    if (new Set(blocks.map(block => block.number)).size !== blocks.length) throw new PlusError('AMBIGUOUS_METADATA', 'Duplicate DB runtime identities');
    this.#inventory = { blocks, completeness: evidence.completeness, receivedAt: evidence.receivedAt };
    return this.#inventory;
  }

  async listProgramBlocks() {
    this.#requireReady();
    this.#requireMetadataState();
    const evidence = await this.#explore(3, { recursive: true, attributes: [...PROGRAM_INVENTORY_ATTRIBUTES] });
    try {
      return { ...decodeProgramInventory(evidence), controller: structuredClone(this.#identity),
        cpuState: this.#cpuState, artifactClass: 'PROGRAM_INVENTORY', blockContentRetrieved: false };
    } catch (error) { this.#stop(this.#asError(error)); throw error; }
  }

  /** @param {{type:string,number:number}} selector @param {{mode?:'run'|'stop'}} [options] */
  async uploadProgramBlock(selector, options = {}) {
    if (!selector || !['DB', 'FC', 'OB'].includes(selector.type) || !Number.isInteger(selector.number) || selector.number < 1 || selector.number > 65535) {
      throw new PlusError('ARGUMENT', 'Select an inventoried DB, FC or OB number in 1..65535');
    }
    if (!options || Object.keys(options).some(key => key !== 'mode') || (options.mode !== undefined && !['run', 'stop'].includes(options.mode))) {
      throw new PlusError('ARGUMENT', 'Select run or stop acquisition mode; no mode-control flags are accepted');
    }
    this.#requireProgramUpload();
    const requested = { type: selector.type, number: selector.number };
    if (this.#uploadBusy) throw new PlusError('CONCURRENCY_LIMIT', 'Only one software acquisition may run per session');
    this.#uploadBusy = true;
    try {
      const before = await this.readCpuState();
      this.#requireAcquisitionMode(options.mode ?? 'run');
      const inventory = await this.listProgramBlocks();
      const matches = inventory.blocks.filter(block => block.type === requested.type && block.number === requested.number);
      if (matches.length !== 1 || matches[0].status !== 'IDENTIFIED') throw new PlusError('BLOCK_UNAVAILABLE', 'Block was not uniquely identified by native inventory');
      const content = await this.#readProgramBlock(matches[0]);
      const after = await this.readCpuState();
      if (after !== before) throw new PlusError('CPU_STATE', 'CPU operating mode changed during block acquisition');
      return { ...content, controller: structuredClone(this.#identity), cpuState: { before, after }, inventory };
    } finally { this.#uploadBusy = false; }
  }

  /** @param {{mode?:string,include?:string[]}} [options] */
  async uploadProgram(options = {}) {
    if (!options || typeof options !== 'object') throw new PlusError('ARGUMENT', 'Expected software upload options');
    if (options.mode === 'stop-required-backup') {
      throw new PlusError('EXPLICIT_CPU_STOP_CONFIRMATION_REQUIRED', 'STOP-dependent backup is not implemented or authorized; no mode-control operation can be serialized');
    }
    if (Object.keys(options).some(key => !['mode', 'include'].includes(key))) throw new PlusError('READ_ONLY_DENIED', 'Software upload accepts no mode-control or confirmation flags');
    if (options.mode !== undefined && !['run', 'stop'].includes(options.mode)) throw new PlusError('ARGUMENT', 'Select run or stop acquisition mode');
    if (options.include !== undefined && !Array.isArray(options.include)) throw new PlusError('ARGUMENT', 'Expected an artifact type list');
    const include = [...(options.include ?? ['OB', 'FB', 'FC', 'DB', 'UDT', 'TAGS'])];
    if (!include.length || new Set(include).size !== include.length || include.some(type => !['OB', 'FB', 'FC', 'DB', 'UDT', 'TAGS'].includes(type))) {
      throw new PlusError('ARGUMENT', 'Select distinct OB, FB, FC, DB, UDT or TAGS artifact types');
    }
    this.#requireProgramUpload();
    if (this.#uploadBusy) throw new PlusError('CONCURRENCY_LIMIT', 'Only one software acquisition may run per session');
    this.#uploadBusy = true;
    try {
      const before = await this.readCpuState();
      this.#requireAcquisitionMode(options.mode ?? 'run');
      const inventory = await this.listProgramBlocks();
      const selected = inventory.blocks.filter(block => include.includes(block.type));
      const artifacts = [];
      /** @type {{block?:import('../protocol/s7commplus/block-upload.js').ProgramBlock,type?:string,status:string,cause?:string}[]} */
      const omissions = inventory.blocks.filter(block => block.type === 'UNKNOWN').map(block => ({ block, status: 'UNSUPPORTED_BLOCK_CLASS' }));
      for (const type of include.filter(type => !selected.some(block => block.type === type))) omissions.push({ type, status: 'NOT_OBSERVED_IN_BOUNDED_INVENTORY' });
      /** @type {{code:string,message:string}|null} */
      let failure = null;
      let totalContentBytes = 0;
      for (const [index, block] of selected.entries()) {
        if (this.#requests + 2 > this.#limits.maxRequests) {
          failure = { code: 'REQUEST_LIMIT', message: 'No upload request issued without a remaining final-state-check budget' };
        } else {
          try {
            const artifact = await this.#readProgramBlock(block);
            if (totalContentBytes + artifact.totalComponentBytes > this.#limits.maxUploadBytes) {
              throw new PlusError('RESPONSE_LIMIT', 'Software content exceeds the session upload-byte budget');
            }
            artifacts.push(artifact);
            totalContentBytes += artifact.totalComponentBytes;
            if (artifact.status === 'UNAVAILABLE') omissions.push({ block, status: 'BLOCK_CONTENT_UNAVAILABLE' });
          } catch (error) {
            const cause = this.#asError(error);
            if (['PROTECTED_BLOCK', 'PROTECTION_STATE_UNQUALIFIED'].includes(cause.code)) {
              omissions.push({ block, status: cause.code, cause: cause.message });
              continue;
            }
            failure = { code: cause.code, message: cause.message };
          }
        }
        if (failure) {
          for (const unattempted of selected.slice(index)) omissions.push({ block: unattempted, status: 'NOT_CAPTURED', cause: failure.code });
          break;
        }
      }
      let after = 'UNKNOWN';
      if (this.connected) {
        try { after = await this.readCpuState(); }
        catch (error) {
          const cause = this.#asError(error);
          failure ??= { code: cause.code, message: cause.message };
        }
      }
      if (after !== before) failure ??= { code: 'CPU_STATE', message: 'Final CPU operating mode did not match the initial mode' };
      return {
        artifactClass: 'SOFTWARE_UPLOAD', source: 'S7COMMPLUS_RESPONSE',
        status: failure ? 'PARTIAL' : !artifacts.length ? 'UNAVAILABLE' : artifacts.length !== selected.length
          || artifacts.some(artifact => artifact.status === 'UNAVAILABLE') ? 'PARTIAL' : 'AVAILABLE_COMPONENTS_CAPTURED',
        controller: { target: { host: this.#host, port: this.#port }, identity: structuredClone(this.#identity),
          peerCertificateSha256: this.#peerCertificateSha256 },
        cpuState: { before, after }, inventory, artifacts, files: artifacts.flatMap(artifact => artifact.files), omissions, failure, totalContentBytes,
        receivedAt: new Date().toISOString(),
        completeness: { program: 'AVAILABLE_NATIVE_COMPONENTS_ONLY', inventory: inventory.completeness,
          controllerState: 'NOT_CAPTURED', restore: 'UNVERIFIED' }, restorable: false,
      };
    } finally { this.#uploadBusy = false; }
  }

  #requireMetadataState() {
    if (!['RUN', 'STOP'].includes(this.#cpuState)) throw new PlusError('CPU_STATE', 'Metadata access requires a genuine RUN or STOP reply');
  }

  /** @param {string} mode */
  #requireAcquisitionMode(mode) {
    if (this.#cpuState !== mode.toUpperCase()) throw new PlusError('CPU_STATE', `Acquisition requires CPU ${mode.toUpperCase()}; no mode change was requested`);
  }

  #requireProgramUpload() {
    this.#requireReady();
    this.#requireMetadataState();
    if (this.#host === getProductionHost()) throw new PlusError('TARGET_DENIED', 'Program extraction is not qualified for the production target');
    if (!this.#tlsVerified || this.#version !== 2) throw new PlusError('SECURITY_REQUIRED', 'Program extraction requires the verified TLS V2 profile; no plaintext fallback');
    if (this.#protection !== 1) throw new PlusError('ACCESS_RIGHTS_UNQUALIFIED', 'Program extraction requires the qualified effective access level');
  }

  /** @param {import('../protocol/s7commplus/block-upload.js').ProgramBlock} block */
  async #readProgramBlock(block) {
    this.#requireProgramUpload();
    const protection = block.nativeAttributes.find(attribute => attribute.id === 2524)?.value;
    const modes = protection?.flags === 0 && protection.structId === 3447 && Array.isArray(protection.value)
      ? protection.value.filter((/** @type {{id:number,value:PlusValue}} */ member) => member.id === 3448) : [];
    if (modes.length !== 1 || modes[0].value.flags !== 0 || modes[0].value.datatype !== 11) {
      throw new PlusError('PROTECTION_STATE_UNQUALIFIED', 'No qualified native block-protection mode; no content request transmitted');
    }
    if (modes[0].value.value !== 0) throw new PlusError('PROTECTED_BLOCK', 'Nonzero native block-protection mode; no credentials guessed or content request transmitted');
    const evidence = await this.#explore(block.objectRid, { attributes: [...BLOCK_CONTENT_ATTRIBUTES] }, 'readBlockContent');
    try {
      const content = decodeBlockContent(block, evidence);
      if (content.totalComponentBytes > this.#limits.maxUploadBytes) throw new PlusError('RESPONSE_LIMIT', 'Block content exceeds the upload byte budget');
      return content;
    } catch (error) { this.#stop(this.#asError(error)); throw error; }
  }

  /** @param {{type:'DB',number:number}} selector */
  async getBlockMetadata(selector) {
    this.#requireReady();
    this.#requireMetadataState();
    if (selector?.type !== 'DB' || !Number.isInteger(selector.number) || selector.number < 1 || selector.number > 65535) {
      throw new PlusError('ARGUMENT', 'Select a DB number in 1..65535');
    }
    const cached = this.#blocks.get(selector.number);
    if (cached) return structuredClone(cached);
    const inventory = await this.listDataBlocks();
    const block = inventory.blocks.find(block => block.number === selector.number);
    if (!block) throw new PlusError('BLOCK_UNAVAILABLE', 'DB was not returned by bounded native discovery');
    const reference = await this.#readSymbolicValue({ accessArea: block.objectRid, lids: [1] });
    if (reference.value.flags !== 0 || reference.value.datatype !== 18 || !Number.isInteger(reference.value.value)) {
      throw new PlusError('DATATYPE_MISMATCH', 'DB type reference must be a scalar native RID');
    }
    const metadata = { ...block, typeInfoId: reference.value.value || null,
      status: reference.value.value ? 'TYPE_REFERENCE_RESOLVED' : 'TYPE_UNAVAILABLE',
      evidence: { inventory: block.evidence, typeReference: reference } };
    this.#blocks.set(selector.number, structuredClone(metadata));
    return metadata;
  }

  /** @param {number} typeInfoId */
  async getTypeInfo(typeInfoId) {
    this.#requireReady();
    if (!Number.isInteger(typeInfoId) || typeInfoId < 1 || typeInfoId > 0xFFFFFFFF) throw new PlusError('ARGUMENT', 'Expected a native type-info RID');
    let evidence = this.#types.get(typeInfoId);
    if (!evidence) {
      evidence = await this.#explore(typeInfoId, { recursive: true });
      this.#types.set(typeInfoId, structuredClone(evidence));
    }
    const objects = evidence.objects.filter(object => object.rid === typeInfoId && object.classId === 511);
    if (objects.length > 1) throw new PlusError('AMBIGUOUS_METADATA', 'Multiple native type objects match the requested RID');
    return { typeInfoId, object: structuredClone(objects[0] ?? null),
      status: objects.length ? 'AVAILABLE' : 'UNAVAILABLE', evidence: structuredClone(evidence) };
  }

  /** @param {{type:'DB',number:number}} selector @param {{maxMembers?:number,maxTypes?:number}} [options] */
  async listBlockMembers(selector, options = {}) {
    this.#requireReady();
    const maxTypes = options.maxTypes ?? 8;
    const maxMembers = options.maxMembers ?? 4096;
    if (!Number.isSafeInteger(maxTypes) || maxTypes < 1 || maxTypes > 65536 || !Number.isSafeInteger(maxMembers) || maxMembers < 1 || maxMembers > 1048576) {
      throw new PlusError('ARGUMENT', 'Discovery budgets require 1..65536 types and 1..1048576 members');
    }
    const block = await this.getBlockMetadata(selector);
    /** @type {PlusObject[]} */
    const objects = [];
    /** @type {unknown[]} */
    const evidence = [];
    const pending = block.typeInfoId ? [block.typeInfoId] : [];
    const queued = new Set(pending);
    const byId = new Map();
    const visited = new Set();
    for (let offset = 0; offset < pending.length && visited.size < maxTypes; offset++) {
      const id = pending[offset];
      if (visited.has(id)) continue;
      visited.add(id);
      const info = await this.getTypeInfo(id);
      evidence.push(info.evidence);
      for (const object of info.evidence.objects.filter(object => object.classId === 511)) {
        const previous = byId.get(object.rid);
        if (previous && JSON.stringify(previous) !== JSON.stringify(object)) throw new PlusError('METADATA_CHANGED', 'Conflicting native type definitions in one discovery');
        if (!previous) { objects.push(object); byId.set(object.rid, object); }
        for (const entry of object.typeMembers ?? []) {
          const relation = entry.offset.relationId;
          if (relation && !queued.has(relation)) { pending.push(relation); queued.add(relation); }
        }
      }
    }
    const result = buildBlockMembers(block, objects, maxMembers);
    this.#namedMembers = this.#namedMembers.filter(item => this.#memberBindings.get(item.member)?.block.number !== block.number);
    const nativeBlock = structuredClone(block);
    const metadataEvidence = structuredClone(evidence);
    for (const member of result.members.filter(member => member.readable)) {
      this.#memberBindings.set(member, { block: nativeBlock, member: structuredClone(member), metadataEvidence });
      if (block.name && member.path) {
        this.#namedMembers.push({ name: `${block.name}.${member.path}`, member }, { name: `"${block.name}".${member.path}`, member });
      }
    }
    return { ...result, evidence, receivedAt: new Date().toISOString() };
  }

  /** @param {RuntimeMember} member */
  async readMember(member) {
    this.#requireReady();
    const binding = this.#memberBindings.get(member);
    if (!binding) throw new PlusError('UNVERIFIED_ADDRESS', 'Use a readable member discovered by this client session');
    const { block, member: native } = binding;
    // The browsed per-entry CRC is not the GetMultiVariables address CRC.
    const observation = await this.readSymbolic({ accessArea: block.objectRid, lids: native.accessPath, symbolCrc: 0 });
    let decoded;
    try { decoded = validateMemberValue(native, observation.value); }
    catch (error) { this.#stop(this.#asError(error)); throw error; }
    return { block: structuredClone(block), symbol: structuredClone(native),
      runtime: { protocol: 's7commplus', objectRid: block.objectRid, typeInfoId: block.typeInfoId,
        memberTypeInfoId: native.typeInfoId, memberId: native.memberId, accessPath: [...native.accessPath],
        symbolCrc: 0, metadataSymbolCrc: native.symbolCrc },
      observation: { ...decoded, quality: 'GOOD', source: 'S7COMMPLUS_RESPONSE', receivedAt: observation.receivedAt, nativeTimestamp: null },
      evidence: { metadata: structuredClone(binding.metadataEvidence), response: observation } };
  }

  /** @param {string} name */
  async readSymbol(name) {
    this.#requireReady();
    const matches = this.#namedMembers.filter(item => item.name === name);
    if (matches.length !== 1) throw new PlusError(matches.length ? 'AMBIGUOUS_SYMBOL' : 'SYMBOL_UNAVAILABLE', 'Discover an unambiguous readable block member before a named read');
    return this.readMember(matches[0].member);
  }

  /** @param {{accessArea:number,lids:number[],symbolCrc?:number,name?:string,datatypeIdentity?:unknown}} address */
  async readSymbolic(address) {
    this.#requireReady();
    if (this.#cpuState !== 'RUN') throw new PlusError('CPU_STATE', 'Symbolic read requires a genuine RUN reply');
    return this.#readSymbolicValue(address);
  }

  /** @param {{accessArea:number,lids:number[],symbolCrc?:number,name?:string,datatypeIdentity?:unknown}} address */
  async #readSymbolicValue(address) {
    try {
      const response = await this.#exchange({ kind: 'read', accessArea: address.accessArea, lids: address.lids, symbolCrc: address.symbolCrc });
      const item = response.cursor.uint();
      if (item === 0) {
        const errorItem = response.cursor.uint();
        if (errorItem === 1) {
          const code = response.cursor.integer(64);
          if (response.cursor.uint() !== 0) throw new PlusError('MALFORMED_RESPONSE', 'Unexpected additional item error');
          this.#checkScalarTail(response.cursor, response.expectedIntegrityId);
          throw new PlusError('ITEM_REJECTED', `Symbolic item 1 error 0x${code.toString(16)}; access cause not inferred`);
        }
        if (errorItem !== 0) throw new PlusError('MALFORMED_RESPONSE', 'Unexpected error item number');
        this.#checkScalarTail(response.cursor, response.expectedIntegrityId);
        throw new PlusError('DATA_UNAVAILABLE', 'PLC supplied neither value nor item error; not interpreted as zero');
      }
      if (item !== 1) throw new PlusError('DATA_UNAVAILABLE', 'PLC did not supply symbolic item 1; not interpreted as zero');
      const value = decodeValue(response.cursor);
      if (response.cursor.uint() !== 0 || response.cursor.uint() !== 0) throw new PlusError('MALFORMED_RESPONSE', 'Unexpected item or error list');
      this.#checkScalarTail(response.cursor, response.expectedIntegrityId);
      return { address: structuredClone(address), value, status: 'GOOD', receivedAt: new Date().toISOString(), nativeTimestamp: null,
        correlation: response.correlation };
    } catch (error) { this.#stop(this.#asError(error)); throw error; }
  }

  /** @param {unknown} [_block] @returns {Promise<never>} */
  async uploadBlock(_block) {
    throw new PlusError('UNSUPPORTED_UPLOAD', 'This legacy entry point remains disabled; use uploadProgramBlock() for qualified native-attribute extraction; nothing transmitted');
  }

  async disconnect() {
    clearTimeout(this.#durationTimer);
    this.#sessionKey?.fill(0);
    const socket = this.#socket;
    this.#ready = false;
    this.#phase = 'closed';
    this.#settle(undefined, new PlusError('DISCONNECTED', 'Own session disconnected'));
    if (!socket || socket.destroyed) { await this.#closed; return; }
    await new Promise(resolve => {
      const timer = setTimeout(() => socket.destroy(), 1000);
      socket.once('close', () => { clearTimeout(timer); resolve(undefined); });
      this.#tls?.end();
      socket.end();
    });
  }

  #requireReady() {
    if (this.#failure) throw this.#failure;
    if (!this.connected) throw new PlusError('SESSION_REQUIRED', 'No usable S7CommPlus session');
  }

  /** @param {any[]} entries @param {any} entry */
  #record(entries, entry) {
    entries.push(entry);
    if (entries.length > this.#limits.maxDiagnosticEntries) entries.splice(0, entries.length - this.#limits.maxDiagnosticEntries);
  }

  /** @param {Cursor} cursor @param {number|undefined} expected */
  #checkIntegrity(cursor, expected) {
    if (expected === undefined) return;
    const observed = cursor.uint();
    if (observed !== expected) throw new PlusError('INDETERMINATE_PROTOCOL_ERROR', 'Response integrity counter does not match the outstanding request', { expectedIntegrityId: expected, observedIntegrityId: observed });
  }

  /** @param {Cursor} cursor @param {number} [expectedIntegrityId] */
  #checkScalarTail(cursor, expectedIntegrityId) {
    this.#checkIntegrity(cursor, expectedIntegrityId);
    if (cursor.offset === cursor.bytes.length) return;
    if (expectedIntegrityId !== undefined && cursor.bytes.length - cursor.offset === 4 && cursor.take(4).every(byte => byte === 0)) return;
    if (this.#version !== 1 || cursor.bytes.length - cursor.offset !== 1 || cursor.byte() !== 0) {
      throw new PlusError('UNSUPPORTED_DECODING', 'Unqualified response suffix or integrity profile');
    }
  }

  /** @param {PlusValue} version */
  #extractIdentity(version) {
    if (version.datatype !== 23) return;
    const members = /** @type {{id:number,value:PlusValue}[]} */ (version.value);
    const text = members.find(member => member.id === 319 && member.value.datatype === 21)?.value.value;
    if (typeof text !== 'string') return;
    this.#identity.deviceString = text;
    const fields = text.split(';');
    if (fields.length >= 3) { this.#identity.orderNumber = fields[1].trim() || null; this.#identity.firmware = fields[2].trim() || null; }
  }

  /** @param {PlusOperation} operation */
  async #exchange(operation) {
    if (this.#busy) throw new PlusError('CONCURRENCY_LIMIT', 'Only one outstanding request');
    if (this.#failure) throw this.#failure;
    if (this.#requests >= this.#limits.maxRequests) throw new PlusError('REQUEST_LIMIT', 'Request count exhausted');
    this.#busy = true;
    const sequence = this.#sequence++;
    const context = { sessionId: this.#sessionId, version: this.#version, serverVersion: this.#serverVersion,
      securityKey: operation.kind === 'setupSession' ? this.#securityKey : undefined, sessionKey: this.#sessionKey,
      integrityId: this.#sessionKey ? operation.kind === 'activateSession' ? this.#writeIntegrityId++ : this.#integrityId++
        : this.#ready && this.#tls ? this.#integrityId++ : undefined };
    try {
      const frame = encodeOperation(operation, context, sequence);
      if (frame.length > this.#limits.maxRequestBytes) throw new PlusError('REQUEST_LIMIT', 'Configured request-byte budget exceeded');
      const wait = this.#limits.pacingMs - (performance.now() - this.#lastRequest);
      if (wait > 0) await delay(wait);
      if (this.#failure) throw this.#failure;
      const started = performance.now();
      const incoming = await this.#wait(() => {
        assertOutgoing(frame, operation, context, sequence);
        this.#requests++;
        this.#lastRequest = performance.now();
        this.#record(this.#transcript, { direction: 'out', kind: operation.kind, sequence, hex: frame.toString('hex').slice(0, 2048) });
        if (this.#tls) this.#tls.write(frame);
        else this.#sendDT(frame);
      });
      const latencyMs = performance.now() - started;
      this.#record(this.#observations, { kind: operation.kind, sequence, latencyMs: Number(latencyMs.toFixed(3)), responseBytes: incoming.body.length });
      const latencyKey = JSON.stringify(operation);
      const baseline = this.#baselines.get(latencyKey);
      if (latencyMs > this.#limits.maxLatencyMs || (baseline && latencyMs > Math.max(1000, baseline * this.#limits.latencyFactor))) {
        throw new PlusError('LATENCY_DEGRADATION', `Acquisition stopped at ${latencyMs.toFixed(1)} ms`);
      }
      if (baseline === undefined) this.#baselines.set(latencyKey, latencyMs);
      if (operation.kind === 'initSSL' && incoming.version !== 1 && !(this.#options.securityMode === 'tls' && incoming.version === 2)) {
        throw new PlusError('PROTOCOL_VERSION_UNSUPPORTED', 'InitSSL envelope is not qualified for the explicitly selected security profile');
      }
      if (this.#ready && incoming.version !== (this.#sessionKey ? 3 : this.#version)) throw new PlusError('PROTOCOL_VERSION_UNSUPPORTED', 'Response changed the negotiated data protocol version');
      const expectedIntegrityId = context.integrityId === undefined ? undefined
        : this.#sessionKey && operation.kind === 'activateSession' ? context.integrityId : (sequence + context.integrityId) >>> 0;
      let responseBody = incoming.body;
      if (this.#sessionKey && operation.kind === 'activateSession') {
        const prefix = new Cursor(responseBody.subarray(10));
        this.#checkIntegrity(prefix, expectedIntegrityId);
        responseBody = Buffer.concat([responseBody.subarray(0, 10), prefix.bytes.subarray(prefix.offset)]);
      }
      const decoded = responsePayload(responseBody, PLUS_FUNCTION[/** @type {keyof typeof PLUS_FUNCTION} */ (operation.kind)], sequence,
        this.#tlsEstablished && operation.kind === 'createSession', this.#options.securityMode === 'legacy' && operation.kind === 'initSSL',
        !!this.#sessionKey && operation.kind === 'activateSession');
      if (decoded.statusDetails.returnValue !== '0x0000000000000000') {
        this.#record(this.#observations, { kind: operation.kind === 'initSSL' ? 'legacyInitSSLStatus' : `${operation.kind}Status`, ...decoded.statusDetails,
          interpretation: operation.kind === 'initSSL' ? 'Explicit legacy profile continues after a recognized InitSSL rejection; no TLS downgrade performed' : 'Session objects and setup must validate before establishment' });
      }
      return { ...decoded, version: incoming.version, expectedIntegrityId: this.#sessionKey && operation.kind === 'activateSession' ? undefined : expectedIntegrityId,
        correlation: { sequence, functionCode: PLUS_FUNCTION[/** @type {keyof typeof PLUS_FUNCTION} */ (operation.kind)],
          integrityId: expectedIntegrityId ?? null, request: structuredClone(operation), responseBody: Buffer.from(incoming.body),
          fragmentCount: this.#plus.lastMessageFragmentCount } };
    } catch (error) {
      const failure = this.#asError(error);
      this.#stop(failure);
      throw failure;
    } finally { this.#busy = false; }
  }

  /** @param {()=>void} send */
  #wait(send) {
    if (this.#pending) return Promise.reject(new PlusError('CONCURRENCY_LIMIT', 'Exchange already pending'));
    return new Promise((resolve, reject) => {
      const timeoutMs = this.#phase === 'tls' ? this.#limits.tlsHandshakeTimeoutMs : this.#limits.requestTimeoutMs;
      const timer = setTimeout(() => this.#stop(new PlusError('TIMEOUT', `Timed out during ${this.#phase}`)), timeoutMs);
      this.#pending = { resolve, reject, timer };
      try { send(); } catch (error) { this.#stop(this.#asError(error)); }
    });
  }

  /** @param {any} value @param {Error} [error] */
  #settle(value, error) {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    clearTimeout(pending.timer);
    if (error) pending.reject(error); else pending.resolve(value);
  }

  /** @param {Buffer} cotp */
  #writeTPKT(cotp) {
    if (!this.#socket || this.#socket.destroyed || this.#failure) throw new PlusError('NETWORK', 'Transport closed');
    const header = Buffer.from([3, 0, 0, 0]);
    header.writeUInt16BE(cotp.length + 4, 2);
    const frame = Buffer.concat([header, cotp]);
    if (this.#txBytes + this.#rxBytes + frame.length > this.#limits.maxSessionBytes) throw new PlusError('SESSION_LIMIT', 'Total session byte budget exhausted');
    this.#txBytes += frame.length;
    this.#socket.write(frame);
  }

  /** @param {Buffer} bytes */
  #sendDT(bytes) {
    for (let offset = 0; offset < bytes.length; offset += 1000) {
      this.#writeTPKT(Buffer.concat([Buffer.from([2, 0xF0, offset + 1000 >= bytes.length ? 0x80 : 0]), bytes.subarray(offset, offset + 1000)]));
    }
  }

  /** @param {Buffer} bytes */
  #onTCP(bytes) {
    this.#rxBytes += bytes.length;
    if (this.#rxBytes + this.#txBytes > this.#limits.maxSessionBytes) throw new PlusError('SESSION_LIMIT', 'Total session byte budget exhausted');
    if (bytes.length + this.#tcp.length > this.#limits.maxResponseBytes) throw new PlusError('RESPONSE_LIMIT', 'TCP buffer limit');
    this.#tcp = Buffer.concat([this.#tcp, bytes]);
    while (this.#tcp.length >= 4) {
      if (this.#tcp[0] !== 3 || this.#tcp[1] !== 0) throw new PlusError('MALFORMED_RESPONSE', 'Invalid TPKT');
      const length = this.#tcp.readUInt16BE(2);
      if (length < 7 || length > this.#limits.maxResponseBytes) throw new PlusError('RESPONSE_LIMIT', 'Invalid or oversized TPKT length');
      if (this.#tcp.length < length) break;
      const cotp = this.#tcp.subarray(4, length);
      this.#tcp = this.#tcp.subarray(length);
      this.#record(this.#transcript, { direction: 'in', layer: 'TPKT', hex: Buffer.concat([Buffer.from([3, 0, length >> 8, length & 255]), cotp]).toString('hex').slice(0, 2048) });
      if (this.#phase === 'cotp') {
        if (cotp[0] !== cotp.length - 1) throw new PlusError('MALFORMED_RESPONSE', 'COTP confirm length mismatch');
        this.#settle(Buffer.from(cotp));
        continue;
      }
      if (cotp[0] !== 2 || cotp[1] !== 0xF0 || (cotp[2] & 0x7F)) throw new PlusError('MALFORMED_RESPONSE', 'Expected class-0 COTP data');
      if (cotp.length > 1024) throw new PlusError('RESPONSE_LIMIT', 'COTP TPDU exceeds negotiated size');
      const payload = cotp.subarray(3);
      this.#cotpBytes += payload.length;
      if (this.#cotpBytes > this.#limits.maxResponseBytes || this.#cotp.length >= 64) throw new PlusError('RESPONSE_LIMIT', 'COTP reassembly limit');
      this.#cotp.push(payload);
      if (!(cotp[2] & 0x80)) continue;
      const data = Buffer.concat(this.#cotp);
      this.#cotp = []; this.#cotpBytes = 0;
      if (this.#tunnel) this.#tunnel.push(data); else this.#onApplication(data);
    }
  }

  /** @param {Buffer} bytes */
  #onApplication(bytes) {
    const confirmations = this.#plus.sessionConfirmations;
    const messages = this.#plus.feed(bytes);
    if (this.#plus.sessionConfirmations !== confirmations) this.#record(this.#observations, { kind: 'sessionConfirmation', count: this.#plus.sessionConfirmations });
    if (messages.length > 1 || (messages.length && !this.#pending)) throw new PlusError('CORRELATION', 'Unexpected unsolicited or duplicate response');
    if (messages.length) {
      if (this.#tlsEstablished) this.#record(this.#transcript, { direction: 'in', layer: 'S7CommPlus', version: messages[0].version, hex: messages[0].body.toString('hex').slice(0, 2048) });
      this.#settle(messages[0]);
    }
  }

  async #activateTLS() {
    this.#phase = 'tls';
    const tunnel = new Duplex({ read() {}, write: (chunk, encoding, callback) => {
      try { this.#sendDT(Buffer.from(chunk)); callback(); } catch (error) { callback(this.#asError(error)); }
    } });
    this.#tunnel = tunnel;
    tunnel.on('error', error => this.#stop(new PlusError('TLS_HANDSHAKE_FAILED', error.message)));
    await this.#wait(() => {
      const peerName = this.#options.tls?.servername ?? this.#host;
      const allowAnyCertificate = this.#options.tls?.allowAnyCertificate === true;
      this.#tls = connectTLS({ socket: tunnel, ca: this.#options.tls?.ca,
        servername: isIP(peerName) ? undefined : peerName, rejectUnauthorized: !allowAnyCertificate,
        checkServerIdentity: (_hostname, certificate) => allowAnyCertificate ? undefined : checkServerIdentity(peerName, certificate),
        minVersion: this.#options.tls?.minVersion ?? 'TLSv1.2', ecdhCurve: 'X25519',
        ciphers: 'TLS_AES_256_GCM_SHA384:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA256:AES256-SHA256',
        secureOptions: constants.SSL_OP_NO_TICKET | 0x00080000 | 0x00000001 }, () => {
        const certificate = this.#tls?.getPeerCertificate().raw;
        if ((!allowAnyCertificate && !this.#tls?.authorized) || !certificate) {
          this.#stop(new PlusError('CERTIFICATE_REJECTED', 'TLS peer certificate was not verified'));
          return;
        }
        const observed = createHash('sha256').update(certificate).digest();
        this.#peerCertificateSha256 = observed.toString('hex');
        const expected = Buffer.from(this.#options.tls?.certificateSha256 ?? '', 'hex');
        if (!allowAnyCertificate && (expected.length !== observed.length || !timingSafeEqual(observed, expected))) {
          this.#stop(new PlusError('CERTIFICATE_PIN_MISMATCH', 'TLS peer does not match the independently approved certificate pin', { observedSha256: this.#peerCertificateSha256 }));
          return;
        }
        this.#tlsVerified = !allowAnyCertificate;
        this.#tlsEstablished = true;
        this.#record(this.#observations, { kind: 'tls', protocol: this.#tls?.getProtocol(), cipher: this.#tls?.getCipher().name, certificateVerified: this.#tlsVerified });
        this.#settle(true);
      });
      this.#tls.on('error', error => {
        const code = /** @type {NodeJS.ErrnoException} */ (error).code ?? '';
        const certificate = ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(code);
        this.#stop(new PlusError(certificate ? 'CERTIFICATE_REJECTED' : 'TLS_HANDSHAKE_FAILED', error.message, { tlsCode: code }));
      });
      this.#tls.on('data', (/** @type {Buffer} */ bytes) => {
        try { this.#onApplication(bytes); } catch (error) { this.#stop(this.#asError(error)); }
      });
    });
  }

  /** @param {unknown} error */
  #asError(error) { return error instanceof PlusError ? error : new PlusError('PROTOCOL', error instanceof Error ? error.message : String(error)); }
  /** @param {PlusError} error */
  #stop(error) {
    if (!this.#failure) this.#failurePhase = this.#phase;
    this.#failure ??= error;
    this.#ready = false;
    clearTimeout(this.#durationTimer);
    this.#settle(undefined, this.#failure);
    this.#tls?.destroy();
    this.#tunnel?.destroy();
    this.#socket?.destroy();
  }
}