'use strict';

/**
 * test/helpers/spawnServer.js - CHILD-PROCESS harness for the lifecycle tier (L5).
 *
 * PURPOSE  Runs the subject (`server.js`) as a genuine, separate operating-system process,
 *   so process-level behaviour invisible from inside the runner can be asserted on real
 *   exit codes, signals and stream bytes: default signal disposition, an uncaught bind
 *   conflict, cold start with zero packages installed, and restart determinism.
 *
 * DELIBERATELY SINGLE-PURPOSE  The three harnesses are non-overlapping - reaching the
 *   subject's handler in-process belongs to the stub-mode harness, loading the subject for
 *   real (the only binder of 127.0.0.1:3000) belongs to the call-through harness, and
 *   spawning it as a child process belongs here. Collapsing them into one general-purpose
 *   harness would reintroduce the fixed-port collision that keeping them apart prevents.
 *
 * EXPORTED SURFACE
 *   spawnServer(options?) -> handle          synchronous; throws on invalid input
 *     options.port            number, default 4311  four-digit integer; 3000 is rejected
 *     options.sourcePath      string, default path.resolve(process.cwd(), 'server.js');
 *                             DRIFT-VALIDATION ONLY when it is not the canonical subject
 *     options.maxStreamBytes  number, default 1048576  per-stream retention ceiling
 *   handle.child          the ChildProcess
 *   handle.port           the shifted port actually used (number)
 *   handle.dir            the freshly created system-temp directory
 *   handle.file           the generated port-shifted copy inside `dir`
 *   handle.readyLine      'Server running at http://127.0.0.1:<port>/'
 *   handle.ready          Promise; resolves at readiness, rejects if the child ends first
 *   handle.stdout()       accumulated child stdout, verbatim up to the retention ceiling
 *   handle.stderr()       accumulated child stderr, verbatim up to the retention ceiling
 *   handle.stdoutBytes()  total stdout bytes SEEN, which exceeds the retained length on overflow
 *   handle.stderrBytes()  total stderr bytes SEEN, which exceeds the retained length on overflow
 *   handle.overflowError() the Error recorded if either ceiling was reached, else undefined
 *   handle.hasExited()    boolean
 *   handle.waitForExit()  Promise<{ code, signal }> - guarded; see the exit-await note below
 *   handle.stop(signal)   Promise<{ code, signal }> - signal defaults to 'SIGTERM'
 *   handle.cleanup()      Promise<void> - idempotent and unconditional
 *   Requiring this module has no side effects: nothing is spawned, created or written
 *   until `spawnServer` is called, and no mutable state lives at module scope.
 *
 * ONLY THE CANONICAL SUBJECT IS EVER EXECUTED  Generating a copy means reading a file,
 *   rewriting it and handing it to a fresh Node process, so the source path is a genuine
 *   trust boundary rather than a convenience: whatever it names becomes executable child
 *   code. With only a substring test for a gate, a forged occurrence inside a comment is
 *   enough for a caller-supplied path outside the repository to be read, rewritten, written
 *   and RUN, letting arbitrary child code write files and read the inherited environment.
 *   Execution is therefore restricted to the canonical realpath of the repository's own
 *   `server.js`:
 *     1. the path is resolved, then `realpath`-ed, so symlink and `..` traversal collapse
 *        before any comparison is made;
 *     2. the target must be a REGULAR file, not a directory, device, FIFO or socket;
 *     3. its size must be plausible for the 342-byte subject, so a huge file cannot be
 *        slurped into the runner's heap merely to be rejected;
 *     4. its shape must pass the drift alarm below; and
 *     5. its realpath must equal the canonical subject's realpath - otherwise this helper
 *        THROWS, before the temp directory is created, before anything is written, and
 *        before anything is spawned.
 *   A non-canonical path is consequently drift-validation input and nothing more: it can
 *   prove the alarm fires, and it can never become a running process. The child's
 *   environment is still inherited untouched, which is deliberate - the cold-start scenario
 *   depends on the child running exactly as `node server.js` would, the subject reads no
 *   environment variable at all, and with arbitrary sources no longer executable there is no
 *   untrusted code left for an inherited environment to reach.
 *
 * DRIFT ALARM  The subject's port is a hard-coded literal with no override path, so the
 *   only way to move a child off 3000 is to rewrite that literal in a copy. The expected
 *   literal is `const port = 3000;` and BOTH of these must hold: it occurs exactly once in
 *   the whole file, and exactly one line consists of nothing else once trimmed. The first
 *   condition rejects a duplicate that a single literal replacement would leave behind still
 *   binding the reserved port; the second rejects a decoy inside a comment or a string, which
 *   a bare substring test accepts. The replacement is then applied to that one identified
 *   line rather than to the file as a whole, so the declaration - and only the declaration -
 *   is what changes. Any violation THROWS, naming the literal, the count and the resolved
 *   path, instead of silently emitting a copy that still binds 3000, turning future drift in
 *   the subject's shape into an immediate, legible failure. No regex fallback and no silent
 *   continue, by design.
 *
 * STREAM CEILINGS AND BOUNDED, REDACTED DIAGNOSTICS  A child's output arrives on pipes this
 *   helper owns, so an unbounded accumulator is the runner's memory: a chatty child can park
 *   megabytes in the stdout accumulator, and a failing start can reflect its whole stderr
 *   into a single Error message. Both accumulators are therefore capped at `maxStreamBytes`
 *   (1 MiB by default, counted with `Buffer.byteLength` rather than string length so
 *   multi-byte output counts honestly). On
 *   overflow the chunk is not appended, an Error is recorded for `overflowError()`, and the
 *   child is SIGKILLed to stop the flood at its source - SIGKILL rather than SIGTERM because
 *   a flooding child must not be able to decline. Total bytes seen keep being counted, so
 *   `stdoutBytes()`/`stderrBytes()` stay truthful even once retention has stopped. Every
 *   diagnostic that quotes the CHILD'S OWN OUTPUT reports a byte count plus a short prefix
 *   that is JSON-escaped and has host paths replaced with stable placeholders, so a rejection
 *   can neither flood a CI log nor disclose the machine's directory layout. The validation
 *   errors above are the deliberate exception: they name the caller's path in full, because
 *   that is precisely the information needed to correct the call, and none of them quote a
 *   single byte the child produced.
 *
 * FOUR-DIGIT PORT RULE  'Server running at http://127.0.0.1:4311/' is 40 characters and 41
 *   bytes once console.log appends its newline - byte-for-byte the length of the subject's
 *   own port-3000 banner. A three- or five-digit port would break a 41-byte assertion, so
 *   the port must be an integer in 1000-9999; and 3000 is rejected outright because it
 *   belongs to the one test that binds the subject's own address. A loud guard here prevents
 *   a mystifying failure elsewhere.
 *
 * GENERATED, NEVER COMMITTED  The shifted copy goes into a freshly created directory under
 *   the SYSTEM temp directory, one per spawn, removed unconditionally. Nothing is written
 *   inside the working tree, so no ignore rule is needed and no second copy of the subject
 *   can drift out of step with it. That directory holds no `package.json` and no
 *   `node_modules/`, which is what makes the cold-start scenario a genuine test - the
 *   subject's only import is the built-in `http` module.
 *
 * READINESS IS A STDOUT PATTERN MATCH, NEVER A SLEEP  `ready` resolves the moment the
 *   accumulated stdout contains `readyLine`, and rejects if the child ends first - quoting the
 *   exit code, the signal and a bounded summary of the captured stderr so a failed start fails
 *   legibly rather than running out the runner's safety bound. This file contains no timers of
 *   any kind and never synchronises on wall-clock time. Because readiness is detected in the
 *   retained text, a `maxStreamBytes` below the banner's own 41 bytes makes readiness
 *   unreachable by construction - which is why that case still fails fast and legibly, through
 *   the overflow kill and the resulting premature-end rejection, rather than silently waiting.
 *
 * DO NOT DELETE THE NO-OP `ready.catch`  The port-contention scenario legitimately never
 *   awaits `ready`, and its child ends before readiness, so that promise rejects unobserved -
 *   a FATAL unhandled rejection that aborts an entire run. `ready.catch(() => {})` marks the
 *   promise handled WITHOUT converting the rejection into a resolution: callers that do await
 *   `ready` still see the failure in full.
 *
 * THE EXIT-AWAIT IS GUARDED  `waitForExit()` inspects the recorded terminal state BEFORE
 *   subscribing, because subscribing to an event that has already fired hangs the scenario
 *   until the safety bound expires, whereas guarded it resolves at once. That state is
 *   recorded from both 'exit' and 'close', because a child that cannot be spawned emits
 *   'error' and 'close' but never 'exit'; an 'error' listener is always attached, since an
 *   unhandled 'error' event on a ChildProcess throws.
 *
 * CLEANUP IS IDEMPOTENT AND UNCONDITIONAL  Intended for an `afterEach`/`finally` path
 *   so it runs even when assertions fail: it terminates a still-running child, awaits the
 *   guarded close so no pipe outlives the test, detaches every listener it attached by name
 *   (never in bulk), and removes the temp directory. A second call is harmless.
 *   The runner must never be told to exit early - that flag masks exactly the leaked-handle
 *   class this discipline exists to catch. The tier's post-run "no surviving listener" check
 *   depends on this being reliable, but belongs to the test file, which must filter on socket
 *   state and inspect both address families; this helper never shells out to external
 *   socket-inspection utilities.
 *
 * REPORT, DO NOT REPAIR  The copy differs from the subject on exactly one line - the
 *   port literal. The subject registers no signal handler, so termination takes the default
 *   disposition (code null, signal 'SIGTERM'), and no 'error' listener, so a bind conflict is
 *   an uncaught exception producing a non-zero exit with an EADDRINUSE diagnostic on stderr
 *   and an empty stdout. Those gaps are asserted as current behaviour, never patched - not in
 *   the copy, and absolutely never in `server.js`. Streams are therefore returned verbatim,
 *   with no trimming, splitting or normalisation, so the tier can assert exact bytes.
 *   Truncation at the retention ceiling is the single exception, and it cannot affect any
 *   scenario: the subject emits 41 bytes in total, four orders of magnitude below the default
 *   ceiling, and reaching it is reported through `overflowError()` rather than passed off as
 *   a complete stream.
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
 * The exact declaration rewritten in the generated copy. `server.js` contains the numeric
 * literal 3000 exactly once, on a line of its own, so no pattern matching is needed - but a
 * bare substring test is not sufficient either, because it accepts a decoy in a comment or a
 * string. `analyseSourceShape` therefore requires one occurrence AND one whole-line match.
 */
const PORT_LITERAL = 'const port = 3000;';

const DEFAULT_PORT = 4311;

/** Reserved for the one test that binds the subject's own address. */
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
 * Upper bound on the size of a file this helper is willing to read. The subject is 342
 * bytes and a drift fixture is a handful of lines, so 64 KiB is generously permissive while
 * making it impossible for a caller to have a multi-gigabyte file slurped into the runner's
 * heap on the way to being rejected. Checked against the stat this helper already performs
 * for its regular-file test, so it costs no extra syscall.
 */
const MAX_SOURCE_BYTES = 65536;

/**
 * Per-stream retention ceiling. A child's pipes are owned by this process, so an unbounded
 * accumulator is the runner's memory; 1 MiB is four orders of magnitude above the subject's
 * 41-byte output and still small enough that hitting it is unambiguously pathological.
 */
const DEFAULT_MAX_STREAM_BYTES = 1048576;

/**
 * How much captured output a diagnostic may quote. Enough to identify an EADDRINUSE stack
 * frame, far too little to flood a CI log or to carry a large payload out of a child.
 */
const DIAGNOSTIC_PREFIX_CHARS = 200;

/**
 * Signal used to stop a child that has breached a retention ceiling. SIGKILL rather than
 * SIGTERM: the point is to halt the flood at its source, and a flooding child must not be
 * able to decline. This is the only place a signal is chosen for the caller.
 */
const OVERFLOW_SIGNAL = 'SIGKILL';

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
 * Replace host-specific absolute paths in a diagnostic with stable placeholders, longest
 * first so a shorter prefix cannot pre-empt a longer one. Literal `split`/`join` is used
 * rather than a regular expression so no path character needs escaping and no pattern can be
 * influenced by the text being redacted. A degenerate root-like path is skipped, because
 * replacing a single separator would mangle every path in the message.
 *
 * @param {string} text the raw diagnostic text
 * @param {string[]} extraPaths additional absolute paths to mask, e.g. the generated temp dir
 * @returns {string} the same text with host layout replaced by placeholders
 */
function redactHostPaths(text, extraPaths) {
  const candidates = [];

  function consider(candidatePath, placeholder) {
    if (typeof candidatePath !== 'string') {
      return;
    }
    const normalised = path.resolve(candidatePath);
    if (normalised.length < 2 || normalised === path.sep) {
      return;
    }
    candidates.push({ value: normalised, placeholder: placeholder });
  }

  (extraPaths || []).forEach(function (extraPath) {
    consider(extraPath, '<tmpdir>');
  });
  consider(process.cwd(), '<repo>');
  consider(os.homedir(), '<home>');
  consider(os.tmpdir(), '<tmp>');

  candidates.sort(function (left, right) {
    return right.value.length - left.value.length;
  });

  return candidates.reduce(function (accumulated, candidate) {
    return accumulated.split(candidate.value).join(candidate.placeholder);
  }, text);
}

/**
 * Render captured child output for inclusion in an Error message: report the true byte count,
 * then quote at most `DIAGNOSTIC_PREFIX_CHARS` characters, redacted and JSON-escaped so
 * newlines and control bytes cannot reformat a log line. Never returns the whole stream.
 *
 * @param {string} text the retained stream text
 * @param {number} totalBytes total bytes seen on that stream, which may exceed what is retained
 * @param {string[]} extraPaths additional absolute paths to mask
 * @returns {string} a bounded, redacted, escaped description
 */
function boundedStreamDescription(text, totalBytes, extraPaths) {
  const redacted = redactHostPaths(text, extraPaths);
  const truncated = redacted.length > DIAGNOSTIC_PREFIX_CHARS;
  const prefix = truncated ? redacted.slice(0, DIAGNOSTIC_PREFIX_CHARS) : redacted;
  return totalBytes + ' bytes, first ' + prefix.length + ' chars ' +
    JSON.stringify(prefix) + (truncated ? ' (truncated)' : '');
}

/**
 * Locate the subject's port declaration, insisting it is genuine rather than a decoy.
 *
 * A bare substring test accepts `// const port = 3000;` in a comment or the same text inside
 * a string, and accepts a duplicate that a single literal replacement would leave behind. Two
 * conditions therefore have to hold together: the literal occurs exactly once in the whole
 * file, and exactly one line consists of nothing but the literal once trimmed.
 *
 * @param {string} source the file contents
 * @returns {{ occurrences: number, declarationLines: number[], lines: string[] }}
 */
function analyseSourceShape(source) {
  let occurrences = 0;
  let searchFrom = 0;
  for (;;) {
    const found = source.indexOf(PORT_LITERAL, searchFrom);
    if (found === -1) {
      break;
    }
    occurrences += 1;
    searchFrom = found + PORT_LITERAL.length;
  }

  const lines = source.split('\n');
  const declarationLines = [];
  lines.forEach(function (line, index) {
    if (line.trim() === PORT_LITERAL) {
      declarationLines.push(index);
    }
  });

  return { occurrences: occurrences, declarationLines: declarationLines, lines: lines };
}

/**
 * Resolve, verify and read the source that may be turned into a running child.
 *
 * Every gate runs BEFORE the temp directory exists, so a rejected path leaves nothing behind
 * and, decisively, nothing is ever spawned from a source that is not the canonical subject.
 * The drift alarm is evaluated before the canonicality gate on purpose: that ordering is what
 * lets a caller prove the alarm fires by pointing at a deliberately malformed fixture, while
 * a well-formed non-canonical file is still refused execution.
 *
 * @param {(string|undefined)} requestedPath caller-supplied path, already type-checked
 * @returns {{ lines: string[], declarationLine: number }} the split source and the index of
 *   the one line holding the genuine port declaration
 * @throws {Error} if the path is unreadable, is not a regular file, is implausibly large,
 *   fails the drift alarm, or is not the canonical subject
 */
function resolveVerifiedSource(requestedPath) {
  const resolvedPath = requestedPath ? path.resolve(requestedPath) : defaultSourcePath();

  // `realpath` collapses symlinks and `..` segments, so the comparison below cannot be
  // defeated by a link or a traversal, and the error names the path the caller actually gave.
  let realPath;
  try {
    realPath = fs.realpathSync(resolvedPath);
  } catch (realPathError) {
    throw new Error(
      'spawnServer: unable to resolve the subject at ' + resolvedPath + ' (' +
      realPathError.message + ')',
      { cause: realPathError }
    );
  }

  let stats;
  try {
    stats = fs.statSync(realPath);
  } catch (statError) {
    throw new Error(
      'spawnServer: unable to stat the subject at ' + realPath + ' (' + statError.message + ')',
      { cause: statError }
    );
  }

  if (!stats.isFile()) {
    throw new Error(
      'spawnServer: the subject at ' + realPath + ' is not a regular file; a directory, ' +
      'device, FIFO or socket can never be a valid source for the generated copy'
    );
  }

  if (stats.size > MAX_SOURCE_BYTES) {
    throw new Error(
      'spawnServer: the subject at ' + realPath + ' is ' + stats.size + ' bytes, which ' +
      'exceeds the ' + MAX_SOURCE_BYTES + '-byte ceiling for a file this helper will read; ' +
      'the subject under test is 342 bytes'
    );
  }

  let source;
  try {
    source = fs.readFileSync(realPath, 'utf8');
  } catch (readError) {
    throw new Error(
      'spawnServer: unable to read the subject at ' + realPath + ' (' + readError.message + ')',
      { cause: readError }
    );
  }

  // THE DRIFT ALARM. No regex fallback and no silent continue: if the subject's shape has
  // changed, fail here rather than producing a copy that still binds the reserved port.
  const shape = analyseSourceShape(source);
  if (shape.occurrences !== 1 || shape.declarationLines.length !== 1) {
    throw new Error(
      'spawnServer: expected the literal "' + PORT_LITERAL + '" to occur exactly once in ' +
      realPath + ' and to be the entire content of exactly one line, but found ' +
      shape.occurrences + ' occurrence(s) and ' + shape.declarationLines.length +
      ' declaration line(s); the subject\'s shape has drifted, or the literal appears only ' +
      'inside a comment or string, and this helper must not generate a copy from it'
    );
  }

  // THE EXECUTION GATE. Only the repository's own subject may become a running child; a
  // well-formed file anywhere else is drift-validation input and is refused here, before the
  // temp directory is created, before anything is written and before anything is spawned.
  const canonicalPath = defaultSourcePath();
  let canonicalRealPath;
  try {
    canonicalRealPath = fs.realpathSync(canonicalPath);
  } catch (canonicalError) {
    throw new Error(
      'spawnServer: the canonical subject could not be resolved at ' + canonicalPath +
      '; this helper must be invoked with the repository root as the working directory (' +
      canonicalError.message + ')',
      { cause: canonicalError }
    );
  }

  if (realPath !== canonicalRealPath) {
    throw new Error(
      'spawnServer: refusing to generate an executable copy from ' + realPath +
      ' because it is not the canonical subject at ' + canonicalRealPath +
      '; a non-canonical sourcePath is accepted for drift validation only and is never spawned'
    );
  }

  return { lines: shape.lines, declarationLine: shape.declarationLines[0] };
}

/**
 * Generate a port-shifted copy of the subject, run it as a child process, and return a
 * handle for driving and observing it.
 *
 * @param {{ port?: number, sourcePath?: string, maxStreamBytes?: number }} [options]
 *   `port` - four-digit integer (1000-9999) other than 3000; defaults to 4311. Passing an
 *   explicit port is load-bearing: the port-contention scenario needs two children on the
 *   same port, and the restart-determinism scenario needs to re-spawn on the same port.
 *   `sourcePath` - absolute or relative path to the subject; defaults to the repository
 *   root's `server.js`. Overriding it is how the drift alarm is exercised, by pointing at a
 *   deliberately malformed fixture inside a temp directory rather than by editing the
 *   subject: the alarm is evaluated first, so a malformed fixture throws the drift error a
 *   caller wants to assert on. A well-formed non-canonical file is refused separately and is
 *   never spawned, so overriding this option can validate the alarm but can never run code.
 *   `maxStreamBytes` - positive integer retention ceiling applied to each of the child's two
 *   streams; defaults to 1048576. Reaching it stops retention, records `overflowError()` and
 *   SIGKILLs the child.
 * @returns {object} the handle documented in this file's header
 * @throws {Error} if the port is invalid or reserved, if `maxStreamBytes` is not a positive
 *   integer, if the source cannot be resolved or read, is not a regular file, is implausibly
 *   large, fails the drift alarm, or is not the canonical subject
 */
function spawnServer(options) {
  if (options !== undefined && options !== null && typeof options !== 'object') {
    throw new Error(
      'spawnServer: options must be an object when provided, received ' + typeof options
    );
  }

  const opts = options || {};

  // ---------------------------------------------------------------------------------
  // Input validation. Every guard fails loudly and early, before anything is created:
  // port range, reserved port, sourcePath type and emptiness, and the stream ceiling.
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

  // An empty string would otherwise fall through to the default and silently mask a caller
  // bug. Since this value selects what becomes executable child code, it is rejected outright.
  if (opts.sourcePath === '') {
    throw new Error(
      'spawnServer: sourcePath must be a non-empty string when provided; omit the option ' +
      'entirely to use the repository\'s own server.js'
    );
  }

  const maxStreamBytes = opts.maxStreamBytes === undefined || opts.maxStreamBytes === null
    ? DEFAULT_MAX_STREAM_BYTES
    : opts.maxStreamBytes;

  if (!Number.isInteger(maxStreamBytes) || maxStreamBytes <= 0) {
    throw new Error(
      'spawnServer: maxStreamBytes must be a positive integer when provided, received ' +
      JSON.stringify(opts.maxStreamBytes)
    );
  }

  // ---------------------------------------------------------------------------------
  // Resolve, verify and read the source. It is REFERENCE ONLY and is never written to.
  // Every gate inside this call - realpath, regular-file, size ceiling,
  // drift alarm, canonicality - runs before the temp directory exists, so only the
  // repository's own subject can ever reach the spawn below.
  // ---------------------------------------------------------------------------------
  const verified = resolveVerifiedSource(opts.sourcePath || undefined);

  // The replacement is applied to the ONE line the shape analysis identified as the genuine
  // declaration, not to the file as a whole, so no other occurrence of the text could be
  // rewritten even if the count check were ever relaxed. `port` can never equal the literal's
  // own value because RESERVED_PORT is rejected above, so the substitution always takes
  // effect. That line is the ONLY difference between the copy and the subject,
  // and rewriting it in place preserves any line ending the original used.
  const shiftedLines = verified.lines.slice();
  shiftedLines[verified.declarationLine] = shiftedLines[verified.declarationLine]
    .replace(PORT_LITERAL, 'const port = ' + port + ';');
  const shifted = shiftedLines.join('\n');

  // A fresh directory per spawn, under the SYSTEM temp directory - never the working tree.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_DIR_PREFIX));
  const file = path.join(dir, GENERATED_BASENAME);

  let child;
  try {
    fs.writeFileSync(file, shifted, 'utf8');

    // `process.execPath` is the current executable, so the child runs on exactly the same
    // runtime as the suite - no PATH lookup and no version drift. No shell is involved: the
    // arguments are an array, so nothing here is parsed by a command interpreter. The
    // environment is inherited untouched and no extra runtime flags are passed, so the child
    // executes the copy precisely as `node server.js` would - which is safe specifically
    // because `resolveVerifiedSource` has already established that this copy came from the
    // canonical subject and from nowhere else. stdin is explicitly not connected, which keeps
    // every path non-interactive and pipeline-safe.
    child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (startError) {
    // Unconditional teardown applies to the construction path too: leaving
    // an orphaned temp directory behind would violate the suite's hygiene guarantee.
    fs.rmSync(dir, { recursive: true, force: true });
    throw startError;
  }

  // ---------------------------------------------------------------------------------
  // Per-spawn state. All of it lives in this closure, so concurrent children cannot
  // interfere and any single test passes when selected alone by name.
  // ---------------------------------------------------------------------------------
  let out = '';
  let err = '';
  let outBytes = 0;
  let errBytes = 0;
  let exited = false;
  let closed = false;
  let exitCode;
  let exitSignal;
  let spawnError;
  let overflowError;

  /**
   * Record the first breach of a retention ceiling and stop the flood at its source. Only the
   * first breach is kept, because the first one is the diagnosis and every later one is noise.
   *
   * @param {string} streamName 'stdout' or 'stderr'
   * @param {number} totalBytes total bytes seen on that stream, including the rejected chunk
   */
  function recordOverflow(streamName, totalBytes) {
    if (overflowError) {
      return;
    }
    overflowError = new Error(
      'spawnServer: the child\'s ' + streamName + ' reached the ' + maxStreamBytes +
      '-byte retention ceiling after ' + totalBytes + ' bytes; retention stopped and the ' +
      'child was sent ' + OVERFLOW_SIGNAL + ' to halt the flood'
    );
    // Terminating the child is what makes the ceiling a bound rather than a suggestion: the
    // pipe would otherwise keep delivering chunks for as long as the child cared to write.
    if (!exited) {
      child.kill(OVERFLOW_SIGNAL);
    }
  }

  // A chunk is skipped whole rather than sliced to fit: byte-accurate slicing of a decoded
  // UTF-8 string risks cutting a multi-byte sequence in half, and a partial trailing chunk
  // adds nothing a byte count does not already say. Totals keep accruing after the ceiling is
  // reached, so `stdoutBytes()`/`stderrBytes()` remain truthful once retention has stopped.
  function onStdout(chunk) {
    const chunkBytes = Buffer.byteLength(chunk, 'utf8');
    outBytes += chunkBytes;
    if (outBytes > maxStreamBytes) {
      recordOverflow('stdout', outBytes);
      return;
    }
    out += chunk;
  }

  function onStderr(chunk) {
    const chunkBytes = Buffer.byteLength(chunk, 'utf8');
    errBytes += chunkBytes;
    if (errBytes > maxStreamBytes) {
      recordOverflow('stderr', errBytes);
      return;
    }
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
   * The captured stderr is summarised rather than reproduced verbatim: its true byte count
   * plus a short, host-path-redacted, JSON-escaped prefix. Reflecting the whole stream would
   * put an arbitrarily long message into a single Error, which floods a CI log and carries
   * whatever the child chose to print straight into it.
   *
   * @returns {Error} a rejection carrying the recorded code, signal and a bounded stderr summary
   */
  function prematureEndError() {
    return new Error(
      'spawnServer: the child ended before readiness (code=' + exitCode + ', signal=' +
      exitSignal + ', spawnError=' + (spawnError ? spawnError.code || spawnError.message : 'none') +
      (overflowError ? ', overflow=' + JSON.stringify(overflowError.message) : '') +
      ', stderr=' + boundedStreamDescription(err, errBytes, [dir]) + ')'
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

  // DO NOT DELETE. The port-contention scenario legitimately never awaits
  // `ready`, and its child ends before readiness, so this promise rejects unobserved;
  // unobserved, that is a FATAL unhandled rejection which aborts the run. Attaching a
  // no-op handler marks THIS promise as handled without swallowing anything: the rejection
  // stays fully observable to any caller that does await `ready`.
  ready.catch(function () {});

  /**
   * Resolve once the child has ended, reporting its exit code and terminating signal.
   *
   * @returns {Promise<{ code: (number|null), signal: (string|null) }>}
   */
  function waitForExit() {
    // Treat "already ended" as already resolved. Subscribing to an event that
    // has already fired hangs the scenario until the safety bound expires; guarded, the same
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
   * `afterEach`/`finally` path so it runs even when assertions fail.
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
    // lifetime and is returned verbatim, with no trimming or normalisation,
    // up to the retention ceiling. The byte-count accessors alongside them stay truthful even
    // once retention has stopped, so a truncated stream is never mistaken for a complete one.
    stdout: function () {
      return out;
    },
    stderr: function () {
      return err;
    },
    stdoutBytes: function () {
      return outBytes;
    },
    stderrBytes: function () {
      return errBytes;
    },
    overflowError: function () {
      return overflowError;
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
