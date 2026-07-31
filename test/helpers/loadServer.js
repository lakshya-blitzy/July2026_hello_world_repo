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
 *   127.0.0.1:3000 actually happens. The subject itself is only ever read,
 *   never edited.
 *
 * PORT PRECONDITION AND STRUCTURAL CONFINEMENT
 *   TCP 127.0.0.1:3000 must be FREE before `loadServer()` is called. The port
 *   is a hard-coded literal in the subject with no override path, and adding
 *   one here would change source behaviour. Because a real load occupies that
 *   port, only ONE test file may use this helper; every other test reaches the
 *   handler through the stub-mode harness on an ephemeral port, and the runner
 *   is pinned to a single worker by `maxWorkers: 1` in `jest.config.js`. Do not
 *   merge this helper with `captureHandler.js` or `spawnServer.js`, and do not
 *   add a stub mode here. Worker concurrency must not be raised while real
 *   loading lives in a test. Each load must be torn down before the next, or
 *   the second bind hits EADDRINUSE on the still-occupied port.
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
 *                        load; after `ready()` resolves it holds exactly
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
 * READINESS IS SEQUENCED ON THE 'listening' EVENT
 *   The readiness line is emitted from the `listen` callback and is therefore
 *   asynchronous relative to `require()`, so snapshotting immediately after
 *   load captures nothing. `ready()` therefore (a) rejects at once if an error
 *   was already collected, (b) resolves at once when the 'listening' event has
 *   already been emitted - without that already-fired guard the promise would
 *   never settle and the test would burn the whole timeout bound - (c) rejects
 *   with a diagnostic when the server became ready but has since been closed,
 *   and otherwise (d) races `once('listening')` against `once('error')`,
 *   detaching both on every settle path.
 *
 *   The already-fired guard is a captured EVENT FLAG, not `server.listening`,
 *   and the distinction is load-bearing: `server.listening` turns true a tick
 *   BEFORE the 'listening' event is emitted, so guarding on it would resolve
 *   inside that window and hand back an EMPTY `logs` array - the exact defect
 *   this sequencing exists to prevent. `server.listening` is still used where
 *   it is genuinely authoritative: distinguishing a closed server from a live
 *   one.
 *
 *   There is NO wall-clock synchronisation anywhere in this file: no timer of
 *   any kind, no sleep, no delay and no retry loop - every wait is an event
 *   subscription.
 *
 * SNAPSHOT AT CAPTURE TIME, NEVER A GETTER OVER MOCK STATE
 *   A lazy accessor reading a spy's recorded calls at assertion time fails
 *   under automatic mock clearing. `mock.calls[0][0]`,
 *   `mock.results[0].value` and `mock.calls.length` are therefore read ONCE,
 *   synchronously, immediately after the require; `logs` and `errors` are plain
 *   arrays pushed into from the listeners, never views over mock state.
 *
 * THE 'error' LISTENER IS MANDATORY AND MUST STAY SYNCHRONOUS
 *   `server.js` registers NO 'error' listener, so a failed bind emits an
 *   unhandled 'error'. Without the listener below, `listen EADDRINUSE` surfaces
 *   as an uncaught exception, the test times out, the blocker socket leaks as an
 *   open TCPSERVERWRAP, and the runner never exits. It is attached
 *   SYNCHRONOUSLY, as soon as the instance exists and before the event loop can
 *   turn, because `listen()` reports failure asynchronously while `require()`
 *   returns synchronously - that gap is exactly what makes the failure
 *   deterministic.
 *   This is OBSERVATION, NOT REPAIR: the listener lives on the
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
 * TRANSACTIONAL ACQUISITION - A FAILED LOAD LEAVES NOTHING BEHIND
 *   `teardown()` below can only release what a caller received, so a load that
 *   THROWS has to clean up after itself. Unguarded, two things go wrong: a
 *   snapshot-validation throw leaves `console.log` AND `http.createServer` still
 *   spied; and a throw arriving after the subject's require-time `listen()` has
 *   been dispatched additionally leaves an unowned listener on 127.0.0.1:3000 -
 *   a leaked handle that stops the runner exiting at all, the same symptom the
 *   mandatory 'error' listener above exists to prevent.
 *
 *   Every statement from the call-through spy to the final snapshot check
 *   therefore runs inside one try/catch. On any throw `rollbackAcquisition`
 *   restores the two EXACT spies by reference - not a blanket restore-all, so a
 *   spy the test installed for itself is untouched - and abandons any genuine
 *   `http.Server` the call-through spy returned: a swallowing 'error' listener
 *   goes on first, so a bind that fails with nobody watching cannot become an
 *   uncaught exception, and the socket is closed now if it exists or the instant
 *   it appears if the bind is still in flight. The ORIGINAL error is then
 *   rethrown untouched; a rollback failure is recorded as `.rollbackError` on it
 *   rather than replacing it, the same discipline `loadServerReady()` applies to
 *   a teardown failure. Ownership is respected throughout - a value some other
 *   stub produced was never this harness's to close.
 *
 *   The whole rollback is SYNCHRONOUS, which is what lets it coexist with the
 *   mandatory 'error' listener: it introduces no `await` anywhere between
 *   `require(SUBJECT)` and that listener's attachment.
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
 *   forbidden: leaked handles are fixed here, at the source,
 *   because that flag would mask the exact defect this discipline exists to
 *   catch.
 *
 *   MOCK OWNERSHIP obeys the same reference-specific discipline: teardown
 *   restores `createServerSpy` and `logSpy` - and nothing else - by calling
 *   `mockRestore()` on each, mirroring `rollbackAcquisition`. A blanket
 *   restore-all is forbidden here, because a bootstrap test may legitimately
 *   install a spy of its own, and wiping it from an `afterEach` - or from a
 *   mid-test teardown, which is supported - would remove it before that test's
 *   own assertions or cleanup could use it. This harness never touches a mock it
 *   did not install.
 *
 * Importing this module has no side effects: it loads only Node built-ins, and
 * installs no spy, loads no subject, binds no socket and starts no timer until
 * `loadServer()` is called. There is no module-level mutable state, so any
 * single test passes when selected alone by name. Each load must be torn down before the
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
 * Releases a real server this harness created but is not going to hand to anyone,
 * because acquisition failed after the server already existed.
 *
 * Synchronous by construction. Nothing here awaits, so it is safe to call from
 * the acquisition catch block without introducing a turn of the event loop
 * between the require and the 'error' listener's attachment.
 *
 * @param {import('http').Server} server the orphaned server instance.
 * @returns {void}
 */
function abandonServer(server) {
  // `server.js` registers no 'error' listener, so a bind that fails on a server
  // nobody owns would surface as an uncaught exception and take the runner down.
  // `on` rather than `once`, so a second error is swallowed as well.
  server.on('error', function () {});

  const closeNow = function () {
    // The close callback's error argument is deliberately ignored: this server is
    // being discarded, and a throwing rollback would mask the acquisition failure
    // that caused it.
    server.close(function () {});
  };

  if (server.listening) {
    closeNow();
    return;
  }

  // The bind is still in flight: `listen(port, host, cb)` resolves its host
  // through an asynchronous lookup, so `server.listening` is
  // still false synchronously after the subject's require-time call: closing right
  // now would do nothing except yield ERR_SERVER_NOT_RUNNING, and would then
  // strand the socket that appears a tick later. Closing the instant the socket
  // exists is what actually frees the port; event-driven, never timed.
  const onAbandonedListening = function () {
    server.removeListener('error', onAbandonedError);
    closeNow();
  };

  const onAbandonedError = function () {
    // The bind failed, so no socket was ever acquired and there is nothing to
    // close; stand the other one-shot listener down so neither outlives the load.
    server.removeListener('listening', onAbandonedListening);
  };

  server.once('listening', onAbandonedListening);
  server.once('error', onAbandonedError);

  // One visible consequence, by design: if the abandoned bind succeeds, the
  // subject's own readiness callback runs first - Node stores it as the FIRST
  // 'listening' listener - and by then `console.log` has been restored, so the
  // banner reaches the real console. That is accepted deliberately. Holding the
  // spy installed until an abandoned bind settled would leave `console.log`
  // replaced for an indeterminate time, which is the very defect this rollback
  // exists to remove; and detaching the subject's callback would mean bulk
  // listener removal, which this file never does. One stray line on a
  // failed-load path is strictly preferable to either.
}

/**
 * Undoes a failed acquisition completely and synchronously, so a load that threw
 * leaves the world exactly as it found it.
 *
 * Unguarded, a throw inside the acquisition region leaves `console.log` AND
 * `http.createServer` still spied; and when the throw arrives after the subject's
 * require-time `listen()` has been dispatched, it additionally leaves a real
 * listener on 127.0.0.1:3000 with no owner - a leaked handle that stops the runner
 * exiting at all. Both are fixed here rather than in each caller.
 *
 * Two ordering rules matter. The spy's recorded results are read BEFORE the spies
 * are restored, because `mockRestore()` resets that record and nothing would be
 * left to release. And ownership is respected: only a genuine `http.Server` that
 * the call-through spy actually returned is released, because a value produced by
 * some other stub was never this harness's to close.
 *
 * Never throws. Every step is attempted even if an earlier one failed, and the
 * first failure is RETURNED rather than raised, so the caller can rethrow the
 * original acquisition error untouched - the same discipline `loadServerReady()`
 * already applies to a teardown failure.
 *
 * @param {(object|undefined)} createServerSpy the call-through spy, if installed.
 * @param {object} logSpy the console.log spy.
 * @returns {(Error|undefined)} the first failure encountered, if any.
 */
function rollbackAcquisition(createServerSpy, logSpy) {
  let firstFailure;

  const attempt = function (step) {
    try {
      step();
    } catch (stepError) {
      if (firstFailure === undefined) {
        firstFailure = stepError;
      }
    }
  };

  const abandoned = [];

  if (createServerSpy) {
    attempt(function () {
      const results = createServerSpy.mock.results;
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        if (result && result.type === 'return' && result.value instanceof http.Server) {
          abandoned.push(result.value);
        }
      }
    });
  }

  // The EXACT spies this load installed, restored by reference. `mockRestore()` on
  // each one - rather than a blanket restore-all - keeps any spy the test installed
  // for its own purposes untouched.
  if (createServerSpy) {
    attempt(function () {
      createServerSpy.mockRestore();
    });
  }

  attempt(function () {
    logSpy.mockRestore();
  });

  for (let index = 0; index < abandoned.length; index += 1) {
    const orphan = abandoned[index];
    attempt(function () {
      abandonServer(orphan);
    });
  }

  return firstFailure;
}

/**
 * Loads `server.js` for real through a call-through spy and returns a snapshot
 * of everything the bootstrap tier needs to assert against.
 *
 * Synchronous by design: the bind is dispatched but not yet complete when this
 * returns, which is precisely the window the mandatory 'error' listener protects
 * and readiness sequencing resolves. Callers that want a bound server should use
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

  // `logs` is a PLAIN array populated by the spy implementation at capture time.
  // It is never a getter over `logSpy.mock.calls`, because `clearMocks`/
  // `restoreMocks` wipe mock state between tests, so reading it lazily at
  // assertion time finds nothing.
  const logs = [];

  // Silencing console.log serves two purposes: it captures the readiness line -
  // the subject's sole observability surface - and it keeps the runner's output
  // clean. Multiple arguments are joined with a single space,
  // mirroring console.log's own default separator.
  const logSpy = jest.spyOn(console, 'log').mockImplementation(function (...args) {
    logs.push(args.join(' '));
  });

  // ---------------------------------------------------------------------------
  // TRANSACTIONAL ACQUISITION.
  //
  // Everything from the call-through spy through the last snapshot check runs
  // inside one try/catch, because every statement in it can throw AFTER a spy is
  // installed and, in the worst case, after the subject's require-time `listen()`
  // has already dispatched a real bind. Unguarded, a snapshot-validation throw
  // leaves both spies installed, and a throw arriving after the bind was
  // dispatched additionally leaves an unowned listener on 127.0.0.1:3000 - a
  // leaked handle that stops the runner exiting. `rollbackAcquisition` undoes all
  // of it and the ORIGINAL error is rethrown untouched.
  //
  // The rollback is entirely SYNCHRONOUS, which is what keeps the mandatory
  // 'error' listener below intact: adding this safety net introduces no `await`
  // anywhere between
  // `require(SUBJECT)` and the error listener's attachment.
  //
  // `errors` and its collector are allocated before the block so the E1 listener
  // can be attached the instant the server exists, and `createServerSpy` is a
  // `let` so the catch can restore it even if the spy install itself failed.
  // ---------------------------------------------------------------------------
  const errors = [];
  const onError = function (err) {
    errors.push(err);
  };

  let createServerSpy;
  let subjectExports;
  let createServerCalls;
  let server;
  let handler;

  try {
    // CALL-THROUGH: deliberately NO `mockImplementation` here. The real
    // `http.createServer` runs, a genuine `http.Server` is produced, and the
    // subject's require-time `listen()` performs a real bind. This single
    // omission is the whole difference from the stub-mode harness.
    createServerSpy = jest.spyOn(http, 'createServer');

    // Index-trap belt-and-braces: `jest.spyOn` returns the EXISTING mock when the
    // method is already spied, so a load that was never torn down could leave
    // earlier calls on the record. Clearing here guarantees that index 0 below is
    // the call made by this load of the subject.
    createServerSpy.mockClear();

    // A genuinely fresh load every time, so repeated loads in one file are
    // independent.
    jest.resetModules();

    // Required by absolute path so Jest's transform - and therefore the Istanbul
    // instrumentation scoped to `server.js` - applies to the subject.
    subjectExports = require(SUBJECT);

    // -------------------------------------------------------------------------
    // Snapshot the spy's recorded state ONCE, right now, before the
    // event loop turns and before automatic mock clearing can wipe it.
    // -------------------------------------------------------------------------
    createServerCalls = createServerSpy.mock.calls.length;
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
    server = firstCreateServerResult.value;

    // MANDATORY, SYNCHRONOUS, IMMEDIATELY AFTER require(SUBJECT). No `await` may
    // appear between the require above and this attachment.
    //
    // `server.js` registers no 'error' listener, so a failed bind would otherwise
    // be an uncaught exception: the test times out, the socket leaks as an open
    // TCPSERVERWRAP, and the runner never exits. `listen()` reports failure
    // asynchronously while `require()` returns synchronously, so attaching here -
    // before the loop turns - is both possible and sufficient.
    //
    // Observing the gap from the harness is not a source repair. Never move this
    // listener into `server.js`.
    // -------------------------------------------------------------------------
    server.on('error', onError);

    handler = createServerSpy.mock.calls[0][0];
    if (typeof handler !== 'function') {
      throw new Error(
        'loadServer(): http.createServer was called without a request listener ' +
          'while loading ' + SUBJECT + ', so there is no handler to capture.'
      );
    }
  } catch (acquisitionError) {
    // Ownership was never returned to the caller, so this load owns the cleanup.
    // A rollback failure is recorded ON the acquisition error rather than
    // replacing it, mirroring how `loadServerReady()` records a teardown failure,
    // so the real cause is never masked.
    const rollbackError = rollbackAcquisition(createServerSpy, logSpy);
    if (rollbackError !== undefined && acquisitionError && typeof acquisitionError === 'object') {
      acquisitionError.rollbackError = rollbackError;
    }
    throw acquisitionError;
  }

  // ---------------------------------------------------------------------------
  // Bind-outcome observation, also attached synchronously at load time.
  //
  // `server.listening` CANNOT stand in for these flags, and the difference is
  // what makes readiness sequencing correct: for `listen(port, host, cb)`,
  // `server.listening` turns TRUE a tick BEFORE the 'listening' event is
  // emitted.
  //
  // That window is the trap: `server.listening` is already true while the
  // subject has still not run its `listen` callback, so resolving readiness on
  // it would hand back an EMPTY `logs` array. These listeners are attached
  // after the subject's own
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
  // array is closure-local, so there is no module-level mutable state.
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
   * bound. Four ordered paths, none of them timer-based:
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
   * Already-settled discipline: the collected array is checked FIRST, so calling
   * this after the error has already arrived resolves immediately instead of
   * hanging on an event that will never fire again.
   *
   * The bind-failure collector is attached with `on` before any listener added
   * here, so
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
   * all - the same already-settled discipline. Event-driven throughout: nothing
   * here polls or waits on the clock.
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
   *.
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
   * MOCK OWNERSHIP - only the two spies this load installed are restored, and
   * they are restored BY REFERENCE, exactly as `rollbackAcquisition` does on the
   * failed-acquisition path. A blanket restore-all is deliberately never used
   * here: it would also uninstall a spy the TEST owns - one it installed for its
   * own assertions - and, because this teardown is meant to be called from an
   * unconditional `afterEach` (or mid-test, since it is idempotent), that spy
   * would vanish before the test's own assertions or cleanup could use it. The
   * harness's non-interference contract is therefore reference-specific
   * throughout, on both the success and the failure path. Each restore is
   * attempted independently so a failure in one cannot skip the other, and
   * `mockRestore()` is idempotent, so the runner's own automatic restoration -
   * applied in a top-level `beforeEach`, i.e. at the START of the next test -
   * remains a harmless second layer rather than a conflicting one.
   *
   * @returns {Promise<void>} resolves once the server is closed, every listener
   *   this harness attached is detached, and the two spies this load owns are
   *   restored.
   */
  async function teardown() {
    if (tornDown) {
      return;
    }
    tornDown = true;

    await bindSettled();

    if (server.listening) {
      // ORDER IS LOAD-BEARING: `close()` FIRST, then force-close what is already
      // connected.
      //
      // `close()` stops the listener accepting anything new and completes once the
      // last connection has gone; `closeAllConnections()` drops the connections
      // that are still open, which is what stops a keep-alive socket a test left
      // behind from deferring that completion for the runtime's whole idle
      // timeout. Both are needed - but force-closing FIRST leaves a window in
      // which the listener is still accepting, so a connection can arrive between
      // the two calls and keep the server alive after all. Node's own guidance is
      // therefore to force-close only after the close has been requested, and that
      // is the order used here.
      //
      // `close()` is called synchronously inside the promise executor, so the
      // close is already requested before the next statement runs; awaiting the
      // promise afterwards is what makes teardown wait for completion.
      const closed = new Promise(function (resolve) {
        // The close callback's error argument is deliberately ignored: the
        // `listening` guard above makes ERR_SERVER_NOT_RUNNING unreachable, and
        // a throwing teardown would mask the real assertion failure that led
        // here.
        server.close(function () {
          resolve();
        });
      });

      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }

      await closed;
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

    // The EXACT two spies this load installed, restored by reference. Attempted
    // independently so a throw from one still lets the other come back out, and
    // the first failure is raised only after both attempts have been made - a
    // half-restored world is worse than a late error.
    let restoreFailure;

    try {
      createServerSpy.mockRestore();
    } catch (createServerRestoreError) {
      restoreFailure = createServerRestoreError;
    }

    try {
      logSpy.mockRestore();
    } catch (logRestoreError) {
      if (restoreFailure === undefined) {
        restoreFailure = logRestoreError;
      }
    }

    if (restoreFailure !== undefined) {
      throw restoreFailure;
    }
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
 * caller that never received the snapshot can never strand a spy or a socket.
 * Use `loadServer()` plus `waitForError()` for the
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
