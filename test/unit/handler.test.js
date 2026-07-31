'use strict';

/**
 * L1 UNIT TIER - the subject's request handler and its `listen` callback, in isolation.
 *
 * STUB MODE. The stub harness swaps the HTTP server factory for a fake whose `listen` merely
 * RECORDS its arguments, so the intended host and port can be asserted while the fixed port they
 * name is left free. Loading the subject for real would bind that address, so this tier never
 * does (contract D2): no child process and no timer is created anywhere in this file, and the
 * subject itself never opens a socket here.
 *
 * ONE DELIBERATE EXCEPTION, AND IT IS THE POINT OF THE EXERCISE. The case that asserts the
 * recorded endpoint also binds a short-lived PROBE listener on that endpoint itself, because
 * reading back values the fake recorded cannot, on its own, show that nothing was bound - a fake
 * that accidentally opened the real listener would satisfy exactly the same two assertions
 * whenever the port happened to be free. The probe is created with `net.createServer`, which sits
 * OUTSIDE the `http.createServer` stub, so the bind cannot be answered by the fake; it succeeds
 * only if the subject genuinely left the address alone. It is closed on an unconditional path.
 * This gives the tier the same fixed-port precondition the suite already documents: TCP
 * 127.0.0.1:3000 must be free before the run.
 *
 * `server.js` is REFERENCE ONLY - never modified, never loaded from here. The harness loads it on
 * our behalf by an absolute path resolved from the runner root, so nothing in this file depends
 * on its own depth in the tree.
 *
 * Two harness contracts shape the readiness cases below:
 *   D6 - the fake's `listen` DEFERS its callback, so the readiness banner does not exist yet when
 *        the synchronous capture returns. Every readiness assertion therefore awaits the async
 *        ready variant, which flushes the deferred callback by draining the queue - never by
 *        waiting on the clock.
 *   D7 - captured stdout is a plain array snapshotted at capture time, because the runner clears
 *        and restores mock state between tests. Spy internals are never read at assertion time.
 *
 * Every expected literal comes from test/fixtures/expected.js, and each case carries the
 * requirement identifier it exercises so the traceability map is checkable from titles alone.
 */

const net = require('net');
const { captureHandler, captureHandlerReady } = require('../helpers/captureHandler');
const EXPECTED = require('../fixtures/expected');

/**
 * The capture owned by the test currently running. Module-scoped solely so teardown can reach it:
 * every case assigns it afresh and no case ever reads a value left by another, so there is no
 * shared mutable state and each case remains runnable on its own.
 *
 * @type {?ReturnType<typeof captureHandler>}
 */
let captured = null;

/**
 * Unconditional teardown. `afterEach` runs after a failing case exactly as it does after a
 * passing one, which is what makes the harness's two spies always come back out.
 *
 * It does a second job too: restoring marks the capture stale, and the fake drops a deferred
 * readiness callback belonging to a stale capture. Without that, an unflushed banner queued by
 * one case could surface in a later case's snapshot and inflate its log count. The runner's own
 * automatic mock restoration is an independent second layer - belt and braces, deliberately not
 * relied upon alone.
 */
afterEach(() => {
  if (captured) {
    captured.restore();
    captured = null;
  }
});

/**
 * Build a FRESH response double.
 *
 * It records exactly what the handler does to a response and nothing more: the assigned status
 * code, the arguments of every header call, and the arguments of the terminating call. No header
 * map, no `writeHead`, no `write`, no `getHeader`, no event emitter - the handler touches none of
 * them, and a richer double would invite assertions about behaviour the subject does not have.
 *
 * A brand-new object on every call is essential rather than tidy: sharing one recorder between
 * two invocations would make the statelessness proof circular.
 *
 * @returns {{statusCode: (number|undefined), setHeaderCalls: Array<Array<*>>,
 *   endArgs: (Array<*>|undefined), setHeader: function(...*): void, end: function(...*): void}}
 *   A recorder holding no prior calls.
 */
function responseDouble() {
  const res = {
    statusCode: undefined,
    setHeaderCalls: [],
    endArgs: undefined
  };

  res.setHeader = (...args) => {
    res.setHeaderCalls.push(args);
  };
  res.end = (...args) => {
    res.endArgs = args;
  };

  return res;
}

/**
 * Build a booby-trapped request double: reading `url`, `method` or `headers` throws.
 *
 * The subject's handler is route-agnostic and method-agnostic, and this double converts that
 * claim from an unverified assumption into a positively enforced assertion. Should the handler
 * ever start inspecting the request, every case using this double fails immediately, and the
 * thrown message names the property that was read.
 *
 * @returns {Object} A request-shaped object whose three accessors throw on any read.
 */
function throwingRequest() {
  const req = {};

  ['url', 'method', 'headers'].forEach((key) => {
    Object.defineProperty(req, key, {
      get() {
        throw new Error('handler must not read req.' + key);
      },
      configurable: true
    });
  });

  return req;
}

describe('request handler', () => {
  test('sets the response status code to 200 (F-003-RQ-001)', () => {
    captured = captureHandler();
    const res = responseDouble();

    captured.handler(throwingRequest(), res);

    expect(res.statusCode).toBe(EXPECTED.STATUS);
  });

  test('sets Content-Type to text/plain exactly once and with no charset parameter (F-003-RQ-002)', () => {
    captured = captureHandler();
    const res = responseDouble();

    captured.handler(throwingRequest(), res);

    // Exact equality over the whole call log settles three questions at once: the header is set,
    // it is set exactly once, and its value carries no charset parameter. A matcher that merely
    // looked for the header would pass even if a second call overrode it.
    expect(res.setHeaderCalls.length).toBe(1);
    expect(res.setHeaderCalls).toEqual([['Content-Type', EXPECTED.CONTENT_TYPE]]);
  });

  test('ends the response with the 14-byte greeting (F-003-RQ-003)', () => {
    captured = captureHandler();
    const res = responseDouble();

    captured.handler(throwingRequest(), res);

    // Both the payload and its measured size: the body is a fixed greeting, and its byte length
    // is the value the runtime later advertises as the response length.
    expect(res.endArgs).toEqual([EXPECTED.BODY]);
    expect(Buffer.byteLength(res.endArgs[0])).toBe(EXPECTED.BODY_BYTES);
  });

  test('accepts exactly two arguments (F-001-RQ-001)', () => {
    captured = captureHandler();

    expect(typeof captured.handler).toBe('function');
    expect(captured.handler.length).toBe(2);
  });

  test('never inspects the request url, method or headers (F-001-RQ-002)', () => {
    captured = captureHandler();
    const res = responseDouble();

    // The double throws on any read of url, method or headers, so completing without throwing IS
    // the proof that the handler is request-agnostic.
    expect(() => captured.handler(throwingRequest(), res)).not.toThrow();

    // And it did the full job rather than bailing out early: all three response effects landed.
    expect(res.statusCode).toBe(EXPECTED.STATUS);
    expect(res.setHeaderCalls).toEqual([['Content-Type', EXPECTED.CONTENT_TYPE]]);
    expect(res.endArgs).toEqual([EXPECTED.BODY]);
  });

  test('retains no state across repeated invocations (F-001-RQ-003)', () => {
    captured = captureHandler();
    const first = responseDouble();
    const second = responseDouble();

    // The SAME captured handler, with a fresh recorder and a fresh booby-trapped request each
    // time. The handler is synchronous and holds no counter, cache or accumulator, so the second
    // invocation must produce effects indistinguishable from the first.
    captured.handler(throwingRequest(), first);
    captured.handler(throwingRequest(), second);

    expect(second.statusCode).toBe(first.statusCode);
    expect(second.setHeaderCalls).toEqual(first.setHeaderCalls);
    expect(second.endArgs).toEqual(first.endArgs);

    // Anchored to the frozen expectations as well, so the case cannot pass by both being wrong in
    // the same way.
    expect(first.statusCode).toBe(EXPECTED.STATUS);
    expect(first.setHeaderCalls).toEqual([['Content-Type', EXPECTED.CONTENT_TYPE]]);
    expect(second.endArgs).toEqual([EXPECTED.BODY]);
  });
});

describe('module bootstrap and readiness log', () => {
  test('creates exactly one server (F-001-RQ-001)', () => {
    captured = captureHandler();

    // One load, one server, one handler. A second factory call would mean a second listener with
    // its own behaviour, and every assertion in this tier would be describing only one of them.
    expect(captured.createServerCalls).toBe(1);
  });

  test('records the intended port and host without binding a socket (F-002-RQ-001)', async () => {
    captured = captureHandler();

    // Argument order mirrors the subject's own call - PORT FIRST, host second. Reading them the
    // other way round would still pass a sloppy assertion while proving nothing.
    //
    // No socket exists at this point: the fake's `listen` records what it was handed and returns,
    // which is what lets this tier assert the intended endpoint and still leave the fixed port
    // free.
    expect(captured.recordedPort).toBe(EXPECTED.PORT);
    expect(captured.recordedHost).toBe(EXPECTED.HOST);

    // INDEPENDENT PROOF THAT THE ENDPOINT REALLY IS FREE.
    //
    // The two assertions above read back values the fake recorded, which shows what the subject
    // ASKED for and nothing about what the operating system did with it: a fake that accidentally
    // opened the real listener would satisfy both of them unchanged whenever the port happened to
    // be free. The claim in this case's title is therefore checked against the address itself.
    //
    // `net.createServer` is chosen deliberately over `http.createServer`: the latter is currently
    // the stub, so a probe built with it would be answered by the fake and prove nothing, and it
    // would also displace the subject's own call from the spy's index 0. The probe below reaches
    // the real kernel bind, so it can only succeed while the stub is installed if the subject
    // genuinely left 127.0.0.1:3000 alone. Binding it is the assertion; EADDRINUSE would fail
    // this case, as it should.
    const probe = net.createServer();

    try {
      const probeAddress = await new Promise((resolve, reject) => {
        // A single settle path in both directions, each detaching the other listener by
        // reference, so neither outlives the bind attempt.
        const onProbeListening = () => {
          probe.removeListener('error', onProbeError);
          resolve(probe.address());
        };

        const onProbeError = (probeError) => {
          probe.removeListener('listening', onProbeListening);
          reject(probeError);
        };

        probe.once('listening', onProbeListening);
        probe.once('error', onProbeError);
        probe.listen(EXPECTED.PORT, EXPECTED.HOST);
      });

      // Exact endpoint, not merely "a bind happened": the probe must have claimed the very
      // address the subject named, so the two recorded values above are shown to describe an
      // address that was still available.
      expect(probeAddress).toEqual({
        address: EXPECTED.HOST,
        family: 'IPv4',
        port: EXPECTED.PORT
      });
    } finally {
      // Unconditional release, on the failing path as much as the passing one: a probe left open
      // would hold the fixed port for the rest of the run and leak a handle. When the bind never
      // succeeded, `close()` still invokes its callback - with ERR_SERVER_NOT_RUNNING, which is
      // precisely the state being cleaned up after - so the argument is deliberately ignored.
      await new Promise((resolve) => {
        probe.close(() => {
          resolve();
        });
      });
    }
  });

  test('composes the readiness line from the same host and port it binds (F-002-RQ-003)', async () => {
    captured = await captureHandlerReady();

    // The scaffold below is STRUCTURE, not an expected value: every value in the comparison is
    // read back from the capture snapshot, so this asserts that the banner is built from the very
    // host and port that reached `listen`. Comparing against the frozen line alone would show the
    // line is correct without showing where its parts came from - which is the whole claim here.
    expect(captured.logs[0]).toBe(
      'Server running at http://' + captured.recordedHost + ':' + captured.recordedPort + '/'
    );
    expect(captured.logs[0]).toBe(EXPECTED.READY_LINE);
  });

  test('derives the readiness line from the module constants (F-004-RQ-002)', async () => {
    captured = await captureHandlerReady();

    // A single pair of constants feeds both the bind and the banner: the subject holds no second
    // source of truth and offers no override path, so these three assertions describe one fact
    // from two directions.
    expect(captured.recordedHost).toBe(EXPECTED.HOST);
    expect(captured.recordedPort).toBe(EXPECTED.PORT);
    expect(captured.logs[0]).toBe(
      'Server running at http://' + captured.recordedHost + ':' + captured.recordedPort + '/'
    );
  });

  test('logs exactly one readiness line of 41 bytes from the listen callback (F-004-RQ-001)', async () => {
    captured = await captureHandlerReady();

    // The banner is the subject's only observability surface, so it is a first-class assertion
    // target: one line, that exact line, and that exact size.
    expect(captured.logs.length).toBe(1);
    expect(captured.logs[0]).toBe(EXPECTED.READY_LINE);

    // The frozen line carries no trailing newline; the logger appends one, so the line actually
    // emitted on stdout is a byte longer than the string it was built from.
    expect(Buffer.byteLength(captured.logs[0] + '\n')).toBe(EXPECTED.READY_BYTES);
  });

  test('confines logging to that single readiness line (F-004-RQ-003)', async () => {
    captured = await captureHandlerReady();

    // Serving traffic must add nothing to stdout: the handler writes no access log, no timing and
    // no diagnostic. Three invocations with fresh doubles, and the count must not budge.
    captured.handler(throwingRequest(), responseDouble());
    captured.handler(throwingRequest(), responseDouble());
    captured.handler(throwingRequest(), responseDouble());

    expect(captured.logs.length).toBe(1);
    expect(captured.logs[0]).toBe(EXPECTED.READY_LINE);
  });

  test('emits no readiness line until the deferred listen callback runs (F-004-RQ-001)', () => {
    // Synchronous capture, deliberately NOT flushed. This is contract D6 written down as an
    // executable assertion: the banner comes from a deferred callback, so immediately after the
    // load it does not exist. Any future case that asserts the banner without awaiting the ready
    // variant is asserting against this empty snapshot, and the trap cannot quietly return.
    captured = captureHandler();

    expect(captured.logs.length).toBe(0);
    expect(captured.logs).toEqual([]);
  });
});
