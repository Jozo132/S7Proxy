# Third-Party Notices

## S7CommPlus Protocol Reference

The new Node.js codec and client were developed with reference to the MIT-licensed
Python project https://github.com/gijzelaerr/s7commplus at commit
`245350ea0ca6327234e5032e781a99782334bc8f`.
Inspected files: `protocol.py`, `vlq.py`, `codec.py`, `transport.py`,
`connection.py`, `client.py`, and `server.py`.

Protocol constants, framing, variable-length integer layouts, session object
shapes, session-version echo and request layouts informed the implementation in
`src/protocol/s7commplus/codec.js` and `src/client/s7commplus-client.js`.
The reference emulator informed loopback tests. It is not evidence of real PLC
compatibility. No Python package or reference emulator is a runtime dependency.
The reference's experimental upload routine was not implemented or transmitted.
No source from the separately licensed thomas-v2/S7CommPlusDriver was incorporated.

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