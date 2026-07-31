/**
 * L3 PROTOCOL TIER - the HTTP parser and connection behaviour BENEATH the request handler.
 *
 * STUB MODE + RAW SOCKET, EPHEMERAL PORT. The subject under test (`server.js`) is
 * reference-only and is never modified: its request handler is private, so it is reached
 * through the stub-mode harness, which replaces the server factory with a fake that records
 * `listen()`'s arguments and opens no socket at all. This file then mounts the captured
 * handler on a server of its own bound to port 0, so the repository's fixed port stays
 * genuinely free.
 *
 * WHY RAW BYTES. The two REJECTION cases - a malformed request line and an over-long header
 * field - are produced by the runtime's HTTP parser BEFORE the handler is ever invoked: the
 * handler has no conditionals and never inspects the request, so it cannot be the origin of a
 * rejection. Reaching those paths means writing bytes no compliant HTTP client will emit, so
 * they are written by hand through the raw-exchange helper. The remaining cases send WELL-FORMED
 * requests, which do reach the captured handler; raw bytes are used for them too because the
 * status lines and connection framing of a pipelined or concurrent exchange are only observable
 * on the wire.
 *
 * THE CRITICAL TRAP. The 400 and the 431 are NORMAL responses. They are asserted on their
 * exact response bytes and are never treated as thrown or failed operations - the helper
 * resolves with those bytes for precisely this reason.
 *
 * DETERMINISM. Nothing here waits on wall-clock time. Readiness is the `listen` callback; each
 * exchange terminates either because the peer closed the connection - the runtime does that
 * itself for a rejection, and `Connection: close` on the last pipelined request does it for a
 * success - or because a predicate over the received bytes has been satisfied. The helper's
 * guard bound is a safety net that fails loudly; it is never a synchronisation mechanism, so
 * it is left at its default.
 *
 * TEARDOWN. The CLIENT sockets belong entirely to the helper, which funnels every outcome
 * through one settle path that clears its guard, removes its listeners and destroys its socket.
 * What this file owns is the ephemeral LISTENER it creates below, plus the connections that
 * listener accepts: both are released unconditionally after every case, lingering connections
 * first. It adds no timer of its own and leaves no exchange unawaited, so no handle outlives the
 * test that created it and the runner exits on its own.
 *
 * Requirements covered: ST-6 (parser limits), ST-7 (no throttling), F-003-RQ-004 (framing
 * headers delegated to the runtime), F-003-RQ-005 (HEAD carries its headers and a zero-byte
 * body).
 *
 * WHY HEAD IS ASSERTED HERE AS WELL AS AT THE CLIENT LEVEL. The handler never inspects
 * `req.method`, so it answers a HEAD exactly as it answers anything else - it sets the status and
 * the Content-Type - and the runtime then suppresses the body and, with it, the framing header.
 * That suppression is the half of F-003-RQ-005 that matters most, and it is invisible to a
 * compliant client: an HTTP client discards a body on a HEAD response by specification, so it
 * would report an empty body even if the server had wrongly written 14 bytes onto the wire. Only
 * a raw byte exchange can distinguish "no body was sent" from "a body was sent and hidden",
 * which places the proof in this tier by definition. The sibling contract tier keeps its
 * client-level HEAD case as supplementary coverage of what a consumer observes.
 *
 * @see server.js - the behavioural contract; reference-only, never modified.
 * @see test/fixtures/expected.js - the frozen source of every expected literal.
 */

const http = require('http');
const { captureHandlerReady } = require('../helpers/captureHandler');
const { rawExchange } = require('../helpers/rawExchange');
const expected = require('../fixtures/expected');

/**
 * Matcher for a success status line, declared once and always consumed as
 * `(text.match(STATUS_LINE) || []).length` so a count is compared exactly rather than merely
 * probed for presence. `String.prototype.match` with a global pattern collects every match and
 * leaves no cursor behind, so one shared instance is safe across cases.
 *
 * @type {RegExp}
 */
const STATUS_LINE = /HTTP\/1\.1 200 OK/g;

/**
 * A request line the parser cannot accept: four bare tokens, not the method, target and
 * HTTP-version triple a request line has to be. This is a test INPUT rather than an expected
 * value of the subject, which is why it lives here and not in the frozen fixture module.
 *
 * @type {string}
 */
const MALFORMED_REQUEST = 'THIS IS NOT HTTP\r\n\r\n';

/**
 * Length of the single over-long header value, in characters. Comfortably beyond the runtime's
 * default limit on the total size of a request's header block, so the rejection is
 * deterministic rather than borderline. Also a test input, not an expected value.
 *
 * @type {number}
 */
const OVERSIZED_HEADER_CHARS = 20000;

/**
 * How many exchanges the concurrency case runs at once. A correctness bound - every one of
 * them must be served - and deliberately not a throughput target: no timing is asserted
 * anywhere in this file.
 *
 * @type {number}
 */
const CONCURRENCY = 25;

/**
 * The blank line that ends a response's header block. Protocol syntax rather than an expected
 * value of the subject, so it lives here and not in the frozen fixture. Everything after this
 * sequence is body bytes - which is exactly what a HEAD response must not have.
 *
 * @type {string}
 */
const HEADER_TERMINATOR = '\r\n\r\n';

/**
 * Separator between a header field's name and its value on the wire.
 *
 * @type {string}
 */
const HEADER_SEPARATOR = ': ';

/**
 * The single header key the runtime omits from a HEAD response, dropping it along with the
 * body. Named once so the derivation below reads as the relationship it is, rather than as an
 * unexplained exclusion.
 *
 * @type {string}
 */
const FRAMING_HEADER = 'content-length';

/**
 * The persistent-connection disposition a client asks for and the runtime echoes back in the
 * response's `connection` field. Declared once so the request and the assertion about it cannot
 * drift apart, and so the response's value is checked against what was actually requested rather
 * than against a second hand-written copy of it.
 *
 * @type {string}
 */
const KEEP_ALIVE_DISPOSITION = 'keep-alive';

/**
 * The complete applicable header key set for a keep-alive HEAD response: the frozen five-key GET
 * set minus the framing header the runtime drops with the body. DERIVED rather than restated, so
 * a change to either half - the GET contract or the runtime's HEAD behaviour - fails this file
 * instead of quietly disagreeing with the fixture. `filter()` returns a copy, so the frozen
 * fixture array is never mutated.
 *
 * @type {string[]}
 */
const HEAD_HEADER_KEYS = expected.HEADER_KEYS.filter((key) => key !== FRAMING_HEADER);

/**
 * Build a well-formed request carrying an explicit connection disposition.
 *
 * Centralised so the request template exists once: `'close'` makes the runtime end the
 * connection after responding, which is what lets an exchange settle on the socket's own close
 * event, while `'keep-alive'` holds it open and requires a byte-pattern predicate instead.
 *
 * @param {string} connection Value for the `Connection` header, verbatim.
 * @returns {string} The complete request text, terminated by a blank line.
 */
function requestWith(connection) {
  return 'GET / HTTP/1.1\r\nHost: ' + expected.HOST + '\r\nConnection: ' + connection + '\r\n\r\n';
}

/**
 * The same request template with the HEAD method, which no part of the subject inspects: the
 * handler does exactly what it does for a GET, so the differences a HEAD response shows RELATIVE
 * TO a GET - no body, and no framing header - are produced entirely by the runtime.
 *
 * @param {string} connection Value for the `Connection` header, verbatim.
 * @returns {string} The complete request text, terminated by a blank line.
 */
function headRequestWith(connection) {
  return 'HEAD / HTTP/1.1\r\nHost: ' + expected.HOST + '\r\nConnection: ' + connection + '\r\n\r\n';
}

/**
 * The first response's header block, taken from raw bytes: everything before the first blank
 * line, terminator excluded. Pure string arithmetic - this opens no socket, starts no timer and
 * keeps no state, so it cannot leak a handle.
 *
 * @param {string} raw Bytes exactly as received from the peer.
 * @returns {string} The status line and header lines, CRLF-separated.
 */
function headerBlockOf(raw) {
  return raw.slice(0, raw.indexOf(HEADER_TERMINATOR));
}

/**
 * Parse a header block into a lowercase-keyed object of field values, discarding the status
 * line. Lowercased because HTTP field names are case-insensitive and the frozen fixture records
 * them in lower case.
 *
 * @param {string} block A header block as returned by `headerBlockOf`.
 * @returns {Object<string, string>} Field values keyed by lowercase field name.
 */
function headerFieldsOf(block) {
  const fields = {};
  block.split('\r\n').slice(1).forEach((line) => {
    const boundary = line.indexOf(HEADER_SEPARATOR);
    fields[line.slice(0, boundary).toLowerCase()] = line.slice(boundary + HEADER_SEPARATOR.length);
  });
  return fields;
}

/**
 * The server this file owns, mounted on the captured handler. Assigned only in `beforeEach`
 * and released in `afterEach`, so no case depends on another and each one is runnable alone.
 *
 * @type {?import('http').Server}
 */
let server = null;

/**
 * The ephemeral port the runtime allocated for `server`, handed to every exchange.
 *
 * @type {number}
 */
let port = 0;

beforeEach(async () => {
  // The async variant flushes the fake `listen`'s deferred callback while the logging spy is
  // still installed, so the subject's readiness banner is captured rather than escaping into
  // the runner's report.
  const captured = await captureHandlerReady();
  // Order is load-bearing: the factory is still stubbed at this point, so restoring it MUST
  // precede building a real server - otherwise the fake comes back, with no socket, no
  // `listen` and no address.
  captured.restore();
  server = http.createServer(captured.handler);
  await new Promise((resolve) => {
    // Port 0 - the runtime allocates a free port. The repository's fixed port is never bound
    // by this tier.
    server.listen(0, expected.HOST, resolve);
  });
  port = server.address().port;
});

afterEach(async () => {
  // Unconditional: this runs after a failed assertion exactly as after a passing one.
  if (server) {
    if (server.listening) {
      // ORDER IS LOAD-BEARING: request the close FIRST, then drop the connections that are still
      // open. A keep-alive connection - or a raw socket one of the cases below left behind - would
      // otherwise be held open by the runtime for its idle timeout and defer the close, which is
      // why `closeAllConnections()` is needed. Force-closing before the close is requested leaves
      // a window in which the listener is still accepting, so a connection can arrive between the
      // two calls and keep the server alive; Node's guidance is to force-close only afterwards.
      const closed = new Promise((resolve) => {
        server.close(resolve);
      });
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await closed;
    }
    server = null;
    port = 0;
  }
});

// A NORMAL response from the parser beneath the handler: asserted on its bytes, in full.
test('answers a malformed request line with the exact 400 response bytes (ST-6)', async () => {
  const received = await rawExchange({ port: port, payload: MALFORMED_REQUEST });
  expect(received).toBe(expected.MALFORMED_RESPONSE);
});

// Likewise a NORMAL response: the runtime answers, then closes the connection itself.
test('answers an oversized header with the exact 431 response bytes (ST-6)', async () => {
  const payload = 'GET / HTTP/1.1\r\nHost: ' + expected.HOST + '\r\nX-Big: ' +
    'a'.repeat(OVERSIZED_HEADER_CHARS) + '\r\n\r\n';
  const received = await rawExchange({ port: port, payload: payload });
  expect(received).toBe(expected.OVERSIZED_RESPONSE);
});

// Both requests go out in a single write, and the second asks the runtime to close: the socket's
// own close event then settles the exchange. Without that terminal disposition the runtime would
// hold the connection until its keep-alive idle timeout, which outlasts the helper's guard bound,
// so the exchange would fail on the guard rather than settle.
test('answers two pipelined keep-alive requests with exactly two status lines (F-003-RQ-004)', async () => {
  const payload = requestWith('keep-alive') + requestWith('close');
  const received = await rawExchange({ port: port, payload: payload });
  expect((received.match(STATUS_LINE) || []).length).toBe(2);
});

// A correctness assertion, not a benchmark: every exchange must be served, and none may be
// throttled, queued away or answered differently.
test('serves twenty-five concurrent requests without throttling (ST-7)', async () => {
  const payload = requestWith('close');
  const received = await Promise.all(
    Array.from({ length: CONCURRENCY }, () => rawExchange({ port: port, payload: payload }))
  );
  const statuses = received.map((text) => (text.match(STATUS_LINE) || []).length);
  expect(statuses).toEqual(Array.from({ length: CONCURRENCY }, () => 1));
  const bodies = new Set(received.map((text) => text.slice(-expected.BODY_BYTES)));
  expect(bodies.size).toBe(1);
  expect(bodies.has(expected.BODY)).toBe(true);
});

// The helper's second termination route. Both requests stay keep-alive, so the runtime holds the
// connection open and no close event arrives within the guard bound; the `until` predicate settles
// the exchange on a pattern in the bytes already received instead. Matching received bytes is an
// event-driven condition, evaluated as each chunk arrives - there is no wall-clock wait here
// either.
test('settles a keep-alive exchange on a byte-pattern predicate without a wall-clock wait (ST-7)', async () => {
  const payload = requestWith('keep-alive') + requestWith('keep-alive');
  const received = await rawExchange({
    port: port,
    payload: payload,
    until: (accumulated) => (accumulated.match(STATUS_LINE) || []).length >= 2
  });
  expect((received.match(STATUS_LINE) || []).length).toBe(2);
});

// HEAD, asserted on the bytes. The handler never reads `req.method`, so it runs for a HEAD as it
// runs for any method: the status line and the Content-Type below are its doing. What the runtime
// contributes - and what these three cases are really about - is the suppression of the body and,
// with it, of the framing header. The trailing close-terminated GET in the first two cases does
// double duty - it settles the exchange on the peer's FIN, and it demonstrates that the very same
// socket delivers a body when one is due, so the HEAD response's silence is deliberate
// suppression rather than a connection that could not carry one.
test('answers HEAD with exactly the applicable header keys and values on the wire (F-003-RQ-005)', async () => {
  const payload = headRequestWith(KEEP_ALIVE_DISPOSITION) + requestWith('close');
  const received = await rawExchange({ port: port, payload: payload });
  const fields = headerFieldsOf(headerBlockOf(received));
  // Asserted as a SET, so an added or missing header field fails this test. Both sides are
  // copied before sorting: the fixture's array is frozen and the derived set is shared.
  expect(Object.keys(fields).sort()).toEqual(HEAD_HEADER_KEYS.slice().sort());
  expect(fields['content-type']).toBe(expected.CONTENT_TYPE);
  // The runtime echoes the disposition this exchange asked for, which is what brings the
  // persistence field below into existence at all.
  expect(fields.connection).toBe(KEEP_ALIVE_DISPOSITION);
  expect(fields['keep-alive']).toBe(expected.KEEP_ALIVE);
  // Dropped along with the body: absence here is a positive statement about HEAD framing, not an
  // untested gap.
  expect(fields[FRAMING_HEADER]).toBeUndefined();
});

test('emits no body bytes between a HEAD response and the next pipelined response (F-003-RQ-005)', async () => {
  const payload = headRequestWith(KEEP_ALIVE_DISPOSITION) + requestWith('close');
  const received = await rawExchange({ port: port, payload: payload });
  const afterHeadTerminator = received.slice(
    received.indexOf(HEADER_TERMINATOR) + HEADER_TERMINATOR.length
  );
  // The next response's status line begins at offset ZERO of whatever follows the HEAD
  // response's header terminator, so the HEAD response contributed not one body byte. A
  // compliant client could never show this: it discards a HEAD body by specification and would
  // report an empty body even if bytes had been written. `search` neither reads nor advances a
  // global pattern's cursor, so the shared matcher stays reusable across cases.
  expect(afterHeadTerminator.search(STATUS_LINE)).toBe(0);
  expect((received.match(STATUS_LINE) || []).length).toBe(2);
  // The GET that followed did carry the greeting, on that same connection.
  expect(received.slice(-expected.BODY_BYTES)).toBe(expected.BODY);
});

test('ends a close-terminated HEAD response at the header terminator (F-003-RQ-005)', async () => {
  const received = await rawExchange({
    port: port,
    payload: headRequestWith('close')
  });
  // The runtime closes the connection itself, so this exchange settles on the peer's FIN and the
  // string in hand is EVERYTHING the server ever wrote - the strongest zero-body proof available,
  // and one that holds even at end of stream.
  const afterTerminator = received.slice(
    received.indexOf(HEADER_TERMINATOR) + HEADER_TERMINATOR.length
  );
  expect(afterTerminator).toBe('');
  expect((received.match(STATUS_LINE) || []).length).toBe(1);
  expect(headerFieldsOf(headerBlockOf(received))[FRAMING_HEADER]).toBeUndefined();
});
