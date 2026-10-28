# S7 Native Read-Only Acquisition Report

## TIA Portal Coexistence and Session Roles (2026-10-28)

### Symptom and Cause

An authorized TLS connection to the configured CPU was rejected while TIA Portal
was already connected. TCP, COTP and TLS succeeded, but CreateSession
(`CreateObject`, function `0x04CA`) returned service result -134, classified as
`ENGINEERING_SESSION_IN_USE` with the message "Service Multi-ES Not Supported".
Conversely, an established library session had been reported to block engineers
from connecting TIA Portal. That reverse-order symptom was user-reported, not
independently reproduced in this qualification.

The client already requested the `SIMATIC-ROOT-HMI` COTP destination TSAP. Its
CreateSession payload nevertheless explicitly requested `ServerSession.Role`
(attribute 299) as UDInt(1). Removing only that attribute, while keeping the TSAP,
client identification, ClientRID and subscription container unchanged, allowed
the connection with TIA online. The PLC then returned role 2. This isolates the
observed conflict to the explicit role request; it does not establish a universal
Siemens role-number taxonomy or imply that HMI transport identity selects a role.
The rejection occurred before DB exploration, not because discovery later left
the session in an engineering mode.

### Library Behavior

- `createSessionPayload()` in `src/protocol/s7commplus/codec.js` intentionally
  omits attribute 299. Do not reintroduce role 1 merely to match a reference
  client's TIA-style identification frame. No role selector or role-switch API
  is provided by this fix.
- `client.report.concurrency.connectionType` is the requested transport identity
  (`HMI`), not proof of the PLC's effective session role.
- `client.report.sessionRole.requested` is null because attribute 299 is omitted.
  `returned` records the role only when the owned ServerSession object contains
  one unambiguous scalar UDInt attribute 299; otherwise it is null. A null value
  is unavailable evidence, not role 0 or a coexistence guarantee.
- Existing rejection of unsupported secured-session authentication remains in
  force. Omitting the role request does not disable authentication, certificate
  policy, request integrity, operation allowlists or traffic budgets.
- The tested inventory, DB/type/member exploration and value-read sequence does
  not send a role-change request. A separate PG session or post-discovery role
  downgrade was not needed for that sequence. Other diagnostic and upload
  services are not qualified by this result.

On the tested controller, a connected report contained:

```json
{
  "concurrency": { "connectionType": "HMI" },
  "sessionRole": { "requested": null, "returned": 2 }
}
```

### Live Evidence

The configured CPU 1214C V4.5 was tested with explicit TLS certificate bypass;
its identity remained `TLS_UNVERIFIED`. Certificate bypass was an existing test
configuration, not part of the role fix, and is not recommended as a coexistence
workaround. Exact target identity remains in local experimentation storage.

| Check | Observed result |
| --- | --- |
| Original role-1 request with TIA online | CreateSession rejected with -134 before inventory or value reads |
| Same request with only attribute 299 omitted | Connected, genuine RUN response, PLC-returned role 2 |
| Bounded initial discovery/read probe | Inventory of 96 DBs, DB1 structure with 23 members, one scalar read with GOOD quality |
| Full portal-adapter read-only qualification | 96 DBs plus I/Q/M metadata, 1,314 readable members, three scalar reads, 152 requests, approximately 42.9 seconds |
| Metadata limitation | DB78 retained an incomplete-member-names warning |
| Cached source load in that session | Zero additional requests |
| TIA transport | Windows reported an established `Siemens.Automation.Portal` TCP/102 connection before and after the full qualification |
| Cleanup | Only TIA's established PLC socket remained after test cleanup |
| Process writes, CPU-mode changes and role switches | None sent |

An established TIA socket is transport evidence, not an operator-observed proof
that every TIA diagnostic workflow remained responsive. No high-frequency load,
long-running endurance, other firmware or legacy-security coexistence claim is
made. In particular, a fresh TIA connection while library monitoring is already
active still requires an operator-observed test on the target CPU.

### Troubleshooting and Session Lifetime

1. If CreateSession reports Multi-ES, inspect `failure.phase`, `failure.details`,
   the transport identity and session-role report. Verify the loaded library
   source actually omits attribute 299; changing only the TSAP is not this fix.
   Do not automatically retry with role 1, increase connection limits, or ask
   engineers to release TIA as the normal workaround.
2. Deploy the corrected native library revision. A consumer-only update cannot
   change the payload of an older installed library. Restart long-running Node
   consumers after deployment so their module cache does not retain the old
   encoder. No release-version guarantee is implied by these source changes.
3. Keep discovery bounded and reuse metadata within its owning client session.
   Native member descriptors cannot be reused by a new client after disconnect;
   consumers retaining display catalogues must obtain fresh session-owned
   descriptors before reading. Persistent cross-session caching is not provided
   by this library fix.
4. Always `await client.disconnect()` in cleanup, including failed attempts.
   Stopping an application's polling timer does not disconnect the client. A
   successful discovery does not automatically close its session. Set explicit
   request/session budgets for the workload and release idle connections rather
   than relying on the HMI name or the observed role number to reserve engineer
   access.
5. Inspect `report.teardownWarning` separately from `connected`. Some successful
   probes received `ECONNRESET` after closure. `disconnect()` closes the owned
   transport and aborts queued work; it does not obtain a protocol-level session
   deletion receipt or prove immediate PLC resource reclamation. Retain the
   warning and verify target behavior rather than claiming clean deletion.

Regression coverage in `test/unit/s7commplus.test.js` asserts that CreateSession
does not contain attribute 299, retains ClientRID, matches the intentionally
adjusted golden frame, and reports unavailable returned-role evidence as null.
The original independent reference fixture is retained with its role-1 field;
only normalization to this client's payload removes it. Loopback tests protect
the wire policy but cannot establish hardware coexistence.

From the library root, run the focused offline regression with:

```sh
node node_modules/vitest/vitest.mjs run test/unit/s7commplus.test.js -t "session role policy"
npm run check-types
```

These commands do not connect to a PLC. Repeat authorized live qualification
separately for a new controller, firmware, security profile or connection order.

## Configured-Controller Compatibility Update

The additional authorized 17-target investigation established genuine process
reads on all twelve responding S7-1200 CPUs. Nine used explicit legacy SessionKey
sessions (firmware V4.4/V4.5); three used TLS with explicit certificate bypass
(V4.5/V4.7). Five targets did not answer TCP/102 within the bounded attempt.
Inventories ranged from 17 to 314 DBs. Exact addresses, JSON transcripts and
Markdown per-DB tables remain under ignored experimentation storage.

The legacy data path is TCP/COTP, recognized InitSSL incompatibility reply,
CreateObject, exact advertised public-key lookup and 20-byte challenge, fresh
encrypted SessionKey setup at owned-session address 1830, fixed activation at
owned-session address 323, then V3 HMAC-authenticated requests and fragments.
The only new SetVariable envelope is that fixed session activation; it is not
a process write or CPU operating-mode command. Negative statuses, malformed
responses, unknown keys, bad HMACs/counters and version downgrades stop acquisition.
Only three exact empty session-notification forms are recognized, with a limit
of sixteen per session; error-bearing SystemEvents remain fatal.

Compatibility fixes include signed-low-word composite service-result decoding,
separate activation/read counter layouts, generic V2 protection-read payloads,
V2 qualifiers inside legacy data reads, authenticated legacy fragment continuation
and latency comparison between equivalent operations rather than unrelated setup
and inventory responses. The four-second absolute response-latency limit remains.
Experiments explicitly enlarged object/member/request budgets, sampled at most
three DBs, and continued past only a local member-expansion limit in a still-live
session. This is not exhaustive DB/value coverage or a machine-impact guarantee.

Node crypto supplies AES, SHA-256, HMAC and secure randomness. The pinned
`@noble/hashes` SHA-256 implementation supplies the finalized-state continuation
required by older firmware; independent OpenSSL vectors cover fragment integrity.
The complete 180-byte encrypted blob and 24-byte derived key match the independent
HarpoS7 known-answer vector. Legacy traffic is not encrypted, a shared family
key is not independent target identity verification, and the compatibility code
has not undergone an independent security audit or constant-time review.
Username/password legitimation and other legacy key families remain unsupported.

The sections below retain their historically scoped outcomes and limitations.

## CPU-Start Update (2026-10-27)

The explicitly authorized isolated Test_v1 lab CPU 1212C (6ES7 212-1AE40-0XB0,
firmware V4.5) transitioned from STOP to RUN through the new `cpuStart()` API.
The session freshly observed STOP, sent exactly one SetVariable request to
CPU object 52 / OperatingStateREQ attribute 2167 with DINT(3), validated its
response sequence and separate write-integrity counter, and observed RUN twice
before disconnecting. Nine Plus requests used 2,529 received bytes and 1,198
sent bytes in approximately 2.54 seconds. No STOP, reset, download, force or
process-value write was sent.

The communication certificate file was unavailable. The lab session explicitly
used certificate bypass and the separate per-call unverified-identity opt-in;
before the start command, its peer certificate fingerprint was compared with
the previously verified lab session record and matched. This is historical-pin
continuity evidence, not fresh CA/hostname validation: the session correctly
remained `TLS_UNVERIFIED`. Exact target, fingerprint, request/response transcript
and result remain in ignored experimentation storage, not published fixtures.

CPU start requires an exact per-call host:port confirmation, TLS V2, effective
full access and a bounded state-verification budget. Default codec calls still
deny mode control, and the authorized encoder accepts no arbitrary address or
value. STOP and generic writes remain denied. No automatic retry or restart
workflow is provided. An acknowledged start that never reports RUN fails rather
than claiming success; communication failures leave the outcome potentially
unknown. Hardware qualification is limited to this one lab CPU and profile.

The full suite passed 465 tests across 27 files before the live attempt. The
subsequent transition-isolation and explicit lab-opt-in checks passed all 13
focused cases, and package type checking passed. Historical statements below
that no mode-control request was transmitted refer to the earlier investigations.

**Earlier read-only outcome: verified lab TLS sessions, native symbolic reads, genuine
FC/OB code-content extraction and DB definition extraction succeeded. Two
software captures produced unchanged component hashes. Full-controller and
restorable backups remain unsupported; no CPU mode changes were transmitted.**

Sections B-G retain historical investigation evidence; section H records the
subsequent native-symbol milestone. Section I supersedes earlier program-upload
limits; historical statements remain scoped to their original investigation.

Storage API update: uploads now return in-memory `files` arrays. Historical
filesystem snapshot/evidence helpers below are test-only, not library exports.
Consumers own persistence and backup policy; see the current README.

Configured-target update (2026-10-27): an additional CPU 1214C V4.5 session
established TLS 1.3 / TLS_AES_256_GCM_SHA384 with explicit certificate bypass.
The CPU reported RUN and effective protection 1. Discovery returned 156 objects,
including 96 DBs; decoding the selected DB yielded five members and one BOOL
read returned false with GOOD quality. The session used 10 requests, 14,404
received bytes, 1,259 sent bytes and 8,149 ms, then disconnected. Identity was
TLS_UNVERIFIED, not authenticated. No process writes or mode changes were sent;
machine impact was not independently verified. Exact target and raw evidence
remain in gitignored experimentation storage, not published fixtures.

Explicit hostnames, IP addresses and ports no longer require a lab allowlist.
The configured production target remains the optional default, not a Plus TLS
ban. Strict certificate verification remains the default; certificate bypass is
an explicit library/CLI opt-in. Larger discovery counts require an explicit
budget. Historical target/security restrictions below describe earlier stages,
not the current configured-target API.

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
  session traffic, 32 objects, 5 s request timeout, 10 s TLS handshake timeout,
  60 s session ceiling. Explicit object budgets up to 4096 are accepted without
  disabling byte/depth/session limits; 256 handled the measured 156-object reply.
  Latency above 4 s or a substantial baseline-relative increase stops work.
  No reconnect, retry, scheduler, active subscription or recurring backup.
- Explicit configured PLC IP addresses, hostnames and ports are accepted by the
  Plus client. No automatic security-profile negotiation or fallback is added.
  The production IP is still rejected by the classic connection backend before socket
  creation; classic read/write support for other endpoints is not removed.
- TLS-over-COTP is independently offline-tested, with normal CA/hostname checks
  and a mandatory independently approved SHA-256 certificate pin checked before
  CreateObject. Explicit certificate bypass retains encryption and records the
  observed fingerprint but reports TLS_UNVERIFIED and cannot enable program extraction.
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

## I. Native Program-Content Milestone (2026-10-26)

Genuine read-only program-content extraction succeeded through the existing
verified TLS V2 session. The qualified operation is native Explore of the
inventoried block RID, not the reference's experimental `upload_block()` payload.
Public attribute-name evidence identified Code block (2580), Body Description
(2533), Interface Description (2544), Line Comments (2546), and external/internal
reference data (2582/2583). Block Language is 2523, not 2522; actual BOOL responses
at 2522 exposed the pinned reference's incorrect language label.

The bounded native inventory identified two DBs, one FC and one OB. FBs, UDTs and
tag tables were not observed; this does not prove their absence on other CPUs.
Original code BLOBs and keyed sparse-BLOB bodies/interfaces/comments/reference
data were retrieved without interpreting or stripping their internal headers.

| Native artifact | Primary payload bytes | All retrieved component payload bytes |
| --- | ---: | ---: |
| First DB interface, definition only | 940 | 1083 |
| Second DB interface, definition only | 194 | 210 |
| FC code content | 282 | 2235 |
| OB code content | 286 | 2620 |
| Total | 1702 | 6148 |

Both FC and OB code payloads were nonempty. The FC's first two public-API reads
returned identical SHA-256 hashes. Subsequent complete captures of the four
observed objects also returned unchanged component hashes. The final pair used
one 19-request session lasting approximately 6.5 seconds. Genuine CPU state was
RUN before and after each
capture. No process writes, downloads, mode controls, credential guesses,
production connections or automatic retries were issued.

Each snapshot stores immutable original component payloads, typed-attribute
headers and response bodies in content-addressed objects. Each final manifest
referenced 37 distinct objects. Independent on-disk verification passed for both:
all four block responses were redecoded, matched to their inventory/request
identities, checked for sequence/integrity consistency and compared with saved
component hashes and declared lengths. Protocol end markers and fragment order
are checked at acquisition; counts describe Plus frames, not TCP/TLS records.
Manifest verification does not authenticate arbitrary caller-provided data as
real hardware. Actual captures and controller identifiers remain private.

The exported APIs are `listProgramBlocks()`, `uploadProgramBlock()` and
`uploadProgram({ mode: 'run' })`, plus `saveSoftwareSnapshot()`,
`verifySoftwareSnapshot()`, `diffSoftwareSnapshots()` and
`getS7CommPlusOperationPolicy()`. Extraction is restricted to the qualified
verified-TLS/access-level/native-protection profile. Unknown/protected objects,
empty content, missing components, budget exhaustion and partial failures are
explicit. Incremental storage deduplicates bytes after reading; unqualified
version/CRC metadata never suppresses a read.

The result is `BLOCK_CONTENT` / `SOFTWARE_UPLOAD`, **not a full-controller,
complete load-memory, editable engineering-archive or independently restorable
backup**. DB interfaces are not mislabeled as executable code. Dependencies are
retained as opaque native reference artifacts, not falsely decoded relationships.
Controller-state completeness, initial/retentive data, hardware configuration,
memory-card content, atomic revision consistency and restoration remain
unqualified. Siemens' official
[backup comparison](https://docs.tia.siemens.cloud/r/en-us/v20/creating-a-backup-of-an-s7-cpu/backup-options-for-s7-cpus)
distinguishes RUN-capable uploads from STOP-only consistent online-device backups;
it does not establish the corresponding native protocol for this library.

STOP/START remain denied before serialization and immediately before
transmission. No mode-control encoder, automatic restart, authorization issuer
or qualified interactive STOP workflow was added. A STOP-required selection
returns `EXPLICIT_CPU_STOP_CONFIRMATION_REQUIRED`; saved, automated, forced and
target-mismatched acknowledgements cannot enable control. Further offline
command qualification and a separately approved operator/equipment procedure
are prerequisites, not authorization conferred by this milestone.

Final validation: 392 tests passed in 26 files; standalone typecheck passed.
All six pinned-reference interoperability scenarios were rerun successfully,
including the deliberate rejection of an invalid reference-emulator object tree.
Coverage includes framing/fragment completion, sparse BLOB boundaries, identity
correlation, explicit empty/unsupported results, protected-block omission,
timeouts/cancellation, concurrency/request limits, malformed and corrupt
manifests, immutable deduplication, snapshot diffs and eleven fabricated
mode-authorization attempts. Package inspection found 57 files, all four new
native/store modules present, and no captures, certificates or test fixtures.