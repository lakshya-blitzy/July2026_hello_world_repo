'use strict';

/**
 * L2 CONTRACT TIER - the wire-level response contract of `server.js`, asserted over an
 * EPHEMERAL port.
 *
 * The subject exports nothing and binds 127.0.0.1:3000 as an unconditional side effect of
 * `require()`, so its request handler is reachable only by intercepting `http.createServer`.
 * This file takes the STUB-MODE route: the harness captures the handler while no socket is
 * created at all, the stub is then uninstalled, and the captured handler is mounted on a real
 * server bound to port 0. The fixed port is consequently never touched here - exactly one file
 * in the suite binds it - so this tier passes even while another process holds 127.0.0.1:3000.
 *
 * What this tier owns, that neither the unit tier above nor the raw-socket tier below does:
 *   - the response as a client actually receives it: status, body text, byte count, digest
 *   - the COMPLETE response header key set, asserted as a set so an added header fails
 *   - the headers the RUNTIME contributes beneath the handler: framing, persistence, HEAD
 *   - invariance of all of the above across arbitrary request shapes and hostile input
 *
 * Two measured runtime behaviours drive the assertions below, and both are easy to get wrong:
 *
 *   1. The five-key header set is REQUEST-DRIVEN. A client that does not ask for a persistent
 *      connection is answered with four keys, `connection: close`, and no `keep-alive` header
 *      at all. Every case asserting the complete key set or the persistence value therefore
 *      sends the header pair declared below explicitly.
 *   2. HEAD is answered entirely by the runtime, which omits `content-length` along with the
 *      body. A HEAD response carries four keys, and the client surfaces its absent body as
 *      `undefined` rather than as an empty string.
 *
 * Every expected literal comes from the frozen fixture module and none is duplicated here, so
 * a change in the subject's behaviour produces one obvious point of failure rather than a
 * scattering of edits. The subject itself is reference-only: it is never modified, never
 * required directly, and never repaired - the absent `charset` parameter on `Content-Type` is
 * asserted as the current, intended behaviour rather than corrected.
 *
 * @see ../helpers/captureHandler.js - stub-mode harness; records host and port, opens nothing
 * @see ../fixtures/expected.js - the frozen expected-value fixture, the source of every literal
 */

const http = require('http');
const crypto = require('crypto');
const request = require('supertest');
const { captureHandlerReady } = require('../helpers/captureHandler');
const expected = require('../fixtures/expected');

/**
 * `Connection: keep-alive` as the (field, value) pair `.set()` expects, spread at every call
 * site so the two halves cannot drift apart. Declared once because the complete five-key
 * response header set materialises only when the CLIENT asks for a persistent connection: a
 * request without this header is answered with four keys and no persistence header, which is
 * precisely why a naive request would fail the header-set assertion.
 *
 * @type {string[]}
 */
const KEEP_ALIVE_REQUEST = ['Connection', 'keep-alive'];

/**
 * The one piece of shared mutable state in this file: a real `http.Server` wrapping the
 * captured handler. Assigned only in `beforeEach` and released only in `afterEach`, so every
 * test gets a freshly bound listener on its own ephemeral port and stays runnable on its own.
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
  captured.restore(); // MUST precede any real createServer - supertest calls it internally.
  server = http.createServer(captured.handler);
  await new Promise((resolve) => {
    // Port 0: the runtime allocates an ephemeral port, leaving the subject's fixed port free
    // for the single tier that legitimately binds it. Readiness is this callback - an event,
    // never an elapsed duration.
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
    // Header values arrive as text, which is why the fixture holds the string form.
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
  // A ~2 KB request target, an order of magnitude past a conventional URL, and still just a
  // path the handler never reads.
  const LONG_PATH = '/' + 'a'.repeat(1999);

  // [label, send] pairs: the label feeds the test title, the sender receives a fresh client
  // bound to this test's server. Kept as data so a new shape is one row, not one more test.
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
  // A single token is sufficient: the handler reads nothing from the request, so any
  // reflection at all would be a behavioural change rather than an input-specific defect.
  const CANARY = 'CANARY123';

  const injections = [
    [
      'an injected script query',
      (agent) => agent.get('/?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E')
    ],
    ['a canary query parameter', (agent) => agent.get('/?secret=' + CANARY)],
    [
      'a forged cookie',
      (agent) => agent.get('/').set('Cookie', 'session=' + CANARY + '; admin=true')
    ],
    [
      'an invalid bearer token',
      (agent) => agent.get('/').set('Authorization', 'Bearer ' + CANARY)
    ]
  ];

  test.each(injections)('never reflects %s (F-001-RQ-002)', async (_label, send) => {
    const res = await send(request(server));
    expect(res.status).toBe(expected.STATUS);
    expect(res.text).toBe(expected.BODY);
    // Checked in both directions: neither the body nor any response header echoes the input,
    // so there is no reflection surface and no privilege to escalate.
    expect(res.text.includes(CANARY)).toBe(false);
    expect(JSON.stringify(res.headers).includes(CANARY)).toBe(false);
  });
});

describe('runtime-produced semantics', () => {
  test('answers HEAD with headers and a zero-byte body (F-003-RQ-005)', async () => {
    const res = await request(server).head('/').set(...KEEP_ALIVE_REQUEST);
    // The handler never inspects the method, so every property below is the runtime's doing.
    expect(res.status).toBe(expected.STATUS);
    expect(res.headers['content-type']).toBe(expected.CONTENT_TYPE);
    // The client surfaces an absent body as `undefined`, not as an empty string; normalising
    // it here keeps this an exact byte-count assertion.
    const bodyBytes = res.text === undefined ? 0 : Buffer.byteLength(res.text);
    expect(bodyBytes).toBe(0);
    // The runtime drops the framing header along with the body, so a HEAD response carries
    // four header keys rather than the five a GET carries.
    expect(res.headers['content-length']).toBeUndefined();
  });

  test('yields exactly one unique response across fifty sequential requests (F-001-RQ-003)', async () => {
    const seen = new Set();
    // The path varies on every iteration and each request is awaited before the next begins: a
    // handler that retained anything, or that read the path, would yield more than one outcome.
    for (let i = 0; i < 50; i += 1) {
      const res = await request(server).get('/seq' + i);
      seen.add(res.status + '|' + res.text);
    }
    expect(seen.size).toBe(1);
  });
});
