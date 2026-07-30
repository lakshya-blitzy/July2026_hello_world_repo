'use strict';

/**
 * STUB-MODE HARNESS for the subject under test (`server.js`) - NO SOCKET IS EVER CREATED.
 *
 * `server.js` exports nothing, binds 127.0.0.1:3000 as an unconditional side effect of module
 * load, and hard-codes its host and port, so `http.createServer` is the only seam through
 * which its private request handler can be reached. This harness stubs that factory with a
 * fake whose `listen()` merely RECORDS its arguments, so the intended host and port can be
 * asserted while TCP 127.0.0.1:3000 stays genuinely free. Any test that needs the handler
 * should use this harness; loading the subject for real - which does bind that port - is
 * reserved for a single test file, so parallel binds cannot collide.
 *
 * API:
 *   captureHandler()       synchronous. Installs the stubs, loads the subject, and returns a
 *                          snapshot of what it revealed. `logs` is still EMPTY on return,
 *                          because the fake defers the readiness callback.
 *   captureHandlerReady()  async. Does the same, then flushes the deferred callback, and
 *                          resolves to the same snapshot with `logs` populated.
 *
 * Snapshot members:
 *   handler            captured request listener; a function of arity 2 -> (req, res)
 *   fake               the fake server object the stubbed factory returned
 *   recordedPort       listen()'s FIRST argument      -> 3000 (number)
 *   recordedHost       listen()'s SECOND argument     -> '127.0.0.1' (string)
 *   createServerCalls  invocation count               -> 1 (number)
 *   logs               captured console.log lines
 *   createServerSpy    the http.createServer spy - same-test convenience only
 *   logSpy             the console.log spy - same-test convenience only
 *   restore()          idempotent restoration of BOTH spies
 * Every value above is a plain snapshot read once, immediately after the subject is required,
 * because `jest.config.js` clears and restores mocks between tests: an accessor that read spy
 * state at assertion time would find it wiped. The snapshots, not the spy objects, are
 * authoritative.
 *
 * ARGUMENT ORDER - the fake's `listen(port, host, cb)` is PORT FIRST, host second, mirroring
 * the subject's own `server.listen(port, hostname, cb)`. Reversing it would silently record the
 * wrong values and make host/port assertions meaningless. `listen` returns `this` so chaining
 * works, and it DEFERS its callback via `process.nextTick`.
 *
 * READINESS IS DEFERRED - `logs` is empty when `captureHandler()` returns. Asserting the
 * readiness banner therefore requires `await captureHandlerReady()`, which flushes the nextTick
 * queue with `setImmediate` - a queue flush, never a wall-clock sleep - after which `logs`
 * holds exactly one entry, 'Server running at http://127.0.0.1:3000/' (40 characters;
 * console.log adds the newline, making the emitted line 41 bytes).
 *
 * Because Jest drives a whole test file through promise microtasks inside a single event-loop
 * turn, nextTick callbacks queued in one test do not fire before the next test begins: they
 * accumulate and drain together the first time any test yields to the check phase. The fake
 * therefore DROPS a deferred callback whose capture has gone stale - restored, or its spies
 * swapped back out by Jest's automatic mock restoration between tests - so `logs` only ever
 * contains lines belonging to its own capture, whether a test runs alone or inside the suite.
 *
 * RESTORE BEFORE BUILDING A REAL SERVER - call `restore()` before handing `handler` to
 * `supertest(...)` or to your own `http.createServer(...)`. `supertest(listener)` internally
 * calls `http.createServer(listener)`, so while the stub is installed supertest receives the
 * FAKE - which has no real `listen`, no `address()` and no socket - and the test hangs or fails
 * confusingly. That bind belongs to the caller: this harness itself opens nothing, which is why
 * no socket API and no bind call appear anywhere below.
 *
 * Call the harness once per test: `jest.spyOn` on an already-spied method nests the mocks, so
 * `restore()` first if a second capture is needed inside one test. Importing this module has no
 * side effects - it loads only Node built-ins, and installs no spy, creates no socket and
 * starts no timer until a function is called - so both functions are safe to import anywhere
 * and each test remains runnable on its own.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

/**
 * Absolute path to the subject under test, resolved from the runner root rather than from this
 * file's own location, so no test's behaviour depends on its depth in the tree. Requiring the
 * subject by absolute path keeps it inside Jest's module system, so coverage instrumentation
 * still applies. Evaluating this performs no I/O, which is what keeps importing this module
 * inert.
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
 * Synchronous by design: the subject calls `http.createServer(...)` and `server.listen(...)` at
 * top level, so the handler, port and host are all recorded before `require()` returns. The
 * readiness banner is not - it is emitted from the deferred `listen` callback - so `logs` is
 * still empty here. Use {@link captureHandlerReady} when the banner matters.
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

  // Push into an array this capture owns, rather than reading spy state later. The readiness
  // line is the subject's sole observability surface, so it is an assertion target; silencing
  // it also keeps the runner's output clean.
  const logs = [];
  const logSpy = jest.spyOn(console, 'log').mockImplementation((...args) => {
    logs.push(args.join(' '));
  });

  // Built fresh on every call, never a module-level singleton. It records, defers and chains -
  // and it NEVER opens a socket, which is what leaves port 3000 free. Argument order mirrors
  // the subject's own call: (port, host, cb).
  const fake = {
    _port: undefined,
    _host: undefined,
    listen(port, host, cb) {
      this._port = port;
      this._host = host;
      if (typeof cb === 'function') {
        // Deferred, so the readiness banner does not exist yet when the synchronous capture
        // returns; `captureHandlerReady` flushes it.
        //
        // The staleness guard is not decoration. Jest drives a whole test file through promise
        // microtasks inside a single event-loop turn, so nextTick callbacks queued in one test
        // do not fire before the next test begins: they accumulate and drain together the first
        // time any test yields to the check phase. Without the guard, unflushed captures replay
        // their banners into a later test, which then sees more readiness lines than it
        // expects. A deferred callback must never outlive the capture that queued it.
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

  // Native jest.spyOn only: no third-party mocking, stubbing or module-interception package is
  // used anywhere in this suite. The mock implementation receives the request listener as its
  // only argument.
  let handler;
  const createServerSpy = jest
    .spyOn(http, 'createServer')
    .mockImplementation((requestListener) => {
      handler = requestListener;
      return fake;
    });

  // Idempotent: a second call is a no-op, so a test may call it defensively in `afterEach`
  // even after restoring inline. There is no socket and no timer to release, so restoring the
  // two spies is the whole of teardown.
  let restored = false;

  /**
   * Has this capture been superseded? True once `restore()` has run, or once either stub is no
   * longer the installed implementation - which is what Jest's automatic mock restoration does
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
   * `http.createServer(...)` - see the file header.
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

  // Drift alarm: with the subject in its current shape this is unreachable, but if it ever
  // stops calling http.createServer at load time, say so here rather than letting callers fail
  // on an undefined handler.
  if (typeof handler !== 'function') {
    restore();
    throw new Error(
      `captureHandler: no request listener was captured from ${SUBJECT}. The subject is ` +
        'expected to call http.createServer(handler) exactly once at module load; if its shape ' +
        'has changed, this harness and every stub-mode tier built on it must be revisited.'
    );
  }

  // Snapshot everything now: mock state is cleared between tests, so nothing below may be
  // exposed as a getter or a lazily invoked function over that state.
  return {
    handler,
    fake,
    recordedPort: fake._port,
    recordedHost: fake._host,
    createServerCalls: createServerSpy.mock.calls.length,
    logs,
    createServerSpy,
    logSpy,
    restore
  };
}

/**
 * Install stub mode exactly as {@link captureHandler} does, then flush the deferred `listen`
 * callback so the readiness banner exists before the caller inspects `logs`.
 *
 * The fake's `listen` defers its callback with `process.nextTick`, so reading `logs` straight
 * after `require()` yields `[]`. `setImmediate` fires after the nextTick queue has drained,
 * which means the callback - and therefore the `console.log` - has already run by the time this
 * resolves. It is a queue flush, not a wall-clock sleep: no timer and no delay of any kind
 * appear anywhere in this file.
 *
 * @returns {Promise<ReturnType<typeof captureHandler>>} The same shape as
 *   {@link captureHandler}, with `logs` holding exactly one entry:
 *   'Server running at http://127.0.0.1:3000/' (41 bytes once console.log's newline is added).
 * @throws {Error} Propagates every failure {@link captureHandler} can raise.
 */
async function captureHandlerReady() {
  const captured = captureHandler();

  // Flush the nextTick queue by yielding to the check phase. The Immediate is consumed as it
  // fires, so no handle outlives this call and open-handle detection stays quiet.
  await new Promise((resolve) => {
    setImmediate(resolve);
  });

  return captured;
}

module.exports = { captureHandler, captureHandlerReady };
