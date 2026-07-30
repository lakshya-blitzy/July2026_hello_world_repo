'use strict';

/**
 * STUB-MODE HARNESS for the subject under test (`server.js`) - NO SOCKET IS EVER CREATED.
 *
 * `server.js` exports nothing, binds 127.0.0.1:3000 as an unconditional side effect of module
 * load, and hard-codes its host and port. `http.createServer` is therefore the ONLY seam
 * through which its private request handler can be reached. This harness replaces that factory
 * with a fake whose `listen()` merely RECORDS its arguments, so the intended host and port can
 * be asserted while TCP 127.0.0.1:3000 stays genuinely free (standard S-5: a probe server
 * successfully claimed port 3000 during a stub-mode run). Real module loading with a real bind
 * is confined to `test/e2e/bootstrap.test.js` via `loadServer.js` (contract D2, which is also
 * why `maxWorkers` is pinned to 1) - any tier that needs the handler must use THIS harness.
 *
 * Consumers - the three stub-mode tiers ONLY:
 *   L1  test/unit/handler.test.js         invokes `handler` directly with doubles
 *   L2  test/integration/contract.test.js mounts `handler` on an ephemeral port
 *   L3  test/integration/protocol.test.js drives raw sockets at an ephemeral port
 * Do not add a call-through mode here and do not merge this file with `loadServer.js` or
 * `spawnServer.js`: collapsing the harnesses would reintroduce the port collision D2 prevents.
 *
 * EXPORTED SURFACE - `captureHandler()` and `captureHandlerReady()` resolve to the same shape:
 *   handler            captured request listener; a function of arity 2 -> (req, res)
 *   fake               the fake server object the stubbed factory returned
 *   recordedPort       plain snapshot of listen()'s FIRST argument      -> 3000 (number)
 *   recordedHost       plain snapshot of listen()'s SECOND argument     -> '127.0.0.1' (string)
 *   createServerCalls  plain snapshot of the invocation count           -> 1 (number)
 *   logs               plain array of captured console.log lines
 *   createServerSpy    the http.createServer spy - same-test convenience only
 *   logSpy             the console.log spy - same-test convenience only
 *   restore()          idempotent restoration of BOTH spies
 * The snapshots, not the spy objects, are the authoritative values (see contract D7).
 *
 * ARGUMENT ORDER - the fake's `listen(port, host, cb)` is PORT FIRST, host second, because
 * `server.js` line 12 calls `server.listen(port, hostname, cb)`. Reversing it would silently
 * record the wrong values and make the L1 host/port assertions meaningless. `listen` returns
 * `this` so chaining works, and it DEFERS its callback via `process.nextTick`.
 *
 * CONTRACT D6 - the deferred callback must be FLUSHED before stdout is read. Because the fake
 * defers, `captureHandler()` deliberately returns while `logs` is still EMPTY (measured: `logs`
 * is `[]` immediately after `require()`). A consumer asserting the readiness banner must
 * therefore `await captureHandlerReady()`, which flushes the nextTick queue with `setImmediate`
 * - a queue flush, NEVER a wall-clock sleep (standard S-2) - after which `logs` holds exactly
 * one entry, 'Server running at http://127.0.0.1:3000/' (40 characters; console.log adds the
 * newline, making the emitted line 41 bytes).
 *
 * D6 COROLLARY, measured and guarded - Jest drives an entire test file through promise
 * microtasks inside a single event-loop turn, so nextTick callbacks queued in one test do NOT
 * fire before the next test begins: they accumulate and drain together the first time any test
 * yields to the check phase. Left unguarded, six earlier unflushed captures replayed their
 * banners into a later test and produced SEVEN readiness lines where exactly one was expected.
 * The fake therefore drops a deferred callback whose capture has gone stale - restored, or its
 * spies swapped back out by Jest's automatic `restoreMocks` between tests - so `logs` only ever
 * contains lines belonging to its own capture and each tier's banner assertion is exact whether
 * the test runs alone or inside the suite (standards S-3 and S-4).
 *
 * CONTRACT D7 - captured output is a PLAIN ARRAY snapshotted at capture time, never a getter
 * over the spy's recorded calls. `jest.config.js` sets `clearMocks: true` and
 * `restoreMocks: true`, so mock state is wiped between tests and a lazy accessor would read
 * nothing. The same discipline applies to `handler`, `recordedPort`, `recordedHost` and
 * `createServerCalls`: each is read once, immediately after `require()`, and returned as a
 * plain value.
 *
 * CONTRACT E3 - call `restore()` BEFORE handing `handler` to `supertest(...)` or to your own
 * `http.createServer(...)`. `supertest(listener)` INTERNALLY CALLS `http.createServer(listener)`,
 * so while the stub is still installed supertest receives the FAKE - which has no real
 * `listen`, no `address()` and no socket - and the tier hangs or fails confusingly:
 *
 *     const { captureHandler } = require('../helpers/captureHandler');
 *     const EPHEMERAL = 0;                                 // 0 => the OS picks a free port
 *     const captured = captureHandler();
 *     captured.restore();                                  // MUST come first - see above
 *     const server = http.createServer(captured.handler);  // a real server, not the fake
 *     server.listen(EPHEMERAL, '127.0.0.1', () => { });    // standard S-5
 *
 * That bind belongs to the CONSUMER: this harness itself opens nothing, which is why no socket
 * API and no bind call appear anywhere below.
 *
 * Call the harness ONCE PER TEST: `jest.spyOn` on an already-spied method nests the mocks, so
 * `restore()` first if a second capture is needed inside a single test. Requiring this module
 * has no side effects - no spy is installed, no module is loaded, no socket and no timer are
 * created - so the two functions are safe to import anywhere and are independently runnable
 * when a single test is selected by name (standard S-4).
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

/**
 * Absolute path to the subject under test, resolved from the runner root.
 *
 * `jest.config.js` declares no `rootDir`, so Jest's rootDir is the directory containing the
 * config - the repository root - and npm scripts run from the package root, which makes
 * `process.cwd()` the runner root. Resolving here (rather than requiring a relative path such
 * as '../../server.js') means no test's behaviour depends on its own depth in the tree, and the
 * subject still travels through Jest's module system so coverage instrumentation applies.
 *
 * This is a pure computation: it performs no I/O, so importing this module stays inert.
 *
 * @type {string}
 */
const SUBJECT = path.resolve(process.cwd(), 'server.js');

/**
 * Validate the two preconditions the harness cannot function without, and fail loudly rather
 * than opaquely if either is unmet. Deliberately invoked from inside `captureHandler()` so that
 * merely requiring this module never throws and never touches the filesystem.
 *
 * @returns {void}
 * @throws {Error} When the `jest` global is unavailable, or the subject is not on disk.
 */
function assertPreconditions() {
  // `jest` is a global inside the Jest test environment; it is never a require()-able module.
  // `typeof` on an undeclared identifier is safe and does not throw.
  if (typeof jest === 'undefined') {
    throw new Error(
      'captureHandler: the `jest` global is unavailable. This harness is built on ' +
        'jest.spyOn() and jest.resetModules(), so it can only be invoked from inside a Jest ' +
        'test environment. Requiring this module outside Jest is safe; calling its functions ' +
        'is not.'
    );
  }

  if (!fs.existsSync(SUBJECT)) {
    throw new Error(
      `captureHandler: the subject under test was not found at ${SUBJECT}. That path is ` +
        'resolved from process.cwd(), so the harness must run with the repository root as the ' +
        'working directory (every npm script in package.json already does).'
    );
  }
}

/**
 * Install stub mode, load the subject, and snapshot everything it revealed.
 *
 * Synchronous by design: `server.js` calls `http.createServer(...)` and `server.listen(...)` at
 * top level, so the handler, port and host are all recorded before `require()` returns. The
 * readiness banner is NOT - it is emitted from the deferred `listen` callback - so `logs` is
 * still empty here. Use {@link captureHandlerReady} when the banner matters (contract D6).
 *
 * @returns {{
 *   handler: function(*, *): void,
 *   fake: {_port: (number|undefined), _host: (string|undefined), listen: function(*, *, *): *},
 *   recordedPort: (number|undefined),
 *   recordedHost: (string|undefined),
 *   createServerCalls: number,
 *   logs: string[],
 *   createServerSpy: *,
 *   logSpy: *,
 *   restore: function(): void
 * }} A plain snapshot of the captured stub-mode state.
 * @throws {Error} When a precondition fails, the subject throws, or no handler is captured.
 */
function captureHandler() {
  assertPreconditions();

  // --- console.log interception ------------------------------------------------------------
  // Contract D7: push into an array WE own, at capture time. The readiness line is the
  // subject's sole observability surface, so it is an assertion target; silencing it also
  // keeps the runner's output clean (standard S-9).
  const logs = [];
  const logSpy = jest.spyOn(console, 'log').mockImplementation((...args) => {
    logs.push(args.join(' '));
  });

  // --- the fake server ---------------------------------------------------------------------
  // Built fresh on every call, never a module-level singleton (standard S-4). It records,
  // defers and chains - and it NEVER opens a socket, which is what leaves port 3000 free
  // (standard S-5). Argument order mirrors server.js line 12: (port, host, cb).
  const fake = {
    _port: undefined,
    _host: undefined,
    listen(port, host, cb) {
      this._port = port;
      this._host = host;
      if (typeof cb === 'function') {
        // Deferred with process.nextTick exactly as the specification prescribes, so the
        // readiness banner does not exist yet when the synchronous capture returns (D6).
        //
        // The staleness guard is not decoration. Jest drives a whole test file through promise
        // microtasks inside a single event-loop turn, so nextTick callbacks queued in one test
        // do NOT fire before the next test begins: they accumulate and drain together the first
        // time any test yields to the check phase. Measured without this guard, six earlier
        // unflushed captures replayed into a later test and produced seven readiness lines
        // where exactly one was expected. A deferred callback must never outlive the capture
        // that queued it (standards S-3 and S-4).
        process.nextTick(() => {
          if (isStale()) {
            return;
          }
          cb();
        });
      }
      return this;
    }
  };

  // --- http.createServer interception ------------------------------------------------------
  // Native jest.spyOn only: no third-party mocking, stubbing or module-interception package is
  // used anywhere in this suite (standard S-10 - supplying both call-through spying and
  // module-registry reset in one tool is why Jest was selected). The mock implementation
  // receives the request listener as its only argument.
  let handler;
  const createServerSpy = jest
    .spyOn(http, 'createServer')
    .mockImplementation((requestListener) => {
      handler = requestListener;
      return fake;
    });

  // --- teardown ----------------------------------------------------------------------------
  // Idempotent: a second call is a no-op, so consumers may call it defensively in `afterEach`
  // even when a test already restored (standard S-3). There is no socket and no timer to
  // release, so restoring the two spies is the whole of teardown.
  let restored = false;

  /**
   * Has this capture been superseded? True once `restore()` has run, or once either stub is no
   * longer the installed implementation - which is what Jest's automatic `restoreMocks` does
   * between tests. Consulted only from the deferred `listen` callback, so a capture belonging
   * to a finished test can never write into a live one's `logs`.
   *
   * @returns {boolean} True when the capture is no longer the active one.
   */
  function isStale() {
    return restored || console.log !== logSpy || http.createServer !== createServerSpy;
  }

  /**
   * Uninstall both stubs, putting the real `http.createServer` and `console.log` back. Must be
   * called before the captured handler is handed to `supertest(...)` or to a real
   * `http.createServer(...)` - see contract E3 in the file header.
   *
   * @returns {void}
   */
  function restore() {
    if (restored) {
      return;
    }
    restored = true;
    createServerSpy.mockRestore();
    logSpy.mockRestore();
  }

  // --- load the subject --------------------------------------------------------------------
  // Reset first so every call gets a genuinely fresh module instance rather than a cached one.
  jest.resetModules();
  try {
    require(SUBJECT);
  } catch (error) {
    // A throwing subject must never leave the factory stubbed or stdout swallowed for the rest
    // of the test. Restore, then re-raise the original failure untouched.
    restore();
    throw error;
  }

  // Drift alarm: with the subject in its committed shape this is unreachable, but if it ever
  // stops calling http.createServer at load time, say so here rather than letting every
  // downstream tier fail on an undefined handler.
  if (typeof handler !== 'function') {
    restore();
    throw new Error(
      `captureHandler: no request listener was captured from ${SUBJECT}. The subject is ` +
        'expected to call http.createServer(handler) exactly once at module load; if its shape ' +
        'has changed, this harness and every stub-mode tier built on it must be revisited.'
    );
  }

  // --- snapshot everything NOW (contract D7) -----------------------------------------------
  // clearMocks/restoreMocks wipe mock state between tests, so nothing below may be exposed as
  // a getter or a lazily invoked function over that state.
  return {
    // The request listener from server.js line 6. Arity 2: (req, res).
    handler,
    // The fake the stubbed factory returned. Nothing was ever bound to it.
    fake,
    // listen()'s FIRST argument. Expected: 3000 (number).
    recordedPort: fake._port,
    // listen()'s SECOND argument. Expected: '127.0.0.1' (string).
    recordedHost: fake._host,
    // Invocation count as a plain number. Expected: 1.
    createServerCalls: createServerSpy.mock.calls.length,
    // Plain array of captured stdout lines. Empty here; see contract D6.
    logs,
    // Spy objects, for same-test convenience only - prefer the snapshots above.
    createServerSpy,
    logSpy,
    restore
  };
}

/**
 * Install stub mode exactly as {@link captureHandler} does, then flush the deferred `listen`
 * callback so the readiness banner exists before the caller inspects `logs`.
 *
 * Contract D6: the fake's `listen` defers its callback with `process.nextTick`, so reading
 * `logs` straight after `require()` yields `[]`. `setImmediate` fires after the nextTick queue
 * has drained, which means the callback - and therefore the `console.log` - has already run by
 * the time this resolves. It is a queue flush, NOT a wall-clock sleep: no timer and no delay of
 * any kind appear anywhere in this file (standard S-2).
 *
 * @returns {Promise<ReturnType<typeof captureHandler>>} The same shape as
 *   {@link captureHandler}, with `logs` holding exactly one entry:
 *   'Server running at http://127.0.0.1:3000/' (41 bytes once console.log's newline is added).
 * @throws {Error} Propagates every failure {@link captureHandler} can raise.
 */
async function captureHandlerReady() {
  const captured = captureHandler();

  // Flush the nextTick queue by yielding to the check phase. The Immediate is consumed as it
  // fires, so no handle outlives this call and --detectOpenHandles stays quiet (standard S-3).
  await new Promise((resolve) => {
    setImmediate(resolve);
  });

  return captured;
}

module.exports = { captureHandler, captureHandlerReady };
