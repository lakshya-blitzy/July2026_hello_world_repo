'use strict';

/**
 * test/helpers/spawnServer.js - CHILD-PROCESS harness for the lifecycle tier (L5).
 *
 * PURPOSE  Runs the subject (`server.js`) as a genuine, separate operating-system process,
 *   so process-level behaviour invisible from inside the runner can be asserted on real
 *   exit codes, signals and stream bytes: default signal disposition, an uncaught bind
 *   conflict, cold start with zero packages installed, and restart determinism.
 *
 * SOLE CONSUMER  `test/e2e/lifecycle.test.js`, and nothing else. The three harnesses are
 *   deliberately non-overlapping - `captureHandler.js` serves the stub-mode tiers,
 *   `loadServer.js` serves the bootstrap tier (the only binder of 127.0.0.1:3000), and
 *   this file serves the lifecycle tier alone. Collapsing them into one general-purpose
 *   harness would reintroduce the fixed-port collision that contract D2 exists to prevent.
 *
 * EXPORTED SURFACE
 *   spawnServer(options?) -> handle          synchronous; throws on invalid input
 *     options.port        number, default 4311  four-digit integer; 3000 is rejected
 *     options.sourcePath  string, default path.resolve(process.cwd(), 'server.js')
 *   handle.child          the ChildProcess
 *   handle.port           the shifted port actually used (number)
 *   handle.dir            the freshly created system-temp directory
 *   handle.file           the generated port-shifted copy inside `dir`
 *   handle.readyLine      'Server running at http://127.0.0.1:<port>/'
 *   handle.ready          Promise; resolves at readiness, rejects if the child ends first
 *   handle.stdout()       accumulated child stdout, verbatim
 *   handle.stderr()       accumulated child stderr, verbatim
 *   handle.hasExited()    boolean
 *   handle.waitForExit()  Promise<{ code, signal }> - guarded, see contract D3
 *   handle.stop(signal)   Promise<{ code, signal }> - signal defaults to 'SIGTERM'
 *   handle.cleanup()      Promise<void> - idempotent and unconditional
 *   Requiring this module has no side effects: nothing is spawned, created or written
 *   until `spawnServer` is called, and no mutable state lives at module scope (S-4).
 *
 * DRIFT ALARM  The subject's port is a hard-coded literal with no override path, so the
 *   only way to move a child off 3000 is to rewrite that literal in a copy. The expected
 *   literal is `const port = 3000;`, occurring exactly once. If it is ever absent this
 *   helper THROWS, naming the literal and the resolved source path, instead of silently
 *   emitting a copy that still binds 3000 - turning future drift in the subject's shape
 *   into an immediate, legible failure. No regex fallback and no silent continue, by design.
 *
 * FOUR-DIGIT PORT RULE  Measured on this runtime, 'Server running at http://127.0.0.1:4311/'
 *   is 40 characters and 41 bytes once console.log appends its newline - byte-for-byte the
 *   length of the subject's own port-3000 banner. A three- or five-digit port would break
 *   the tier's 41-byte assertion, so the port must be an integer in 1000-9999; and 3000 is
 *   rejected outright because it belongs to `test/e2e/bootstrap.test.js` alone (S-5). A loud
 *   guard here prevents a mystifying failure two tiers away.
 *
 * GENERATED, NEVER COMMITTED  The shifted copy goes into a freshly created directory under
 *   the SYSTEM temp directory, one per spawn, removed unconditionally. Nothing is written
 *   inside the working tree, so no ignore rule is needed and no second copy of the subject
 *   can drift out of step with it. That directory holds no `package.json` and no
 *   `node_modules/`, which is what makes the cold-start scenario a genuine test - the
 *   subject's only import is the built-in `http` module.
 *
 * READINESS IS A STDOUT PATTERN MATCH, NEVER A SLEEP (S-2)  `ready` resolves the moment the
 *   accumulated stdout contains `readyLine`, and rejects if the child ends first - quoting
 *   the exit code, the signal and the captured stderr so a failed start fails legibly rather
 *   than running out the runner's safety bound. This file contains no timers of any kind and
 *   never synchronises on wall-clock time.
 *
 * CONTRACT E2 - DO NOT DELETE THE NO-OP `ready.catch`  The port-contention scenario
 *   legitimately never awaits `ready`, and its child ends before readiness, so that promise
 *   rejects unobserved; reproduced, this was a FATAL unhandled rejection that aborted an
 *   entire run. `ready.catch(() => {})` marks the promise handled WITHOUT converting the
 *   rejection into a resolution: callers that do await `ready` still see the failure in full.
 *
 * CONTRACT D3 - THE EXIT-AWAIT IS GUARDED  `waitForExit()` inspects the recorded terminal
 *   state BEFORE subscribing; subscribing to an event that had already fired once hung a
 *   scenario to the 20,003 ms safety bound, whereas guarded it resolves in ~0 ms. That state
 *   is recorded from both 'exit' and 'close', because a child that cannot be spawned emits
 *   'error' and 'close' but never 'exit' (verified on this runtime); an 'error' listener is
 *   always attached, since an unhandled 'error' event on a ChildProcess throws.
 *
 * CLEANUP IS IDEMPOTENT AND UNCONDITIONAL (S-3)  Intended for an `afterEach`/`finally` path
 *   so it runs even when assertions fail: it terminates a still-running child, awaits the
 *   guarded close so no pipe outlives the test, detaches every listener it attached by name
 *   (never in bulk), and removes the temp directory. A second call is harmless.
 *   The runner must never be told to exit early - that flag masks exactly the leaked-handle
 *   class this discipline exists to catch. The tier's post-run "no surviving listener" check
 *   depends on this being reliable, but belongs to the test file, which must filter on socket
 *   state and inspect both address families; this helper never shells out to external
 *   socket-inspection utilities, some of which are absent from this container.
 *
 * REPORT, DO NOT REPAIR (S-11)  The copy differs from the subject on exactly one line - the
 *   port literal. The subject registers no signal handler, so termination takes the default
 *   disposition (code null, signal 'SIGTERM'), and no 'error' listener, so a bind conflict is
 *   an uncaught exception producing a non-zero exit with an EADDRINUSE diagnostic on stderr
 *   and an empty stdout. Those gaps are asserted as current behaviour, never patched - not in
 *   the copy, and absolutely never in `server.js`. Streams are therefore returned verbatim,
 *   with no trimming, splitting or normalisation, so the tier can assert exact bytes (S-6).
 *
 * COVERAGE  A child process is a separate V8 instance, so nothing it executes reaches the
 *   in-process Istanbul counters. This helper contributes ZERO coverage; the enforcing 100%
 *   gate is satisfied by the real in-process load `test/helpers/loadServer.js` performs for
 *   the bootstrap tier.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * The exact substring rewritten in the generated copy. `server.js` contains the numeric
 * literal 3000 exactly once, on the line below, so a single literal replacement is
 * unambiguous and no pattern matching is needed.
 */
const PORT_LITERAL = 'const port = 3000;';

/** AAP-verified default: four digits, and not the bootstrap tier's reserved port. */
const DEFAULT_PORT = 4311;

/** Reserved for `test/e2e/bootstrap.test.js`, the sole binder of the subject's address. */
const RESERVED_PORT = 3000;

/** Four-digit bounds: any other width changes the readiness banner's byte length. */
const MIN_PORT = 1000;
const MAX_PORT = 9999;

/** The loopback address the subject binds - never 0.0.0.0. */
const LOOPBACK = '127.0.0.1';

/** Byte length of the readiness banner including the newline console.log appends. */
const READY_LINE_BYTES = 41;

/** Recognisable prefix so a stray temp directory is immediately diagnosable. */
const TEMP_DIR_PREFIX = 'hello-world-server-';

/** Basename of the generated copy; keeping it identical keeps diagnostics legible. */
const GENERATED_BASENAME = 'server.js';

/**
 * Resolve the default subject path from the runner root rather than from this file's own
 * location, so no caller's behaviour depends on its depth in the directory tree. The
 * runner declares no rootDir, so the current working directory is the repository root.
 *
 * @returns {string} absolute path to the subject under test
 */
function defaultSourcePath() {
  return path.resolve(process.cwd(), 'server.js');
}

/**
 * Generate a port-shifted copy of the subject, run it as a child process, and return a
 * handle for driving and observing it.
 *
 * @param {{ port?: number, sourcePath?: string }} [options]
 *   `port` - four-digit integer (1000-9999) other than 3000; defaults to 4311. Passing an
 *   explicit port is load-bearing: the port-contention scenario needs two children on the
 *   same port, and the restart-determinism scenario needs to re-spawn on the same port.
 *   `sourcePath` - absolute or relative path to the subject; defaults to the repository
 *   root's `server.js`. Overriding it is how the drift alarm is proven, by pointing at a
 *   modified copy inside a temp directory rather than by editing the subject.
 * @returns {object} the handle documented in this file's header
 * @throws {Error} if the port is invalid or reserved, if the source cannot be read, or if
 *   the expected port literal is absent (the drift alarm)
 */
function spawnServer(options) {
  if (options !== undefined && options !== null && typeof options !== 'object') {
    throw new Error(
      'spawnServer: options must be an object when provided, received ' + typeof options
    );
  }

  const opts = options || {};

  // ---------------------------------------------------------------------------------
  // Input validation. Both guards fail loudly and early, before anything is created.
  // ---------------------------------------------------------------------------------
  const port = opts.port === undefined || opts.port === null ? DEFAULT_PORT : opts.port;

  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(
      'spawnServer: port must be a four-digit integer between ' + MIN_PORT + ' and ' +
      MAX_PORT + ' so the readiness banner stays exactly ' + READY_LINE_BYTES +
      ' bytes; received ' + JSON.stringify(opts.port)
    );
  }

  if (port === RESERVED_PORT) {
    throw new Error(
      'spawnServer: port ' + RESERVED_PORT + ' is reserved for ' +
      'test/e2e/bootstrap.test.js, the only file permitted to bind the subject\'s own ' +
      'address; choose a different four-digit port'
    );
  }

  if (opts.sourcePath !== undefined && opts.sourcePath !== null &&
      typeof opts.sourcePath !== 'string') {
    throw new Error(
      'spawnServer: sourcePath must be a string when provided, received ' +
      typeof opts.sourcePath
    );
  }

  const sourcePath = opts.sourcePath ? path.resolve(opts.sourcePath) : defaultSourcePath();

  // ---------------------------------------------------------------------------------
  // Read the subject. It is REFERENCE ONLY and is never written to (standard S-1).
  // ---------------------------------------------------------------------------------
  let source;
  try {
    source = fs.readFileSync(sourcePath, 'utf8');
  } catch (readError) {
    throw new Error(
      'spawnServer: unable to read the subject at ' + sourcePath + ' (' +
      readError.message + ')',
      { cause: readError }
    );
  }

  // THE DRIFT ALARM. No regex fallback and no silent continue: if the subject's shape has
  // changed, fail here rather than producing a copy that still binds the reserved port.
  if (source.indexOf(PORT_LITERAL) === -1) {
    throw new Error(
      'spawnServer: expected literal "' + PORT_LITERAL + '" not found in ' + sourcePath +
      '; the subject\'s shape has drifted and this helper must be updated'
    );
  }

  // Exactly one occurrence, and `port` can never equal the literal's own value because
  // RESERVED_PORT is rejected above, so this replacement always takes effect. The port
  // literal is the ONLY difference between the copy and the subject (standard S-11).
  const shifted = source.replace(PORT_LITERAL, 'const port = ' + port + ';');

  // A fresh directory per spawn, under the SYSTEM temp directory - never the working tree.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_DIR_PREFIX));
  const file = path.join(dir, GENERATED_BASENAME);

  let child;
  try {
    fs.writeFileSync(file, shifted, 'utf8');

    // `process.execPath` is the current executable, so the child runs on exactly the same
    // runtime as the suite - no PATH lookup and no version drift. The environment is
    // inherited untouched and no extra runtime flags are passed, so the child executes the
    // copy precisely as `node server.js` would. stdin is explicitly not connected, which
    // keeps every path non-interactive and pipeline-safe (standard S-9).
    child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (startError) {
    // Unconditional teardown applies to the construction path too (standard S-3): leaving
    // an orphaned temp directory behind would violate the suite's hygiene guarantee.
    fs.rmSync(dir, { recursive: true, force: true });
    throw startError;
  }

  // ---------------------------------------------------------------------------------
  // Per-spawn state. All of it lives in this closure, so concurrent children cannot
  // interfere and any single test passes when selected alone by name (standard S-4).
  // ---------------------------------------------------------------------------------
  let out = '';
  let err = '';
  let exited = false;
  let closed = false;
  let exitCode;
  let exitSignal;
  let spawnError;

  function onStdout(chunk) {
    out += chunk;
  }

  function onStderr(chunk) {
    err += chunk;
  }

  function onExit(code, signal) {
    exited = true;
    exitCode = code;
    exitSignal = signal;
  }

  function onClose(code, signal) {
    closed = true;
    // A child that could not be spawned emits 'error' and 'close' but never 'exit', so
    // 'close' is the authoritative fallback for recording the terminal state. For a child
    // that did start, 'exit' has already run and these values are simply reconfirmed.
    if (!exited) {
      exited = true;
      exitCode = code;
      exitSignal = signal;
    }
  }

  function onError(error) {
    // A ChildProcess is an EventEmitter: an unhandled 'error' event throws and would take
    // the whole runner down. Recording it keeps the failure legible instead.
    spawnError = error;
  }

  // Registered BEFORE any await can be created, so the recorded terminal state is always
  // current by the time a guarded wait inspects it. Registration order also guarantees
  // these run before the readiness promise's own listeners for the same event.
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', onStdout);
  child.stderr.on('data', onStderr);
  child.on('exit', onExit);
  child.on('close', onClose);
  child.on('error', onError);

  // Composed from the same loopback constant and the port this helper actually generated,
  // mirroring how the subject composes its banner. Never imported from the fixture module.
  const readyLine = 'Server running at http://' + LOOPBACK + ':' + port + '/';

  /**
   * Build the diagnostic used when the child ends before it ever became ready.
   *
   * @returns {Error} a rejection carrying the recorded code, signal and captured stderr
   */
  function prematureEndError() {
    return new Error(
      'spawnServer: the child ended before readiness (code=' + exitCode + ', signal=' +
      exitSignal + ', spawnError=' + (spawnError ? spawnError.code || spawnError.message : 'none') +
      ', stderr=' + JSON.stringify(err) + ')'
    );
  }

  const ready = new Promise(function (resolve, reject) {
    let settled = false;

    // A single settle path, so every outcome removes every listener exactly once and no
    // subscription outlives the promise.
    function settle(error) {
      if (settled) {
        return;
      }
      settled = true;
      child.stdout.removeListener('data', onReadyData);
      child.removeListener('exit', onReadyEnd);
      child.removeListener('close', onReadyEnd);
      child.removeListener('error', onReadyError);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    }

    function onReadyData() {
      if (out.indexOf(readyLine) !== -1) {
        settle(null);
      }
    }

    function onReadyEnd() {
      settle(prematureEndError());
    }

    function onReadyError(error) {
      settle(new Error(
        'spawnServer: the child could not be spawned (' + error.message + ')',
        { cause: error }
      ));
    }

    // Output may already have arrived, and the child may already have ended, before this
    // promise was constructed; check the recorded state before subscribing to anything.
    if (out.indexOf(readyLine) !== -1) {
      settle(null);
      return;
    }
    if (exited) {
      settle(prematureEndError());
      return;
    }

    child.stdout.on('data', onReadyData);
    child.on('exit', onReadyEnd);
    child.on('close', onReadyEnd);
    child.on('error', onReadyError);
  });

  // CONTRACT E2 - DO NOT DELETE. The port-contention scenario legitimately never awaits
  // `ready`, and its child ends before readiness, so this promise rejects unobserved;
  // reproduced, that was a FATAL unhandled rejection which aborted the run. Attaching a
  // no-op handler marks THIS promise as handled without swallowing anything: the rejection
  // stays fully observable to any caller that does await `ready`.
  ready.catch(function () {});

  /**
   * Resolve once the child has ended, reporting its exit code and terminating signal.
   *
   * @returns {Promise<{ code: (number|null), signal: (string|null) }>}
   */
  function waitForExit() {
    // CONTRACT D3: treat "already ended" as already resolved. Subscribing to an event that
    // has already fired hung a scenario to the 20,003 ms safety bound; guarded, the same
    // scenario resolves in ~0 ms.
    if (exited) {
      return Promise.resolve({ code: exitCode, signal: exitSignal });
    }
    return new Promise(function (resolve) {
      let settled = false;

      function settleExit() {
        if (settled) {
          return;
        }
        settled = true;
        child.removeListener('exit', settleExit);
        child.removeListener('close', settleExit);
        // The recorded values are authoritative: `onExit`/`onClose` were registered first
        // and have therefore already run for this event.
        resolve({ code: exitCode, signal: exitSignal });
      }

      child.once('exit', settleExit);
      // 'close' is the safety net for a child that never emits 'exit' because it could not
      // be spawned at all; for a normal child 'exit' always arrives first.
      child.once('close', settleExit);
    });
  }

  /**
   * Resolve once the child has ended AND its stdio streams have closed, so no pipe
   * outlives the test. Internal: `cleanup` uses it to guarantee handle hygiene.
   *
   * @returns {Promise<{ code: (number|null), signal: (string|null) }>}
   */
  function waitForClose() {
    if (closed) {
      return Promise.resolve({ code: exitCode, signal: exitSignal });
    }
    return new Promise(function (resolve) {
      child.once('close', function () {
        resolve({ code: exitCode, signal: exitSignal });
      });
    });
  }

  /**
   * Signal the child and await its outcome in one step.
   *
   * @param {string} [signal] POSIX signal name; defaults to 'SIGTERM'
   * @returns {Promise<{ code: (number|null), signal: (string|null) }>}
   */
  function stop(signal) {
    // Signalling an already-ended child is a harmless no-op; the guard documents intent.
    if (!exited) {
      child.kill(signal || 'SIGTERM');
    }
    return waitForExit();
  }

  let cleaned = false;

  /**
   * Release everything this spawn acquired. Idempotent and unconditional - intended for an
   * `afterEach`/`finally` path so it runs even when assertions fail (standard S-3).
   *
   * @returns {Promise<void>}
   */
  async function cleanup() {
    if (cleaned) {
      return;
    }
    cleaned = true;

    if (!closed) {
      if (!exited) {
        child.kill('SIGTERM');
      }
      // Awaiting the close rather than merely the exit guarantees the stdio pipes are gone
      // as well as the process, which is what keeps open-handle detection quiet.
      await waitForClose();
    }

    // Detach by name only. Stripping every listener in bulk would also remove listeners a
    // caller attached for its own assertions.
    child.stdout.removeListener('data', onStdout);
    child.stderr.removeListener('data', onStderr);
    child.removeListener('exit', onExit);
    child.removeListener('close', onClose);
    child.removeListener('error', onError);

    // `force: true` makes an already-removed directory a no-op rather than an error, so a
    // second cleanup, or cleanup after a manual removal, is always safe.
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return {
    child: child,
    port: port,
    dir: dir,
    file: file,
    readyLine: readyLine,
    ready: ready,
    // Accessor functions rather than snapshots: the accumulated text grows over the child's
    // lifetime and is returned verbatim, with no trimming or normalisation (standard S-6).
    stdout: function () {
      return out;
    },
    stderr: function () {
      return err;
    },
    hasExited: function () {
      return exited;
    },
    waitForExit: waitForExit,
    stop: stop,
    cleanup: cleanup
  };
}

module.exports = { spawnServer };
