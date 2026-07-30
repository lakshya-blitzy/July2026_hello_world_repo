// Frozen expected-value module: the single source of every expected literal in the
// suite. It is read by all five test files, so no literal is duplicated in a test.
// All values derive from the subject `server.js`, which is REFERENCE ONLY and is
// never modified. Inert data only - no logic, no imports, no computation; executable
// machinery belongs in test/helpers/ instead.
// Every value below was measured against the real runtime rather than assumed, and
// records observed behaviour, not idealised behaviour. Do not "improve" any of them.
// The object and both arrays are deep-frozen so no test can mutate a shared
// expectation and silently weaken another.

module.exports = Object.freeze({
  // --- Response contract - server.js lines 7-9 ---
  STATUS: 200,                  // line 7 - the only status the application ever emits
  CONTENT_TYPE: 'text/plain',   // line 8 - measured with NO charset parameter; leave it so
  BODY: 'Hello, World!\n',      // line 9 - a real trailing LF
  BODY_BYTES: 14,               // line 9, measured - a number, for byte-count assertions
  BODY_SHA256: 'c98c24b677eff44860afea6f493bbaec5bb1c4cbb209c6fc2bbb47f66ff2ad31', // line 9, measured

  // --- Headers the runtime generates beneath the handler (all measured on the wire) ---
  // The complete key set for a GET, asserted as a SET so that an added header fails the
  // test. It materialises only on a keep-alive connection: a client sending
  // `Connection: close` (the default for supertest, and for a pooling-disabled core
  // client) sees four keys and no keep-alive header at all. Asking for keep-alive is the
  // consumer's responsibility - these five entries are correct, not a defect.
  // A HEAD response also carries four keys, measured as connection, content-type, date
  // and keep-alive: the runtime omits content-length along with the body, so a HEAD case
  // asserts a zero-byte body rather than reusing this set.
  HEADER_KEYS: Object.freeze([
    'connection',
    'content-length',
    'content-type',
    'date',
    'keep-alive'
  ]),
  CONTENT_LENGTH: '14',         // a STRING - header values arrive as text; BODY_BYTES is the number
  KEEP_ALIVE: 'timeout=5',      // runtime default, measured
  // Absent from every response - no version disclosure. Consumers assert these are undefined.
  FORBIDDEN_HEADERS: Object.freeze(['server', 'x-powered-by']),

  // --- Bind target - server.js lines 3-4 (hard-coded constants, no override path) ---
  HOST: '127.0.0.1',            // line 3 - loopback, deliberately not 0.0.0.0
  PORT: 3000,                   // line 4 - a number, exactly as the subject passes it

  // --- Readiness banner - server.js line 13 ---
  // READY_LINE is 40 characters and carries NO trailing newline. The logger appends one,
  // so the line emitted on stdout is 41 bytes. Keep READY_BYTES at 41: a consumer
  // checking the byte count must add the newline itself, or assert against captured
  // stdout that already includes it.
  READY_LINE: 'Server running at http://127.0.0.1:3000/',
  READY_BYTES: 41,

  // --- Parser-generated responses, byte-exact (47 bytes and 67 bytes) ---
  // The HTTP parser produces these BENEATH the handler, and they are NORMAL responses:
  // assert on these exact bytes, and never treat them as thrown or rejected operations.
  MALFORMED_RESPONSE: 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n',
  OVERSIZED_RESPONSE: 'HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n'
});
