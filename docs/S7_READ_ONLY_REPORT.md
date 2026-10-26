# S7 Native Read-Only Acquisition Report

**Outcome: bounded native foundation implemented; live session creation rejected.
No online inventory, symbolic values or program-block backup was acquired.**

## A. Implemented Backend and Data Flow

- Separate native Node.js `S7CommPlusClient`, not OPC UA, classic S7Comm,
  a Python bridge, or an engineering-file parser.
- TCP -> strict bounded TPKT -> class-0 COTP -> Plus fragment assembler ->
  correlated response -> typed value/object decoder. Unknown shapes stop acquisition.
- Real COTP negotiation, InitSSL, CreateObject and an exact owned-session
  ServerSessionVersion echo are implemented. The echo is the only permitted
  SetMultiVariables envelope, not a generic write interface.
- CPU-state Explore, effective-protection read, bounded explicit object Explore,
  and a one-item LID-addressed typed symbolic read are implemented and loopback-tested.
  LID paths must already be known: automatic symbol-name resolution, datatype
  catalog construction, object relationships and complete recursive inventories
  are not implemented. Raw typed bytes and datatype IDs are retained; 64-bit
  values are not converted to imprecise JavaScript numbers. Receive times are
  local observations, not fabricated PLC-native timestamps.
- Canonical operation allowlist before serialization and byte equality check
  immediately before transmission. No public arbitrary Plus send method.
- One outstanding request; at least 250 ms between request starts; defaults:
  12 requests, 900-byte application request, 64 KiB response, 256 KiB aggregate
  session traffic, 32 objects, 5 s request timeout, 60 s session ceiling.
  Latency above 4 s or a substantial baseline-relative increase stops work.
  No reconnect, retry, scheduler, active subscription or recurring backup.
- Only this production IP or explicit loopback fixtures are accepted. The
  production IP is rejected by the classic connection backend before socket
  creation; classic read/write support for other endpoints is not removed.
- A tunneled verified-TLS transport exists as experimental code, but has not
  been integration-qualified. It is refused for the production target before
  transmission. SessionKey, credential authentication, V3/HMAC and alternative
  security profiles are unsupported. No key probes or plaintext fallbacks.
- Compatibility methods that previously fabricated metadata, upload results or
  control-operation success now return `0x00F00000`, with no PLC operation.
- WASM and AssemblyScript are unchanged: no measured benefit justified moving
  this small bounded metadata path into WASM. Existing DAQ/proxy/API traffic is
  not automatically routed through the experimental client.

## B. Live Evidence and Statistics

Exactly one explicit attempt ran using `npm run explore:s7`.
UTC start `2026-10-26T15:02:48.480Z`; finish `2026-10-26T15:02:48.976Z`.
No subsequent live attempts were made.

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
- Focused codec/client/safety/evidence checks: **62 passed**. Covers typed values,
  UInt32/64 limits, fragments, bounds, canonical tampering, forbidden functions,
  full loopback handshake/read, CPU STOP, authentication challenge, correlation,
  timeout, no retry, session cleanup, target singleton, budgets, explicit item
  errors, unknown suffixes, protection marker and content-store corruption.
- Full suite via `npx vitest run --configLoader runner`: **182 tests passed in
  13 files; 9 integration suites failed during import**, before running tests.
  Installed `node-snap7/build/Release/node_snap7.node` reports "not a valid Win32
  application". Native-snap7/classic/WASM interoperability remains unverified in
  this environment. No claim that the full suite passed.
- Default Vitest config bundling also fails in the installed Vite/rolldown stack;
  `--configLoader runner` avoids that separate tooling failure. No dependencies
  or test-runner configuration were modified to conceal either limitation.
- Qualified real-controller functionality: COTP/InitSSL and fail-closed rejection
  handling only. Complete sessions and reads are verified against synthetic
  loopback fixtures, not Siemens firmware. TLS is not qualified.
- No commit, branch, push or deployment. Commit hash/message: not applicable.

## F. Evidence-Based Next Steps

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
6. Repair/rebuild the platform-matching native test dependency separately, then
   rerun the classic/WASM interoperability suites. Do not use production hardware
   to compensate for unavailable local tests.