// Frozen expected-value fixture: the single source of every expected literal the
// suite asserts against, so no literal is duplicated inside a test. All values
// derive from `server.js`, which is reference-only and never modified, or were
// measured on the wire against the real runtime. Inert data only - no logic, no
// imports, no computation; executable machinery belongs in test/helpers/. The
// object and both arrays are deep-frozen so no test can mutate a shared
// expectation and silently weaken another.

module.exports = Object.freeze({
  STATUS: 200,
  CONTENT_TYPE: 'text/plain',
  BODY: 'Hello, World!\n',
  BODY_BYTES: 14,
  BODY_SHA256: 'c98c24b677eff44860afea6f493bbaec5bb1c4cbb209c6fc2bbb47f66ff2ad31',

  // The complete response header key set for a GET, to be asserted as a SET so
  // that an added header fails the test. These five keys materialise only on a
  // keep-alive connection: a client sending `Connection: close` sees four keys
  // and no keep-alive header at all, so asking for keep-alive is the consumer's
  // responsibility. A HEAD response also carries four keys - the runtime omits
  // content-length along with the body - so a HEAD case asserts a zero-byte
  // body instead of reusing this set.
  HEADER_KEYS: Object.freeze([
    'connection',
    'content-length',
    'content-type',
    'date',
    'keep-alive'
  ]),
  // Header values arrive as text, so this is the string form of BODY_BYTES.
  CONTENT_LENGTH: '14',
  KEEP_ALIVE: 'timeout=5',
  // Absent from every response: the runtime discloses no version headers.
  FORBIDDEN_HEADERS: Object.freeze(['server', 'x-powered-by']),

  HOST: '127.0.0.1',
  PORT: 3000,

  // READY_LINE carries no trailing newline; the logger appends one, so the line
  // emitted on stdout is READY_BYTES long. A consumer counting bytes must add
  // that newline itself, or assert against captured stdout that already has it.
  READY_LINE: 'Server running at http://127.0.0.1:3000/',
  READY_BYTES: 41,

  // The HTTP parser produces these beneath the handler, and they are NORMAL
  // responses: assert on these exact bytes, never as thrown or rejected
  // operations.
  MALFORMED_RESPONSE: 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n',
  OVERSIZED_RESPONSE: 'HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n'
});
