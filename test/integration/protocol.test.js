/**
 * L3 PROTOCOL TIER - the HTTP parser and connection behaviour BENEATH the request handler.
 *
 * STUB MODE + RAW SOCKET, EPHEMERAL PORT. The subject under test (`server.js`) is
 * reference-only and is never modified: its request handler is private, so it is reached
 * through the stub-mode harness, which replaces the server factory with a fake that records
 * `listen()`'s arguments and opens no socket at all. This file then mounts the captured
 * handler on a server of its own bound to port 0, so the repository's fixed port stays
 * genuinely free - that port belongs to the bootstrap tier alone.
 *
 * WHY RAW BYTES. Every behaviour asserted here is produced by the runtime's HTTP parser
 * BEFORE the handler is ever invoked: the handler has no conditionals and never inspects the
 * request, so it cannot be the origin of a rejection. Reaching those paths requires writing an
 * invalid request line and an over-long header field, and no compliant HTTP client will emit
 * either, so the bytes are written by hand through the raw-exchange helper.
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
 * TEARDOWN. Socket ownership belongs entirely to the helper, which funnels every outcome
 * through one settle path that clears its guard, removes its listeners and destroys its
 * socket. This file therefore opens no socket of its own, adds no timer of its own, and leaves
 * no exchange unawaited; the server it does own is closed unconditionally after every case, so
 * no handle outlives the test that created it and the runner exits on its own.
 *
 * Requirements covered: ST-6 (parser limits), ST-7 (no throttling), F-003-RQ-004 (framing
 * headers delegated to the runtime).
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
 * A request line the parser cannot accept: three bare words where a method, a target and a
 * version belong. This is a test INPUT rather than an expected value of the subject, which is
 * why it lives here and not in the frozen fixture module.
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
  // Unconditional: this runs after a failed assertion exactly as after a passing one. A
  // keep-alive connection would otherwise be held open by the runtime for its idle timeout and
  // delay the close, so lingering connections are dropped first.
  if (server) {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    if (server.listening) {
      await new Promise((resolve) => {
        server.close(resolve);
      });
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

// Both requests go out in a single write. The second one asks the runtime to close, which is
// what makes the exchange settle in single-digit milliseconds instead of resting on the guard
// bound - a keep-alive socket left open would never close on its own.
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

// The helper's second termination route: both requests stay keep-alive, so the connection
// never closes and the exchange settles on a pattern in the bytes already received. Matching
// received bytes is an event-driven condition, evaluated as each chunk arrives - there is no
// wall-clock wait here either.
test('settles a keep-alive exchange on a byte-pattern predicate without a wall-clock wait (ST-7)', async () => {
  const payload = requestWith('keep-alive') + requestWith('keep-alive');
  const received = await rawExchange({
    port: port,
    payload: payload,
    until: (accumulated) => (accumulated.match(STATUS_LINE) || []).length >= 2
  });
  expect((received.match(STATUS_LINE) || []).length).toBe(2);
});
