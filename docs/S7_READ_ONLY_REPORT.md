# S7 Native Read-Only Acquisition Report

**Current outcome: verified lab TLS sessions, native DB/type-member discovery
and typed BOOL/INT/TIME reads succeeded. No program blocks were uploaded.**

Sections B-G retain historical investigation evidence; section H records the
subsequent native-symbol milestone and supersedes earlier capability limits.

## A. Implemented Backend and Data Flow

- Separate native Node.js `S7CommPlusClient`, not OPC UA, classic S7Comm,
  a Python bridge, or an engineering-file parser.
- TCP -> strict bounded TPKT -> class-0 COTP -> Plus fragment assembler ->
  correlated response -> typed value/object decoder. Unknown shapes stop acquisition.
- Real COTP negotiation, InitSSL, CreateObject and an exact owned-session
  ServerSessionVersion echo are implemented. The echo is the only permitted
  SetMultiVariables envelope, not a generic write interface.
- CPU-state Explore, effective-protection read, bounded explicit object Explore,
  and a one-item LID-addressed typed symbolic read are implemented.
  Native DB discovery, DB type-reference retrieval, bounded exact-type Explore,
  member/name lists, nested access sequences and session-local named reads are
  available. Full controller/program inventories remain unqualified.
  Raw typed bytes and datatype IDs are retained; 64-bit
  values are not converted to imprecise JavaScript numbers. Receive times are
  local observations, not fabricated PLC-native timestamps.
- Canonical operation allowlist before serialization and byte equality check
  immediately before transmission. No public arbitrary Plus send method.
- One outstanding request; at least 250 ms between request starts; defaults:
  12 requests, 900-byte application request, 64 KiB response, 256 KiB aggregate
  session traffic, 32 objects, 5 s request timeout, 60 s session ceiling.
  Latency above 4 s or a substantial baseline-relative increase stops work.
  No reconnect, retry, scheduler, active subscription or recurring backup.
- Only the configured production IP, a separately configured authorized lab IP,
  or explicit loopback fixtures are accepted. Lab and production targets cannot
  coincide; lab profiles must be explicitly `legacy` or `tls`. The
  production IP is rejected by the classic connection backend before socket
  creation; classic read/write support for other endpoints is not removed.
- TLS-over-COTP is independently offline-tested, with normal CA/hostname checks
  and a mandatory independently approved SHA-256 certificate pin checked before
  CreateObject. It remains refused for the production target before transmission.
  SessionKey, credential authentication, V3/HMAC and alternative
  security profiles are unsupported. No key probes or plaintext fallbacks.
- Compatibility methods that previously fabricated metadata, upload results or
  control-operation success now return `0x00F00000`, with no PLC operation.
- WASM and AssemblyScript are unchanged: no measured benefit justified moving
  this small bounded metadata path into WASM. Existing DAQ/proxy/API traffic is
  not automatically routed through the experimental client.

## B. Historical Plaintext Evidence and Statistics

Exactly one attempt was reported against the production controller through the
bounded exploration CLI (the old `explore:s7` script name is not in this checkout).
UTC start `2026-10-26T15:02:48.480Z`; finish `2026-10-26T15:02:48.976Z`.
The following table preserves that attempt's original statistics. A later,
separately authorized local lab attempt is recorded below. No further
production or lab probes were made during this offline investigation.

| Observation | Actual result |
| --- | --- |
| TCP and COTP | Accepted; class 0, 1024-byte TPDU |
| InitSSL | V1 success reply; observed latency 82.586 ms |
| CreateObject | V1 error reply; observed latency 20.333 ms |
| Exact ReturnValue | `0xa201d60001f9fdf8` |
| Classification | `PLC_REJECTED`; reason not inferred |
| Plus request count | 2: InitSSL and CreateObject |
| Transport bytes | 248 sent, 106 received, including TPKT/COTP |
| Reported elapsed time | 495 ms |
| Established sessions | 0 |
| Model / order number / firmware | Unknown / null |
| CPU state / effective protection | Unknown / null |
| Online symbols / DBs / datatypes / program blocks inventoried | 0 |
| Symbolic reads / block uploads | 0 / 0 |
| CPU-state changes, process writes, download/delete/control requests | None transmitted |

This does not establish why CreateObject failed. In particular it does not prove
that credentials, TLS, PUT/GET configuration, or any specific firmware are the
cause. No claim is made that machine impact was independently verified.
The client stopped on the first error and disconnected its own transport.

Local immutable evidence manifest:
[`backups/s7/2026-10-26T15-02-48-982Z-9629c2c706d3.json`](../backups/s7/2026-10-26T15-02-48-982Z-9629c2c706d3.json).
It references a JSON report and all three received TPKT frames stored by SHA-256
under the adjacent `content/` directory. The JSON report also contains both
outgoing Plus messages. The outgoing COTP request is not separately archived.
Evidence stays local and is git-ignored; it may contain engineering information.

The separate authorized local plaintext attempt independently returned the same
value. Its immutable evidence remains outside published artifacts.
It recorded two requests, 248 bytes sent,
106 received, approximately 495 ms, zero established sessions and zero variable
reads/process writes.
Its outgoing InitSSL and CreateObject messages were replayed offline against the
current encoder and match exactly. Both attempts selected plaintext discovery;
neither activated TLS. Existing manifests and content were not rewritten.

## C. Per-Block Acquisition and Backup Status

No block identifiers were returned and no upload request was sent. Consequently
there is no genuine per-block success/failure table to populate. Do not invent
online records for the reference project's nominal blocks.

| Artifact category | Attempted | Uploaded bytes | Status |
| --- | --- | --- | --- |
| OB / FB / FC / DB | No | 0 | Session unavailable; transfer contract unqualified |
| Type definitions / online program metadata | No | 0 | Session unavailable |
| Restorable controller/project backup | No | 0 | Not obtained |

`uploadBlock()` returns `UNSUPPORTED_UPLOAD` before any transmission. The public
reference's experimental transfer does not qualify block addressing, chunking,
finalization or completeness, so it was deliberately not sent. `maxUploadBytes`
is reserved configuration, not evidence of an implemented transfer limit.

The local evidence store provides exclusive-create manifests, SHA-256 content
addressing, deduplication, corruption detection, raw reply preservation, timestamps
and failure reporting. These are **acquisition evidence, not program backups**.
Current live completeness is null, status INCOMPLETE, `blockArtifacts: []`,
`restorableProject: false`. There is no qualified block completeness model,
program-version diff, backup HTTP API, restore path or recurring-backup service.

## D. Engineering Reference Comparison

The archive was not found in the workspace. External directories were not searched.
No archive contents or exact online/offline revision match were verified.
The following numbers are user-supplied reference figures, not online findings:

| Reference metric | User-supplied count | Verified online |
| --- | --- | --- |
| Declarations | approximately 8,560 | Unavailable |
| OPC UA publication entries | 490 | Unavailable |
| DBs | 96 | Unavailable |
| Datatypes | 22 | Unavailable |
| Program blocks | 16 | Unavailable |

Declaration count, OPC UA publication count, runtime-addressable objects and
optimized DB members are different populations. None can be substituted for
another or used to infer complete visibility. No merged name/type/address map,
archive parser or external engineering-JSON importer was implemented.

## E. Files, Validation and Compatibility

Implementation:
`src/protocol/s7commplus/codec.js`, `src/client/s7commplus-client.js`,
`src/protocol/production-policy.js`, `src/client/plc-connection.js`,
`src/compat/s7client.js`, `src/backup/evidence-store.js`, `src/plus-explore.js`,
`src/lib.js`; CLI/package/ignore wiring and third-party notices.

Tests:
`test/unit/s7commplus.test.js`, `test/unit/s7-readonly.test.js`, and the corrected
unsupported-GetCpuInfo expectation in `test/integration/s7client.test.js`.

- `npm run check-types`: passes.
- Focused codec/client/safety/evidence checks: **101 passed**. Covers typed values,
  UInt32/64 limits, fragments, bounds, canonical tampering, forbidden functions,
  full loopback handshake/read, CPU STOP, authentication challenge, correlation,
  timeout, no retry, session cleanup, target singleton, budgets, explicit item
  errors, unknown suffixes, protection marker and content-store corruption.
- Full Linux suite via `npm test -- --configLoader runner`: **291 tests passed
  in 22 files**, including native-snap7/classic/WASM interoperability. This
  supersedes the older Windows-native import failure; no dependency manifest or
  runner configuration was changed. The Linux baseline before this investigation
  was 283 passing tests. Dependencies were installed with `--legacy-peer-deps`
  because npm 10.9.8 otherwise failed internally in Arborist.
- Six independently executed reference scenarios pass; see section G. Python
  is only an optional offline test dependency, not a runtime dependency.
- Qualified real-controller functionality: COTP/InitSSL and fail-closed rejection
  handling only. Complete sessions and reads are verified against synthetic
  loopback fixtures, not Siemens firmware. TLS transport is offline-qualified,
  not hardware-qualified. Independent-emulator session limitations are retained.
- No commit, branch, push or deployment. Commit hash/message: not applicable.

## F. Historical Investigation Plan

1. Analyze the preserved CreateObject bytes offline against an authorized,
   sanitized known-good capture for this CPU/session profile. Establish the
   expected request shape and exact error semantics before proposing another
   live attempt. Do not infer them from the error value alone.
2. Obtain authoritative controller/security-profile information through the
   existing engineering workflow. If verified TLS or authentication is required,
   first implement and loopback-test that exact supported profile with normal
   trust verification. No settings changes, key-family probes or bypasses.
3. Make the reference archive or a sanitized engineering export available locally
   for offline analysis. Keep publication metadata separate from full declarations
   and do not assert a revision match without evidence.
4. Only after session establishment and genuine RUN/protection replies, review a
   small explicit metadata query. Establish real name/type/LID relationships and
   test limited symbolic reads before extending inventory coverage.
5. Qualify a documented block-upload profile on a nonproduction controller or
   authoritative capture, including total length, sequence, chunk integrity,
   termination and cleanup. Only then implement bounded block acquisition,
   honest completeness levels and content/version diffs. No automatic controller dump.
6. Preserve classic/WASM interoperability and evidence-manifest regression gates.
  The full Linux suite now passes; no production hardware is needed for them.

## G. Offline CreateObject and TLS Investigation (2026-10-26)

Reference: MIT-licensed `gijzelaerr/s7commplus`, current HEAD and previously cited
commit both `245350ea0ca6327234e5032e781a99782334bc8f`. Only its MIT protocol,
transport and emulator implementation informed this work. No separately licensed
driver code, SessionKey algorithms or key material was incorporated.

### Confirmed findings

1. COTP connection requests are byte-identical: local TSAP `0600`, remote TSAP
  `SIMATIC-ROOT-HMI`, class 0, requested TPDU 1024. InitSSL requests match exactly.
2. Complete CreateObject frames match the independently running reference after
  replacing only four declared identity strings (`s7commplus` versus `S7Proxy`)
  and their string/outer lengths. All header fields, sequence 1, session 288,
  flag `36`, RequestId 285, ValueUDInt(0), four zero padding bytes, ordered
  attributes, nested subscription object, A2 boundaries and trailing padding
  match. The unmodified reference frame is retained in the fixture with SHA-256
  `1097734503fe14af28a5b3ff6cd9861121f2a414dbb17d57f40bb67926972ed1`.
3. That golden was independently encoded by the reference, not captured from a
  real PLC. The reference source cites independent TIA capture analysis for
  padding, but no shareable golden CreateObject request was found in this
  checkout. An accepted real-device CreateObject request remains a missing oracle.
4. Both implementations independently decode `d180bae08087f3fdf8` as the
  nine-byte UInt64 value `0xa201d60001f9fdf8`. Replaying the preserved rejection
  prevents session establishment in both clients: five remaining zero bytes
  contain no usable session object. The numeric value's meaning is not inferred.
5. The TLS-selected reference path is COTP -> InitSSL -> TLS -> V1 CreateObject ->
  V2 setup/data. S7Proxy's selected TLS path follows that order. Its earlier
  plaintext discovery selections never activated TLS. This confirms what was
  sent, not which profile either PLC requires or that TLS fixes the rejection.
6. The independent TLS emulator exposed an overly strict V1-only InitSSL response
  check. V2 is now allowed only when TLS was explicitly selected; legacy mode
  still stops before CreateObject. This mismatch was not the historical PLC
  failure, whose InitSSL reply was V1.

### Security and interoperability coverage

TLS records are COTP DT payloads; TPKT/COTP headers remain outside TLS. Node's
TLS engine checks certificate validity, CA and hostname; SHA-256 over the verified
peer's DER must additionally match a preapproved 64-digit hex pin in constant time.
Missing/malformed pins stop before I/O; mismatches stop before CreateObject.
Observed pins are reported without marking mismatches `TLS_VERIFIED`.
Cipher suites, X25519 and OpenSSL options match the reference's explicit profile.
No certificate bypass, insecure discovery, automatic trust or plaintext retry is
used to learn the pin. OPC UA's certificate is not assumed to be TCP/102's.

Regression cases cover V1/V2 InitSSL, segmented RSA TLS flights/TCP splitting,
approved pin success, wrong pin/CA/name, peer abort, handshake deadline, integrity
counter mismatch, and no fallback. Session setup bytes match for both plaintext
and TLS in independent-client comparisons. Legacy SessionKey challenges stop as
`LEGACY_SESSION_KEY_REQUIRED`. A legacy challenge attribute alone does not imply
password authentication after verified TLS; unsupported secured roles and
credential options/profiles still stop explicitly.
V3/HMAC, SessionKey generation and credential legitimation remain unimplemented.

The six differential scenarios are plaintext success, synthetic CreateObject
rejection, synthetic composite rejection, TLS success, wrong TLS pin, and direct TLS transport
to the independent reference server. The final case verifies CA/name/pin, then
deliberately rejects that emulator's class-0 session root and duplicate attribute
306. Owned-session checks were not weakened. Its unsegmented large RSA TLS flight
also exceeds the negotiated TPDU; a compact ECDSA test certificate allows transport
comparison without relaxing bounds. Do not claim full independent-server session
success or hardware qualification from this result.

Reproduce using an isolated interpreter containing that pinned reference:

```sh
S7PROXY_REFERENCE_PYTHON=/path/to/isolated/python node test/s7commplus-differential.js
npm run check-types
npm test -- --configLoader runner
```

### Local gate and actual result

```json
{
  "target": "configured authorized lab target",
  "previousResult": "SESSION_CREATE_REJECTED",
  "returnValue": "0xa201d60001f9fdf8",
  "offlineReferenceComparison": "PASSED_WITH_DOCUMENTED_EMULATOR_LIMITATIONS",
  "plcSecurityProfile": "NOT_INDEPENDENTLY_ESTABLISHED",
  "approvedTcp102CaAndCertificatePin": "NOT_AVAILABLE",
  "newLocalAttempt": "NOT_ATTEMPTED_PROFILE_AND_TRUST_GATE",
  "newProductionAttempts": 0,
  "newPlcProcessWrites": 0
}
```

Next prerequisite is engineering/configuration evidence for the local PLC's
TCP/102 security profile and, if TLS is selected, its approved CA, certificate
name and independently verified SHA-256 pin. No attempt was spent to guess these.
Once established and authorized, the explicit lab CLI makes one read-only attempt
with five requests, a 20-second session ceiling and three-second request deadlines,
preserving the existing evidence schema under `backups/lab/`. No further production
probe is authorized by these offline results. The shared PLC rejection's root cause
remains unconfirmed; no undocumented meaning is assigned to its value.

## H. Native Symbol Milestone (2026-10-26)

An independently established secure-only lab profile and independently approved
communication certificate enabled TLS-over-COTP, CreateObject and owned-version
setup. Real RUN and effective-access replies succeeded. This is not authorization
or qualification for a production retest. Historical plaintext rejection semantics
remain unconfirmed.

Native discovery retrieved two DB runtime objects, their separate type references,
and 25 named members. The instance DB referenced a separate system type, not its
runtime DB RID. Type objects were retrieved through bounded exact-RID
Explore, not unrestricted catalog enumeration. The raw replies and decoded
metadata remain private local evidence, outside published fixtures.

Eight successful process-value requests covered seven distinct members across
two successful read sessions: three BOOLs, two INTs and two TIMEs. An earlier
qualified read was rejected when the browsed type-entry CRC was incorrectly used
as an address CRC. The corrected implementation preserves the former as metadata
and sends the established zero address CRC. It does not retry automatically.
TIME responses retain signed 32-bit native values and millisecond units.

Public methods:

- `listDataBlocks()` retains native DB names, numbers and object RIDs.
- `getBlockMetadata({ type: 'DB', number })` reads native LID 1 for the type RID.
- `getTypeInfo(typeInfoId)` retrieves the referenced class-511 object and evidence.
- `listBlockMembers(selector, { maxTypes, maxMembers })` decodes type/name lists
  and reconstructs hierarchy and complete LID sequences within explicit budgets.
- `readMember(member)` accepts only this client's qualified discovery descriptors.
- `readSymbol(name)` resolves names only after explicit block discovery.

The self-contained decoder handles multi-block lists, offset-info variants,
referenced structures and bounded array expansion. Unknown or ambiguous layouts,
missing names/types, recursion, pointers, FB arrays and packed BOOL arrays are
explicitly incomplete or unsupported, never silently made readable. Nested,
multidimensional and repeated-instance paths have synthetic regression coverage;
they are not all hardware-qualified by the primitive/IEC-instance lab reads.
Session snapshots do not establish a complete downloaded project revision.

Public tests are independently constructed synthetic fixtures. Controller
captures, certificates, addresses, member names and process data are not included
as public test artifacts. Raw value bytes, software/wire datatype distinctions,
request sequence, integrity ID, address and receipt time remain available to
consumers for evidence-based reconciliation. No external engineering parser or
Python runtime is required. Program upload remains `UNSUPPORTED_UPLOAD`;
uploaded bytes: zero.

Final standalone validation: 332 tests passed in 24 files, JavaScript typecheck
passed, and all six pinned-reference scenarios passed. Package dry-run inspection
included the native decoder and excluded captures, certificates and test fixtures.