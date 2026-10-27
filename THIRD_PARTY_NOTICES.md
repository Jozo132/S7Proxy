# Third-Party Notices

## S7CommPlus Protocol Reference

The new Node.js codec and client were developed with reference to the MIT-licensed
Python project https://github.com/gijzelaerr/s7commplus at commit
`245350ea0ca6327234e5032e781a99782334bc8f`.
Inspected files: `protocol.py`, `vlq.py`, `codec.py`, `transport.py`,
`connection.py`, `client.py`, `typeinfo.py`, and `server.py`.

Protocol constants, framing, variable-length integer layouts, session object
shapes, session-version echo and request layouts informed the implementation in
`src/protocol/s7commplus/codec.js` and `src/client/s7commplus-client.js`.
The reference emulator informed loopback tests. It is not evidence of real PLC
compatibility. No Python package or reference emulator is a runtime dependency.
The same pinned MIT reference also informed TLS-over-COTP options and certificate
pin verification. The independently encoded CreateObject golden in
`test/s7commplus-fixture.js` and differential runner retain its source/commit and
distinguish emulator encoding from real-device capture evidence.
The reference's experimental upload routine was not implemented or transmitted.
The type-member/name list framing, offset-info variants, nested type references,
array ordinals and distinction between browsed type CRCs and address CRCs also
informed the self-contained JavaScript metadata decoder. Public metadata tests
use independently constructed synthetic objects, not engineering archives or
controller captures. No Python runtime is required.
No source from the separately licensed thomas-v2/S7CommPlusDriver was incorporated.

The same pinned MIT reference's `v1_session_key` modules and `_fragment_hmac.py`
informed the JavaScript legacy SessionKey and authenticated-fragment compatibility
implementation. The complete S7-1200 blob/key known-answer vector and independent
OpenSSL fragment vectors are retained in the unit tests. Challenge-fingerprint
tables and S7-1200 public-key bytes originate in MIT-licensed HarpoS7
(https://github.com/bonk-dev/HarpoS7), as documented by that pinned reference.
The applicable HarpoS7 notice is: Copyright (c) 2024 bonk. Its MIT permission,
conditions and warranty disclaimer are the same as the MIT terms reproduced
below; the notice and those terms apply to these derived portions.

Legacy SHA-256 state continuation uses `@noble/hashes` version 1.8.0, Copyright
(c) 2022 Paul Miller (https://paulmillr.com), MIT licensed. Its notice and full
license are distributed with the dependency. AES, normal hashing, HMAC and secure
randomness use Node.js crypto. No Python runtime is required.

For native program-content extraction, public protocol facts were independently
cross-checked against the attribute-name table in
https://github.com/moki-ics/s7commwireshark/blob/master/src/s7comm_plus/packet-s7comm_plus.c
and sparse-BLOB field descriptions in
https://github.com/thomas-v2/S7CommPlusDriver/blob/master/src/S7CommPlusDriver/Core/PValue.cs.
In particular, attribute 2523 is Block Language (2522 is Auto Numbering), 2580
is Code block, and sparse BLOB values carry keyed root/length/data entries with
a zero-key terminator. Only protocol facts were used; no source from either
separately licensed project was copied. JavaScript implementations and public
fixtures are independently constructed. Real controller binaries and engineering
captures are not distributed.

The MIT License (MIT)

Copyright (c) 2013 Gijs Molenaar, Stephan Preeker

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.