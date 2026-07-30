'use strict';

/**
 * L2 CONTRACT TIER - the wire-level response contract of `server.js`, asserted over an
 * EPHEMERAL port: status, body text, byte count and digest, the COMPLETE response header key
 * set, and the invariance of all of them across arbitrary request shapes and hostile input.
 *
 * The subject exports nothing and binds its fixed address as an unconditional side effect of
 * `require()`, so its request handler is reachable only by intercepting `http.createServer`.
 * This file takes the STUB-MODE route: the harness captures the handler while no socket is
 * created at all, the stub is then uninstalled, and the captured handler is mounted on a real
 * server bound to port 0. The fixed port is therefore never bound here, and this tier passes
 * even while another process holds it.
 *
 * Two response properties are easy to get wrong, so both are stated where they are used rather
 * than assumed:
 *   1. The complete header key set is REQUEST-DRIVEN - see KEEP_ALIVE_REQUEST below for why the
 *      client has to ask for a persistent connection.
 *   2. A HEAD request still runs the handler, so the status and `Content-Type` of a HEAD
 *      response come from the subject; what the runtime contributes is suppressing the body and,
 *      with it, the framing header.
 *
 * The subject is reference-only: never modified, never required directly, and never repaired -
 * the absent `charset` parameter on `Content-Type` is asserted as the current, intended
 * behaviour rather than corrected. Every expected literal comes from the frozen fixture module
 * and none is duplicated here, so a change in the subject's behaviour produces one obvious
 * point of failure rather than a scattering of edits.
 */

const http = require('http');
const crypto = require('crypto');
const request = require('supertest');
const { captureHandlerReady } = require('../helpers/captureHandler');
const expected = require('../fixtures/expected');

/**
 * The persistent-connection disposition this file requests, which the runtime echoes back in the
 * response's `connection` field. Named once so a case can assert the response against what was
 * actually asked for rather than against a second hand-written copy of it.
 *
 * @type {string}
 */
const KEEP_ALIVE_DISPOSITION = 'keep-alive';

/**
 * `Connection: keep-alive` as the (field, value) pair `.set()` expects, spread at every call
 * site so the two halves cannot drift apart. Declared once because the complete five-key
 * response header set materialises only when the CLIENT asks for a persistent connection: a
 * request without this header is answered with four keys and no persistence header, which is
 * precisely why a naive request would fail the header-set assertion.
 *
 * @type {string[]}
 */
const KEEP_ALIVE_REQUEST = ['Connection', KEEP_ALIVE_DISPOSITION];

/**
 * The one header key the runtime omits from a HEAD response, dropping it along with the body.
 * Named so the derivation below reads as the relationship it is rather than as an unexplained
 * exclusion.
 *
 * @type {string}
 */
const FRAMING_HEADER = 'content-length';

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
 * A real `http.Server` wrapping the captured handler. Assigned only in `beforeEach` and released
 * only in `afterEach`, so every test gets a freshly bound ephemeral listener of its own.
 *
 * @type {?import('http').Server}
 */
let server = null;

beforeEach(async () => {
  // Stub mode reaches the subject's private handler without binding anything. The ASYNC
  // variant is mandatory rather than convenient: it flushes the fake `listen`'s deferred
  // callback while the console spy is still installed, so the readiness banner is captured by
  // the harness instead of escaping into the runner's report.
  const captured = await captureHandlerReady();
  // Restore before building the real server: until then `http.createServer` is still the fake.
  captured.restore();
  server = http.createServer(captured.handler);
  await new Promise((resolve) => {
    // Port 0: the runtime allocates an ephemeral port, so the subject's fixed port stays free.
    // Readiness is this callback - an event, never an elapsed duration.
    server.listen(0, expected.HOST, resolve);
  });
});

afterEach(async () => {
  // Unconditional: this runs even when an assertion fails, so no server and no socket outlives
  // the test that created it. A runner that will not exit is reporting a leak to be fixed here,
  // never one to be masked by forcibly terminating the run.
  if (server) {
    // Persistent connections opened by the cases below would otherwise keep `close()` pending
    // until the runtime's own idle timeout elapsed.
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    if (server.listening) {
      await new Promise((resolve) => {
        server.close(resolve);
      });
    }
    server = null;
  }
});

describe('response payload', () => {
  test('responds with status 200 to every request (F-003-RQ-001)', async () => {
    const res = await request(server).get('/');
    expect(res.status).toBe(expected.STATUS);
  });

  test('responds with the exact greeting body (F-003-RQ-003)', async () => {
    const res = await request(server).get('/');
    expect(res.text).toBe(expected.BODY);
  });

  test('responds with a body of exactly fourteen bytes (F-003-RQ-003)', async () => {
    const res = await request(server).get('/');
    // Byte length rather than character count: the two agree here only because the greeting is
    // ASCII, and it is the byte count the framing header has to match.
    expect(Buffer.byteLength(res.text)).toBe(expected.BODY_BYTES);
  });

  test('responds with a body whose digest matches the frozen value (F-003-RQ-003)', async () => {
    const res = await request(server).get('/');
    // One core-library call at the point of assertion; the fixture stores the digest as inert
    // data and never derives it, so the two cannot drift into agreement by construction.
    const digest = crypto.createHash('sha256').update(res.text).digest('hex');
    expect(digest).toBe(expected.BODY_SHA256);
  });
});

describe('response headers', () => {
  test('returns exactly the five expected header keys (F-003-RQ-004)', async () => {
    const res = await request(server).get('/').set(...KEEP_ALIVE_REQUEST);
    // Asserted as a SET, so an added header fails this test rather than slipping through.
    // `.slice()` first: the fixture array is frozen and `sort()` reorders in place.
    expect(Object.keys(res.headers).sort()).toEqual(expected.HEADER_KEYS.slice().sort());
  });

  test('returns Content-Type text/plain with no charset parameter (F-003-RQ-002)', async () => {
    const res = await request(server).get('/').set(...KEEP_ALIVE_REQUEST);
    // Exact equality, never containment: a charset parameter appearing here would be a change
    // in the subject's behaviour, and this tier reports behaviour rather than repairing it.
    expect(res.headers['content-type']).toBe(expected.CONTENT_TYPE);
  });

  test('returns a content-length of fourteen (F-003-RQ-004)', async () => {
    const res = await request(server).get('/').set(...KEEP_ALIVE_REQUEST);
    expect(res.headers['content-length']).toBe(expected.CONTENT_LENGTH);
  });

  test('returns a keep-alive timeout of five seconds (F-003-RQ-004)', async () => {
    const res = await request(server).get('/').set(...KEEP_ALIVE_REQUEST);
    expect(res.headers['keep-alive']).toBe(expected.KEEP_ALIVE);
  });

  test('discloses no server or x-powered-by header (ST-3)', async () => {
    const res = await request(server).get('/').set(...KEEP_ALIVE_REQUEST);
    // Absence is the assertion: neither the runtime nor the subject emits a version or
    // framework fingerprint, and that property would otherwise regress silently.
    expected.FORBIDDEN_HEADERS.forEach((name) => {
      expect(res.headers[name]).toBeUndefined();
    });
  });
});

describe('request-shape invariance', () => {
  const LONG_PATH = '/' + 'a'.repeat(1999);

  const shapes = [
    ['GET /', (agent) => agent.get('/')],
    ['POST /admin with a body', (agent) => agent.post('/admin').send({ admin: true })],
    ['DELETE /x', (agent) => agent.delete('/x')],
    ['TRACE /', (agent) => agent.trace('/')],
    ['GET /healthz', (agent) => agent.get('/healthz')],
    ['GET with a two-kilobyte URL', (agent) => agent.get(LONG_PATH)],
    ['GET with a percent-encoded path', (agent) => agent.get('/a%20b%2Fc%3Fd')],
    ['GET with a query string', (agent) => agent.get('/?a=1&b=2')]
  ];

  // The handler contains no conditionals, so method, path, query string and encoding are all
  // structurally incapable of changing the answer. These rows prove that on the wire.
  test.each(shapes)(
    'ignores request shape %s and returns the identical response (F-001-RQ-002)',
    async (_label, send) => {
      const res = await send(request(server));
      expect(res.status).toBe(expected.STATUS);
      expect(res.text).toBe(expected.BODY);
      expect(Buffer.byteLength(res.text)).toBe(expected.BODY_BYTES);
    }
  );
});

describe('input inertness', () => {
  // One DISTINCT sentinel per hostile vector, each transmitted by the row that asserts it. A
  // single token shared across the matrix is not enough: a vector that does not carry the token
  // is asserted on its status and body alone, so a regression echoing that particular input into
  // a response header - say `X-Query: <script>alert(1)</script>` alongside the unchanged 14-byte
  // body - would pass unnoticed. Giving each row its own sentinels makes every row's
  // non-reflection assertion provably about that row's own input. Every sentinel is alphanumeric,
  // so percent-encoding leaves it byte-identical on the wire and a substring search over the
  // response cannot miss it.
  const SCRIPT_MARKER = 'SCRIPTMARKER456';
  const SCRIPT_CANARY = 'CANARYSCRIPT';
  const QUERY_CANARY = 'CANARY123';
  const COOKIE_MARKER = 'COOKIEMARKER789';
  const COOKIE_CANARY = 'CANARYCOOKIE';
  const BEARER_MARKER = 'BEARERMARKER321';
  const BEARER_CANARY = 'CANARYBEARER';

  // The script vector is percent-encoded from its decoded form rather than written out
  // pre-encoded, so its sentinels are provably inside the payload that goes on the wire and
  // cannot drift out of it. The server therefore sees
  // <script>alert('SCRIPTMARKER456', CANARYSCRIPT)</script>.
  const SCRIPT_PAYLOAD =
    '<script>alert(\'' + SCRIPT_MARKER + '\', ' + SCRIPT_CANARY + ')</script>';

  // [label, sentinels, send] rows: the label feeds the test title, `sentinels` lists every string
  // this row puts on the wire that MUST NOT appear anywhere in the response, and the sender
  // receives a fresh client bound to this test's server. The script row additionally names the
  // markup token in both its raw and percent-encoded forms, so even a truncated echo of the
  // payload is caught.
  const injections = [
    [
      'an injected script query',
      [SCRIPT_MARKER, SCRIPT_CANARY, '<script', '%3Cscript'],
      (agent) => agent.get('/?q=' + encodeURIComponent(SCRIPT_PAYLOAD))
    ],
    ['a canary query parameter', [QUERY_CANARY], (agent) => agent.get('/?secret=' + QUERY_CANARY)],
    [
      'a forged cookie',
      [COOKIE_MARKER, COOKIE_CANARY],
      (agent) =>
        agent
          .get('/')
          .set('Cookie', 'session=' + COOKIE_MARKER + '; token=' + COOKIE_CANARY + '; admin=true')
    ],
    [
      'an invalid bearer token',
      [BEARER_MARKER, BEARER_CANARY],
      (agent) =>
        agent.get('/').set('Authorization', 'Bearer ' + BEARER_MARKER + '.' + BEARER_CANARY)
    ]
  ];

  test.each(injections)('never reflects %s (F-001-RQ-002)', async (_label, sentinels, send) => {
    const res = await send(request(server));
    expect(res.status).toBe(expected.STATUS);
    expect(res.text).toBe(expected.BODY);
    // Checked in both directions for every sentinel this row carries: the sentinel must appear in
    // neither the body nor any response header, so this input is not reflected back. Headers are
    // serialised once so keys and values are searched together, and a sentinel smuggled into
    // either half fails the test.
    const serialisedHeaders = JSON.stringify(res.headers);
    sentinels.forEach((sentinel) => {
      expect(res.text.includes(sentinel)).toBe(false);
      expect(serialisedHeaders.includes(sentinel)).toBe(false);
    });
  });
});

describe('runtime-produced semantics', () => {
  // CLIENT-LEVEL HEAD coverage: what a consumer of this server actually observes. It is
  // deliberately supplementary, because a compliant client discards a HEAD body by specification
  // and would report an empty body even if the server had wrongly written bytes onto the wire.
  // The byte-level proof that nothing follows the header terminator therefore belongs to the
  // raw-socket tier, test/integration/protocol.test.js, which asserts it three ways; this case
  // owns the client-visible header contract instead.
  test('answers HEAD with the applicable headers and a zero-byte body (F-003-RQ-005)', async () => {
    const res = await request(server).head('/').set(...KEEP_ALIVE_REQUEST);
    // The handler runs for HEAD as it does for any method, so the two values below are the
    // subject's own: it sets the status and the content type without inspecting the request.
    expect(res.status).toBe(expected.STATUS);
    // The COMPLETE applicable key set, asserted as a set so an added or missing header fails
    // this test rather than slipping through. `.slice()` on both sides: the fixture array is
    // frozen and the derived set is shared, while `sort()` reorders in place.
    expect(Object.keys(res.headers).sort()).toEqual(HEAD_HEADER_KEYS.slice().sort());
    expect(res.headers['content-type']).toBe(expected.CONTENT_TYPE);
    // The runtime's contribution starts here: it echoes back the disposition this request asked
    // for, which is what brings the persistence header below into existence at all.
    expect(res.headers.connection).toBe(KEEP_ALIVE_DISPOSITION);
    expect(res.headers['keep-alive']).toBe(expected.KEEP_ALIVE);
    // It also transmits no body for a HEAD request. The client surfaces that absent body as
    // `undefined`, not as an empty string; normalising it here keeps this an exact byte-count
    // assertion.
    const bodyBytes = res.text === undefined ? 0 : Buffer.byteLength(res.text);
    expect(bodyBytes).toBe(0);
    // And the framing header goes with the body, so a HEAD response carries four header keys
    // rather than the five a GET carries. Implied by the key set above and stated explicitly
    // because it is the framing property F-003-RQ-005 turns on.
    expect(res.headers[FRAMING_HEADER]).toBeUndefined();
  });

  test('yields exactly one unique response across fifty sequential requests (F-001-RQ-003)', async () => {
    const seen = new Set();
    // The path varies on every iteration and each request is awaited before the next begins, so
    // any path-dependent or accumulated variation in the response would show up here as a second
    // outcome. That the request is never read at all is proven by the unit tier's throwing-getter
    // case, not by this one.
    for (let i = 0; i < 50; i += 1) {
      const res = await request(server).get('/seq' + i);
      seen.add(res.status + '|' + res.text);
    }
    expect(seen.size).toBe(1);
  });
});
