'use strict';

/**
 * CALL-THROUGH HARNESS - a REAL `http.Server` on a REAL bind of 127.0.0.1:3000.
 * ===========================================================================
 *
 * PURPOSE
 *   `server.js` exports nothing and binds as an unconditional side effect of
 *   `require()`. This harness reaches the otherwise-private request handler and
 *   the private `http.Server` instance by SPYING on `http.createServer` WITHOUT
 *   replacing it, so the genuine runtime implementation runs, a real
 *   `http.Server` is produced, and the real require-time bind on
 *   127.0.0.1:3000 actually happens. The subject is never edited (standard
 *   S-1): its SHA-256 must remain
 *   332fc2d04eb5b8f3cb230855457af80d0dfc246f958d6e49615610d656acc2e0.
 *
 * SINGLE CONSUMER - `test/e2e/bootstrap.test.js`, AND NOTHING ELSE (contract D2)
 *   Observed defect: "Two files loading the module under two workers failed
 *   with EADDRINUSE on port 3000; the same files passed under one worker." Two
 *   mitigations are in force: `maxWorkers: 1` in `jest.config.js`, and the
 *   STRUCTURAL confinement of all real module loading to this helper's single
 *   consumer. Do not import this helper from any other tier, do not merge it
 *   with `captureHandler.js` or `spawnServer.js`, and do not add a stub mode
 *   here - every other tier uses `captureHandler.js` on an ephemeral port.
 *   Worker concurrency must not be raised while real loading lives in a test.
 *
 * PORT PRECONDITION
 *   TCP 127.0.0.1:3000 must be FREE before `loadServer()` is called. The port
 *   is a hard-coded literal in the subject with no override path, and adding
 *   one here would change source behaviour; standard S-5 records this tier as
 *   the one deliberate fixed-port exception.
 *
 * COVERAGE SIGNIFICANCE
 *   `jest.config.js` scopes instrumentation to `server.js` alone and enforces
 *   100% on all four metrics. This helper is what drives the `functions` metric
 *   to 2/2: the subject's `listen` callback is only reachable when a bind
 *   genuinely succeeds, so a passing functions metric is itself evidence that
 *   startup was really exercised rather than simulated.
 *
 * EXPORTED SURFACE
 *   loadServer()       synchronous; returns the snapshot object described below.
 *   loadServerReady()  async; `loadServer()` then `await ready()`, so `logs` is
 *                      already populated when it resolves.
 *
 *   Snapshot object returned by both:
 *     handler            real request listener            function, arity 2
 *     server             real server instance             instanceof http.Server
 *     createServerCalls  plain number snapshot            expected 1
 *     logs               plain array of console.log lines; EMPTY right after
 *                        load (D5); after `ready()` resolves it holds exactly
 *                        one entry, 'Server running at http://127.0.0.1:3000/'
 *     errors             plain array of collected 'error' events; empty on a
 *                        successful bind
 *     subjectExports     the subject's exports object - ZERO own keys, because
 *                        `server.js` has no `module.exports` (F-005-RQ-003)
 *     subjectPath        absolute path the subject was required from
 *     createServerSpy    the call-through spy, same-test convenience only
 *     logSpy             the console.log spy, same-test convenience only
 *     ready()            async; resolves after 'listening', rejects on 'error'
 *     waitForError()     async; resolves with the first collected 'error'
 *     teardown()         async, idempotent, for an unconditional path
 *
 * CALL IT FROM A TEST BODY OR A USER `beforeEach` - NEVER FROM `beforeAll`.
 *   `jest.config.js` sets `clearMocks` and `restoreMocks`, and jest-circus
 *   registers the hook that applies them as the FIRST top-level `beforeEach`.
 *   A `beforeAll` runs before that restore, which would tear the spies down
 *   before the first test even starts.
 *
 * CONTRACT D5 - readiness is sequenced on the 'listening' EVENT
 *   Observed defect: the readiness line is emitted from the `listen` callback
 *   and is therefore asynchronous relative to `require()`; snapshotting
 *   immediately after load captured nothing. `ready()` therefore (a) rejects at
 *   once if an error was already collected, (b) resolves at once when the
 *   'listening' event has already been emitted - without that already-fired
 *   guard the promise would never settle and the test would burn the 20 s
 *   safety bound - (c) rejects with a diagnostic when the server became ready
 *   but has since been closed, and otherwise (d) races `once('listening')`
 *   against `once('error')`, detaching both on every settle path.
 *
 *   The already-fired guard is a captured EVENT FLAG, not `server.listening`,
 *   and the distinction is load-bearing. Measured on Node 24.18.1 for
 *   `listen(port, host, cb)`: synchronously after `listen()` the server is not
 *   yet listening; one tick later `server.listening` is ALREADY TRUE while the
 *   'listening' event has still NOT been emitted; only on the tick after that
 *   does the event fire and the subject log its readiness line. Guarding on
 *   `server.listening` would therefore resolve inside that middle window and
 *   hand back an EMPTY `logs` array - reintroducing the very defect D5 exists
 *   to prevent. `server.listening` is still used where it is genuinely
 *   authoritative: distinguishing a closed server from a live one.
 *
 *   There is NO wall-clock synchronisation anywhere in this file: no timer of
 *   any kind, no sleep, no delay and no retry loop - every wait is an event
 *   subscription (standard S-2).
 *
 * CONTRACT D7 - snapshot at capture time, never a getter over mock state
 *   Observed defect: a lazy accessor reading a spy's recorded calls at
 *   assertion time failed under automatic mock clearing. `mock.calls[0][0]`,
 *   `mock.results[0].value` and `mock.calls.length` are therefore read ONCE,
 *   synchronously, immediately after the require; `logs` and `errors` are plain
 *   arrays pushed into from the listeners, never views over mock state.
 *
 * CONTRACT E1 - THE SINGLE MOST IMPORTANT LINE IN THIS FILE
 *   `server.js` registers NO 'error' listener, so a failed bind emits an
 *   unhandled 'error'. Reproduced as a real defect: without the listener below,
 *   `listen EADDRINUSE` surfaced as an uncaught exception, the test timed out,
 *   the blocker socket leaked as an open TCPSERVERWRAP, and Jest NEVER EXITED
 *   (killed after 600 s, exit 124). With it: exit 0, no open-handle warning,
 *   with three real loads in one file. It is attached SYNCHRONOUSLY, as soon as
 *   the instance exists and before the event loop can turn, because `listen()`
 *   reports failure asynchronously while `require()` returns synchronously -
 *   that gap is exactly what makes the failure deterministic.
 *   This is OBSERVATION, NOT REPAIR (standard S-11): the listener lives on the
 *   server instance inside this harness. Never "tidy" it into `server.js`, and
 *   never add `module.exports`, a `require.main` guard or a configurable port
 *   there either. The canonical testability refactor requires explicit user
 *   approval and must not be executed.
 *
 * THE INDEX TRAP - create any blocker BEFORE the harness, or with net.createServer
 *   `mock.calls[0]` and `mock.results[0]` must belong to the SUBJECT's
 *   `createServer` call. The deterministic EADDRINUSE scenario needs a blocker
 *   pre-bound to 127.0.0.1:3000; if that blocker went through the spied factory
 *   first, index 0 would be the blocker's and every snapshot would be wrong.
 *   Create the blocker BEFORE calling `loadServer()`, or create it with
 *   `net.createServer` so it never touches `http.createServer` at all. As
 *   belt-and-braces this harness also clears the spy's recorded calls
 *   immediately before the require, so index 0 is the current subject load even
 *   if a spy from an earlier, un-torn-down load was reused.
 *
 * TEARDOWN
 *   `teardown()` is async, idempotent and meant for an UNCONDITIONAL path
 *   (`afterEach`, or a `finally`), so it runs even when assertions fail. It
 *   closes the server ONLY when `server.listening` is true, which is
 *   deliberate: after a failed bind, or after the tier has already called
 *   `close()` itself, the server is not listening and a second `close()` yields
 *   ERR_SERVER_NOT_RUNNING - a value the bootstrap tier asserts on purpose and
 *   which teardown must not pre-empt. It detaches only the listeners this
 *   harness attached, and does so by reference - never by bulk-clearing an
 *   event's listener list, which would also strip the subject's own `listen`
 *   callback and anything the test attached. Forcing the runner to exit is
 *   forbidden (standard S-3): leaked handles are fixed here, at the source,
 *   because that flag would mask the exact defect this discipline exists to
 *   catch.
 *
 * Requiring this module has NO side effects: no spy is installed, no module is
 * loaded, no socket is bound and no timer is started until `loadServer()` runs.
 * There is no module-level mutable state (standard S-4), so any single test
 * passes when selected alone by name. Each load must be torn down before the
 * next one, or the second bind hits EADDRINUSE on the still-occupied port.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

/**
 * Absolute path to the subject under test.
 *
 * Resolved from the runner root rather than from this file's own location, so
 * that no test's behaviour depends on its depth in the `test/` tree and files
 * can be reorganised without rewriting requires. `jest.config.js` declares no
 * `rootDir`, so `rootDir` is the repository root, and npm scripts run from the
 * package root - therefore `process.cwd()` is the runner root.
 *
 * This is the only module-scope binding besides the requires, and it is
 * immutable: evaluating it neither loads the subject nor touches the network.
 */
const SUBJECT = path.resolve(process.cwd(), 'server.js');

/**
 * Loads `server.js` for real through a call-through spy and returns a snapshot
 * of everything the bootstrap tier needs to assert against.
 *
 * Synchronous by design: the bind is dispatched but not yet complete when this
 * returns, which is precisely the window contract E1 exists to protect and
 * contract D5 exists to sequence. Callers that want a bound server should use
 * `loadServerReady()` or `await ready()`.
 *
 * @returns {object} the snapshot object documented in the file header.
 * @throws {Error} if the subject cannot be found at the resolved path, or if
 *   loading it did not produce a usable `http.Server` through the spied
 *   factory. Both are loud drift alarms: a descriptive throw beats an
 *   `undefined` dereference several assertions later.
 */
function loadServer() {
  // Fail fast, and name the path, when the harness is run from the wrong
  // working directory. Without this the failure would surface as an opaque
  // MODULE_NOT_FOUND from deep inside Jest's resolver.
  if (!fs.existsSync(SUBJECT)) {
    throw new Error(
      'loadServer(): the subject under test was not found at ' + SUBJECT + '. ' +
        'This harness resolves server.js from process.cwd(), so it must be run ' +
        'with the repository root as the working directory (npm scripts do ' +
        'exactly that).'
    );
  }

  // Contract D7: `logs` is a PLAIN array populated by the spy implementation at
  // capture time. It is never a getter over `logSpy.mock.calls`, because
  // `clearMocks`/`restoreMocks` wipe mock state between tests and reading it
  // lazily at assertion time was a reproduced failure.
  const logs = [];

  // Silencing console.log serves two purposes: it captures the readiness line -
  // the subject's sole observability surface - and it keeps the runner's output
  // clean (standard S-9). Multiple arguments are joined with a single space,
  // mirroring console.log's own default separator.
  const logSpy = jest.spyOn(console, 'log').mockImplementation(function (...args) {
    logs.push(args.join(' '));
  });

  // CALL-THROUGH: deliberately NO `mockImplementation` here. The real
  // `http.createServer` runs, a genuine `http.Server` is produced, and the
  // subject's require-time `listen()` performs a real bind. This single
  // omission is the whole difference from the stub-mode harness.
  const createServerSpy = jest.spyOn(http, 'createServer');

  // Index-trap belt-and-braces: `jest.spyOn` returns the EXISTING mock when the
  // method is already spied, so a load that was never torn down could leave
  // earlier calls on the record. Clearing here guarantees that index 0 below is
  // the call made by this load of the subject.
  createServerSpy.mockClear();

  // A genuinely fresh load every time, so repeated loads in one file are
  // independent (standard S-4).
  jest.resetModules();

  // Required by absolute path so Jest's transform - and therefore the Istanbul
  // instrumentation scoped to `server.js` - applies to the subject.
  const subjectExports = require(SUBJECT);

  // ---------------------------------------------------------------------------
  // Contract D7: snapshot the spy's recorded state ONCE, right now, before the
  // event loop turns and before automatic mock clearing can wipe it.
  // ---------------------------------------------------------------------------
  const createServerCalls = createServerSpy.mock.calls.length;
  if (createServerCalls === 0) {
    throw new Error(
      'loadServer(): loading ' + SUBJECT + ' did not call http.createServer. ' +
        'The subject is expected to create its server through that factory; ' +
        'this harness has no other way to reach the private instance.'
    );
  }

  const firstCreateServerResult = createServerSpy.mock.results[0];
  if (
    !firstCreateServerResult ||
    firstCreateServerResult.type !== 'return' ||
    !(firstCreateServerResult.value instanceof http.Server)
  ) {
    throw new Error(
      'loadServer(): the call-through spy did not record a real http.Server ' +
        'for ' + SUBJECT + '. Check that no stub-mode harness is installed on ' +
        'http.createServer, and that any blocker server was created before ' +
        'this call or with net.createServer (see the index trap in the file ' +
        'header).'
    );
  }
  const server = firstCreateServerResult.value;

  // ---------------------------------------------------------------------------
  // CONTRACT E1 - MANDATORY, SYNCHRONOUS, IMMEDIATELY AFTER require(SUBJECT).
  // No `await` may appear between the require above and this attachment.
  //
  // `server.js` registers no 'error' listener, so a failed bind would otherwise
  // be an uncaught exception: the test times out, the socket leaks as an open
  // TCPSERVERWRAP, and Jest never exits (measured: killed after 600 s, exit
  // 124). `listen()` reports failure asynchronously while `require()` returns
  // synchronously, so attaching here - before the loop turns - is both possible
  // and sufficient.
  //
  // Observing the gap from the harness is NOT a source repair (standard S-11).
  // Never move this listener into `server.js`.
  // ---------------------------------------------------------------------------
  const errors = [];
  const onError = function (err) {
    errors.push(err);
  };
  server.on('error', onError);

  const handler = createServerSpy.mock.calls[0][0];
  if (typeof handler !== 'function') {
    throw new Error(
      'loadServer(): http.createServer was called without a request listener ' +
        'while loading ' + SUBJECT + ', so there is no handler to capture.'
    );
  }

  // ---------------------------------------------------------------------------
  // Bind-outcome observation, also attached synchronously at load time.
  //
  // `server.listening` CANNOT stand in for these flags, and the difference is
  // the whole of contract D5. Measured on Node 24.18.1 for
  // `listen(port, host, cb)`:
  //
  //   synchronously after listen()  listening = false, 'listening' not emitted
  //   one tick later                listening = TRUE,  'listening' NOT emitted
  //   the tick after that           listening = true,  'listening' emitted
  //
  // The middle row is the trap: `server.listening` is already true while the
  // subject has still not run its `listen` callback, so resolving readiness on
  // it would hand back an EMPTY `logs` array - exactly the defect D5 exists to
  // prevent. These listeners are attached after the subject's own
  // `once('listening', cb)` (registered inside `listen()` during the require),
  // so by the time `listeningEventFired` flips, the readiness line has already
  // been captured.
  //
  // `closeEventFired` lets `bindSettled()` tell "the bind outcome has not
  // arrived yet" from "it has already been superseded", so teardown never
  // subscribes to an event that can no longer fire.
  // ---------------------------------------------------------------------------
  let listeningEventFired = false;
  let closeEventFired = false;

  const onListeningEvent = function () {
    listeningEventFired = true;
  };
  const onCloseEvent = function () {
    closeEventFired = true;
  };

  server.on('listening', onListeningEvent);
  server.on('close', onCloseEvent);

  // Every one-shot listener this harness adds beyond the E1 collector is
  // recorded here, so `teardown()` can detach anything that never fired. The
  // array is closure-local, so there is no module-level mutable state
  // (standard S-4).
  const transientListeners = [];

  /**
   * Adds a one-shot listener to the real server and remembers it.
   *
   * `once` detaches automatically when the event fires; `detachTransient`
   * below covers every other settle path, and `teardown()` sweeps the rest.
   *
   * @param {string} eventName the server event to subscribe to.
   * @param {Function} listener the listener to attach.
   * @returns {void}
   */
  function attachTransientOnce(eventName, listener) {
    transientListeners.push({ eventName: eventName, listener: listener });
    server.once(eventName, listener);
  }

  /**
   * Detaches one previously tracked listener, by reference.
   *
   * Removal is always by exact reference. Bulk-clearing an event's listener
   * list is deliberately never used: it would also silently strip listeners
   * the test itself - or the subject's own `listen` callback - had attached.
   *
   * @param {string} eventName the server event to unsubscribe from.
   * @param {Function} listener the exact listener reference to remove.
   * @returns {void}
   */
  function detachTransient(eventName, listener) {
    server.removeListener(eventName, listener);
    for (let index = transientListeners.length - 1; index >= 0; index -= 1) {
      const tracked = transientListeners[index];
      if (tracked.eventName === eventName && tracked.listener === listener) {
        transientListeners.splice(index, 1);
      }
    }
  }

  /**
   * Resolves once the real server is bound and the readiness line has been
   * logged; rejects if the bind fails instead.
   *
   * "Ready" means both halves of the contract hold: the 'listening' event has
   * been emitted (so the readiness line is captured) AND the server is still
   * bound. Contract D5. Four ordered paths, none of them timer-based
   * (standard S-2):
   *   1. an error has already been collected - 'listening' can never fire, so
   *      reject immediately rather than subscribing to a dead event;
   *   2. the event has fired and the server is still listening - resolve
   *      immediately rather than burning the 20 s safety bound. The first half
   *      of that test is the captured event flag and NOT `server.listening`,
   *      because `server.listening` turns true a whole tick before the event is
   *      emitted and would therefore resolve with an empty `logs` array; see
   *      the measurement recorded at the flag's declaration;
   *   3. the event has fired but the server is no longer listening - it was
   *      closed, or torn down, after becoming ready; reject with a diagnostic
   *      rather than reporting a socket that is gone;
   *   4. otherwise the bind is still in flight, so race 'listening' against
   *      'error', detaching both listeners on whichever path settles.
   *
   * The subject registers its own readiness callback via `listen(..., cb)`,
   * which Node stores as the FIRST 'listening' listener. Ours is therefore
   * always invoked after it, so `logs` already contains the readiness line by
   * the time this promise resolves.
   *
   * @returns {Promise<void>} resolves after 'listening', rejects with the bind
   *   error otherwise.
   */
  function ready() {
    return new Promise(function (resolve, reject) {
      if (errors.length > 0) {
        reject(errors[0]);
        return;
      }

      if (listeningEventFired && server.listening) {
        resolve();
        return;
      }

      if (listeningEventFired) {
        reject(
          new Error(
            'ready(): ' + SUBJECT + ' became ready but has since been closed, ' +
              'so it is no longer bound. Await ready() - or use ' +
              'loadServerReady() - before closing the server or calling ' +
              'teardown().'
          )
        );
        return;
      }

      const onListening = function () {
        detachTransient('listening', onListening);
        detachTransient('error', onReadyError);
        resolve();
      };

      const onReadyError = function (err) {
        detachTransient('listening', onListening);
        detachTransient('error', onReadyError);
        reject(err);
      };

      attachTransientOnce('listening', onListening);
      attachTransientOnce('error', onReadyError);
    });
  }

  /**
   * Resolves with the first 'error' the real server emits.
   *
   * Already-settled discipline, the same as contract D3: the collected array is
   * checked FIRST, so calling this after the error has already arrived resolves
   * immediately instead of hanging on an event that will never fire again.
   *
   * The E1 collector is attached with `on` before any listener added here, so
   * `errors` is guaranteed to be populated by the time this resolves.
   *
   * @returns {Promise<Error>} the first collected 'error' event payload.
   */
  function waitForError() {
    return new Promise(function (resolve) {
      if (errors.length > 0) {
        resolve(errors[0]);
        return;
      }

      const onFirstError = function (err) {
        detachTransient('error', onFirstError);
        resolve(err);
      };

      attachTransientOnce('error', onFirstError);
    });
  }

  /**
   * Resolves as soon as the require-time bind has settled - as 'listening', as
   * an 'error', or as a 'close' that pre-empted both.
   *
   * Exactly one of those three always arrives, so this can never hang; and when
   * the outcome has already been observed it resolves without subscribing at
   * all (the already-settled discipline of contract D3). Event-driven
   * throughout: nothing here polls or waits on the clock (standard S-2).
   *
   * @returns {Promise<void>} resolves once the bind outcome is known.
   */
  function bindSettled() {
    if (listeningEventFired || closeEventFired || errors.length > 0) {
      return Promise.resolve();
    }

    return new Promise(function (resolve) {
      const settle = function () {
        detachTransient('listening', onSettleListening);
        detachTransient('error', onSettleError);
        detachTransient('close', onSettleClose);
        resolve();
      };

      const onSettleListening = function () {
        settle();
      };
      const onSettleError = function () {
        settle();
      };
      const onSettleClose = function () {
        settle();
      };

      attachTransientOnce('listening', onSettleListening);
      attachTransientOnce('error', onSettleError);
      attachTransientOnce('close', onSettleClose);
    });
  }

  let tornDown = false;

  /**
   * Releases everything this harness acquired. Async, idempotent, and intended
   * for an unconditional path so it runs even when assertions fail
   * (standard S-3).
   *
   * The `server.listening` guard is deliberate: after a failed bind, or after
   * the tier has already closed the server itself, a second `close()` would
   * produce ERR_SERVER_NOT_RUNNING - which the bootstrap tier asserts on
   * purpose and teardown must not pre-empt.
   *
   * That guard is only leak-proof once the bind has settled, though. `listen()`
   * is dispatched by `require()` but completes on a later tick, so a test that
   * threw immediately after `loadServer()` can reach teardown while the socket
   * is still being bound - and closing on `server.listening` alone would then
   * skip the close and strand the listener that is about to appear. The bind
   * outcome is therefore awaited first, by event and never by timer.
   *
   * @returns {Promise<void>} resolves once the server is closed, every listener
   *   this harness attached is detached, and all mocks are restored.
   */
  async function teardown() {
    if (tornDown) {
      return;
    }
    tornDown = true;

    await bindSettled();

    if (server.listening) {
      // Drop any lingering keep-alive connection first, so a client socket the
      // test left open cannot delay - or indefinitely defer - the close.
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }

      await new Promise(function (resolve) {
        // The close callback's error argument is deliberately ignored: the
        // `listening` guard above makes ERR_SERVER_NOT_RUNNING unreachable, and
        // a throwing teardown would mask the real assertion failure that led
        // here.
        server.close(function () {
          resolve();
        });
      });
    }

    while (transientListeners.length > 0) {
      const tracked = transientListeners.pop();
      server.removeListener(tracked.eventName, tracked.listener);
    }

    // The three listeners this harness attached for the whole lifetime of the
    // load, removed by their exact references so nothing the test or the
    // subject registered is disturbed.
    server.removeListener('error', onError);
    server.removeListener('listening', onListeningEvent);
    server.removeListener('close', onCloseEvent);

    jest.restoreAllMocks();
  }

  return {
    handler: handler,
    server: server,
    createServerCalls: createServerCalls,
    logs: logs,
    errors: errors,
    subjectExports: subjectExports,
    subjectPath: SUBJECT,
    createServerSpy: createServerSpy,
    logSpy: logSpy,
    ready: ready,
    waitForError: waitForError,
    teardown: teardown
  };
}

/**
 * `loadServer()` followed by `await ready()` - the convenience the bootstrap
 * tier's happy path uses.
 *
 * When it resolves, the real server is bound to 127.0.0.1:3000 and `logs`
 * already holds exactly one entry: 'Server running at http://127.0.0.1:3000/'.
 *
 * On the failure path the load is unwound before the error is re-thrown, so a
 * caller that never received the snapshot can never strand a spy or a socket
 * (standard S-3). Use `loadServer()` plus `waitForError()` for the
 * deterministic EADDRINUSE scenario, where the tier needs the snapshot itself
 * in order to assert that `logs` stayed empty.
 *
 * @returns {Promise<object>} the same snapshot object `loadServer()` returns,
 *   with `logs` already populated.
 * @throws {Error} rejects with the bind error when the server cannot listen.
 */
async function loadServerReady() {
  const loaded = loadServer();

  try {
    await loaded.ready();
  } catch (readyError) {
    // A teardown problem is recorded on the bind error rather than replacing
    // it, so the real cause of the failure is never masked.
    try {
      await loaded.teardown();
    } catch (teardownError) {
      if (readyError && typeof readyError === 'object') {
        readyError.teardownError = teardownError;
      }
    }
    throw readyError;
  }

  return loaded;
}

module.exports = {
  loadServer: loadServer,
  loadServerReady: loadServerReady
};
