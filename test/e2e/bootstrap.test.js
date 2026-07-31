'use strict';

/**
 * L4 BOOTSTRAP TIER - the subject's real bind, its readiness banner, and its shutdown semantics.
 *
 * CALL-THROUGH MODE, AND THE SOLE BINDER OF 127.0.0.1:3000 (contract D2). Every other tier reaches
 * the request handler through the stub harness on an ephemeral port; this is the one file that
 * loads `server.js` for real, which makes the suite's isolation structural rather than merely
 * configured by the runner's single-worker setting. The call-through harness must never be
 * imported elsewhere, and worker concurrency must not be raised while real loading lives here.
 *
 * PORT PRECONDITION: TCP 127.0.0.1:3000 must be FREE before this file runs, and is free again
 * after it. The port is a hard-coded literal in the subject with no override path, so there is
 * nothing to redirect. Every case loads the subject afresh and the unconditional teardown below
 * releases it before the next one, or the following bind would collide.
 *
 * COVERAGE MANDATE: at least one case must serve a REAL HTTP request while the server is
 * listening, because the handler body is reachable no other way from here. Without that case this
 * tier reports 6 of 9 statements and 1 of 2 functions, and the enforcing 100% gate fails the run;
 * with it the tier reaches 100% on all four metrics on its own. The sibling child-process tier
 * contributes no in-process coverage at all - its work happens in another V8 instance. The
 * threshold is never lowered, excluded or switched off to make a run pass.
 *
 * CONTRACT D5: the readiness banner is emitted from the subject's `listen` callback and is
 * therefore asynchronous relative to `require()` - captured output is EMPTY immediately after a
 * load. Every readiness assertion is sequenced after the 'listening' event through the harness's
 * async variant. Nothing here waits on the clock; the runner's timeout is a safety bound only.
 *
 * CONTRACT D7: the runner clears and restores mock state between tests, so a spy's recorded
 * invocations are already gone by assertion time. Assertions therefore read the harness's PLAIN
 * snapshots - `logs`, `createServerCalls`, `errors` - and never reach into spy internals.
 *
 * THE INDEX TRAP: the blocker that makes the bind-failure case deterministic is built with
 * `net.createServer`, so it never passes through the spied factory on the `http` module. Had it
 * gone through that factory first, the harness's first recorded call would be the blocker's and
 * every snapshot would describe the wrong server.
 *
 * REPORT, DO NOT REPAIR: `server.js` registers no 'error' listener, so a failed bind is an
 * unhandled 'error' event. The last case asserts that gap as CURRENT behaviour. The listener that
 * makes it observable belongs to the harness, on the server instance, and is never tidied into the
 * subject - which stays byte-identical. Forcibly terminating the runner is forbidden for the same
 * reason: a runner that will not exit is reporting a leak to be fixed on the teardown path below.
 */

const fs = require('fs');
const http = require('http');
const net = require('net');
const nodeModule = require('module');
const { loadServer, loadServerReady } = require('../helpers/loadServer');
const httpClient = require('../helpers/httpClient');
const expected = require('../fixtures/expected');

/**
 * The line terminator the logger appends to whatever it is handed.
 *
 * The frozen readiness line carries no newline of its own, while the frozen byte count describes
 * that line as it reaches stdout, terminator included - so the two differ by exactly this one
 * byte. Naming it here makes the difference explicit instead of looking like an off-by-one
 * waiting to be "corrected".
 *
 * @type {string}
 */
const LOG_LINE_TERMINATOR = '\n';

/**
 * The address family an IPv4 loopback bind reports through `address()`.
 *
 * Deliberately not a fixture value: it is a property of the runtime's socket bookkeeping rather
 * than of the subject, which names only a host and a port.
 *
 * @type {string}
 */
const IPV4_FAMILY = 'IPv4';

/**
 * The brand every Error carries, used in place of an `instanceof` check.
 *
 * The runner evaluates this file in a context of its own, so an error raised inside the runtime's
 * internals is not an instance of THIS realm's `Error` constructor even though it is unmistakably
 * an error - `instanceof` reports a mismatch between two constructors that both print as `Error`.
 * The brand is realm-independent and still an exact value, and it is the same technique the shared
 * HTTP client helper applies for the same reason.
 *
 * @type {string}
 */
const ERROR_BRAND = '[object Error]';

/**
 * The one module specifier the subject is permitted to name.
 *
 * Stated here rather than in the frozen fixture because it describes the subject's DEPENDENCY
 * SHAPE, not a value it puts on the wire, and this is the only tier that interrogates that shape.
 *
 * @type {string}
 */
const ONLY_SPECIFIER = 'http';

/**
 * Every `require(...)` call in a source text, as the specifiers it names.
 *
 * Single-quoted literals only, which is exactly what the subject's style uses: a dynamic or
 * computed specifier would deliberately NOT be matched here, and would instead be caught by the
 * total-call count the case below asserts alongside this list. Reading the file rather than
 * introspecting the loaded module is what makes this a statement about the subject's SHAPE, which
 * is unaffected by whichever registry the runner happens to load it through.
 *
 * @param {string} source The subject's source text.
 * @returns {string[]} The specifiers named by single-quoted require calls, in source order.
 */
function requireSpecifiers(source) {
  const specifiers = [];
  const pattern = /\brequire\(\s*'([^']*)'\s*\)/g;
  let match = pattern.exec(source);

  while (match !== null) {
    specifiers.push(match[1]);
    match = pattern.exec(source);
  }

  return specifiers;
}

/**
 * The harness snapshot owned by the case currently running, or `null` between cases.
 *
 * Module-scoped solely so the unconditional teardown can reach it. Every case assigns it afresh
 * and no case ever reads a value another left behind, so there is no shared mutable state and
 * each case passes when selected on its own.
 *
 * @type {?ReturnType<typeof loadServer>}
 */
let loaded = null;

/**
 * The pre-bound server that occupies the fixed port for the bind-failure case, or `null` when the
 * running case needs none. Built with `net.createServer` for the reason given in the file header.
 *
 * @type {?import('net').Server}
 */
let blocker = null;

/**
 * Releases the blocker, resolving once the runtime reports its socket closed.
 *
 * Event-driven: the promise settles on the close callback and never on an elapsed duration. A
 * close error is surfaced rather than swallowed, because a blocker that will not let go of the
 * fixed port would break every following case - and every following file - with a bind conflict.
 *
 * @param {import('net').Server} server The blocker to release.
 * @returns {Promise<void>} Resolves when the socket is closed.
 */
function closeBlocker(server) {
  return new Promise((resolve, reject) => {
    server.close((closeError) => {
      if (closeError) {
        reject(closeError);
        return;
      }
      resolve();
    });
  });
}

/**
 * Unconditional teardown: this runs after a FAILING case exactly as it does after a passing one,
 * which is what guarantees the fixed port is free again for the next case and the next file.
 *
 * The two releases are attempted INDEPENDENTLY, so a failure in the first can never skip the
 * second - that ordering defect is precisely how a blocker gets stranded on 127.0.0.1:3000 and
 * stops the runner exiting at all. Only the FIRST failure is re-thrown, and only once both steps
 * have run, so a teardown problem is reported without suppressing the release that still had to
 * happen.
 *
 * The harness's own teardown is idempotent and closes the subject's server only while it is still
 * listening. That guard is deliberate: the shutdown cases below close it themselves, and the
 * error a second close produces is a value one of them asserts on purpose.
 */
afterEach(async () => {
  let firstFailure;

  /**
   * Runs one release step to completion, remembering the first failure instead of raising it.
   *
   * @param {function(): Promise<void>} step The release to attempt.
   * @returns {Promise<void>} Always resolves.
   */
  const release = async (step) => {
    try {
      await step();
    } catch (stepError) {
      if (firstFailure === undefined) {
        firstFailure = stepError;
      }
    }
  };

  if (loaded) {
    await release(() => loaded.teardown());
    loaded = null;
  }

  if (blocker && blocker.listening) {
    await release(() => closeBlocker(blocker));
  }
  // A blocker whose bind never completed owns no socket, but its reference must not survive into
  // the next case either.
  blocker = null;

  if (firstFailure !== undefined) {
    throw firstFailure;
  }
});

describe('bootstrap (L4)', () => {
  test('binds 127.0.0.1:3000 at module load (F-002-RQ-001)', async () => {
    // The async variant resolves after the 'listening' event, so the bind is complete rather than
    // merely dispatched by the time the socket is interrogated (contract D5).
    loaded = await loadServerReady();

    // Asserted as a whole object: an extra or renamed field fails the case rather than slipping
    // past a field-by-field check. The host and port come from the fixture, which derives them
    // from the two constants in the subject.
    expect(loaded.server.address()).toStrictEqual({
      address: expected.HOST,
      family: IPV4_FAMILY,
      port: expected.PORT
    });
    expect(loaded.server.listening).toBe(true);
  });

  test('creates exactly one HTTP server (F-001-RQ-001)', async () => {
    loaded = await loadServerReady();

    // A plain number snapshotted at load time, never a read of spy state (contract D7). One call
    // means one server: the subject creates no second listener and no fallback.
    expect(loaded.createServerCalls).toBe(1);

    // Call-through mode, so the factory produced a genuine runtime server rather than a stand-in.
    expect(loaded.server).toBeInstanceOf(http.Server);

    // The captured request listener: a two-parameter function, matching the (req, res) contract
    // the runtime invokes it with.
    expect(typeof loaded.handler).toBe('function');
    expect(loaded.handler.length).toBe(2);
  });

  test('logs exactly one readiness line after the listening event (F-004-RQ-001)', async () => {
    loaded = await loadServerReady();

    // Exactly one line: the readiness banner is the subject's entire observability surface, so a
    // second line would mean output it does not have.
    expect(loaded.logs.length).toBe(1);
    expect(loaded.logs[0]).toBe(expected.READY_LINE);

    // The frozen byte count describes the line as stdout receives it, so the logger's terminator
    // is added here rather than the count being reduced to the string's own length.
    expect(Buffer.byteLength(loaded.logs[0] + LOG_LINE_TERMINATOR)).toBe(expected.READY_BYTES);
  });

  test('composes the readiness banner from the same host and port constants (F-002-RQ-003, F-004-RQ-002)', async () => {
    loaded = await loadServerReady();

    // Recomposed from the very values the bind was asserted against, so the banner is shown to be
    // built from the subject's two constants rather than from an independent copy of the address.
    // There is no override path: nothing but those constants can change either of them.
    const recomposedBanner =
      'Server running at http://' + expected.HOST + ':' + expected.PORT + '/';

    expect(loaded.logs[0]).toBe(recomposedBanner);

    // Closing the loop: the recomposition and the frozen line agree, so neither can drift alone.
    expect(recomposedBanner).toBe(expected.READY_LINE);
  });

  test('serves a real HTTP request on the bound socket (F-003-RQ-001, F-003-RQ-003)', async () => {
    loaded = await loadServerReady();

    // The one case that drives traffic through the real socket, which is what executes the
    // handler body and takes this tier to full coverage. The client disables pooling, so no
    // keep-alive socket survives the case; the cost is a response carrying four header keys
    // instead of five, which is why the complete header set belongs to the L2 contract tier and
    // is deliberately not asserted here.
    const response = await httpClient.get(expected.PORT);

    expect(response.status).toBe(expected.STATUS);
    expect(response.body).toBe(expected.BODY);
    expect(Buffer.byteLength(response.body)).toBe(expected.BODY_BYTES);

    // The one header the subject sets itself, reported in the runtime's lowercase form. No
    // charset parameter: the fixture holds the media type exactly as the subject writes it.
    expect(response.headers['content-type']).toBe(expected.CONTENT_TYPE);
  });

  test('exposes no API from the loaded module (F-005-RQ-003)', () => {
    // The synchronous variant is enough: the exports object exists as soon as the module has been
    // evaluated, and the teardown path waits for the bind to settle before releasing it.
    loaded = loadServer();

    // Re-reading the subject through the absolute path the harness used returns the ALREADY
    // CACHED module object, so this triggers no second evaluation and therefore no second bind.
    // Identity with the harness's own snapshot is the proof of that, and it is asserted before
    // anything is read off the object.
    const subjectModule = require(loaded.subjectPath);

    expect(subjectModule).toBe(loaded.subjectExports);

    // Zero own keys: the subject declares no exports at all, so loading it is a side effect and
    // nothing more. The two properties a consumer would most plausibly reach for are named
    // explicitly, because an absent API is easier to trust when the absence is demonstrated.
    expect(Object.keys(subjectModule)).toStrictEqual([]);
    expect(Object.keys(subjectModule).length).toBe(0);
    expect(subjectModule.server).toBeUndefined();
    expect(subjectModule.handler).toBeUndefined();
  });

  test('depends on nothing but a single built-in module (F-005-RQ-001)', () => {
    // Loaded first, and deliberately: reading the file the harness itself resolved is what ties
    // this structural claim to the module that actually ran, rather than to a path restated here
    // and hoped to be the same one.
    loaded = loadServer();

    const source = fs.readFileSync(loaded.subjectPath, 'utf8');
    const specifiers = requireSpecifiers(source);

    // Exactly one require, and it names the built-in HTTP module. Asserted as the COMPLETE list,
    // so a second import fails the case instead of slipping past a check for the first one.
    expect(specifiers).toStrictEqual([ONLY_SPECIFIER]);

    // The total number of require CALLS is counted separately from the specifiers extracted above,
    // because a computed or double-quoted specifier would be invisible to the extraction while
    // still being a dependency. The two counts agreeing is what closes that gap.
    expect(source.match(/\brequire\s*\(/g)).toHaveLength(1);

    // Built-in, so nothing has to be installed for the subject to resolve it - which is the
    // property that lets the application run from a bare checkout at all.
    expect(nodeModule.isBuiltin(specifiers[0])).toBe(true);
    expect(nodeModule.builtinModules).toContain(specifiers[0]);

    // No second module system either: an ESM import declaration or a dynamic import would be a
    // dependency the require count above could never see.
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\bfrom\s+['"]/);

    // The intercepted factory is the one this specifier resolves to, so the single built-in the
    // source names is demonstrably the module the subject actually used.
    expect(loaded.createServerCalls).toBe(1);
  });

  test('emits close when the server is closed (F-002-RQ-005)', async () => {
    loaded = await loadServerReady();

    // Subscribed BEFORE the close is requested, so the event cannot be missed, and awaited as an
    // event rather than after an interval: had it never fired, the case would exhaust the
    // runner's safety bound instead of passing on a lucky delay.
    const closeEvent = new Promise((resolve) => {
      loaded.server.once('close', () => {
        resolve(true);
      });
    });

    loaded.server.close();

    await expect(closeEvent).resolves.toBe(true);

    // The socket is genuinely gone, not merely closing.
    expect(loaded.server.listening).toBe(false);
  });

  test('refuses connections after shutdown (F-002-RQ-005)', async () => {
    loaded = await loadServerReady();

    await new Promise((resolve, reject) => {
      loaded.server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve();
      });
    });

    // The client surfaces the runtime's own error unwrapped, so the refusal is asserted by its
    // exact code rather than by the shape of a message.
    await expect(httpClient.get(expected.PORT)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  test('reports ERR_SERVER_NOT_RUNNING on a second close (F-002-RQ-005)', async () => {
    loaded = await loadServerReady();

    await new Promise((resolve, reject) => {
      loaded.server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve();
      });
    });

    // The second close reports through its callback rather than throwing, so the error is
    // captured from there. The harness's teardown skips closing a server that is no longer
    // listening, which is what keeps this observation available to be made here.
    const secondCloseError = await new Promise((resolve) => {
      loaded.server.close((closeError) => {
        resolve(closeError);
      });
    });

    expect(Object.prototype.toString.call(secondCloseError)).toBe(ERROR_BRAND);
    expect(secondCloseError.code).toBe('ERR_SERVER_NOT_RUNNING');
    expect(secondCloseError.name).toBe('Error');
  });

  test('emits EADDRINUSE and logs no banner when the port is already bound (F-002-RQ-004)', async () => {
    // Built with `net.createServer` so it never touches the spied factory on the `http` module
    // and cannot displace the subject as the harness's first recorded call.
    blocker = net.createServer();

    await new Promise((resolve, reject) => {
      // Attached with `on` and left attached: a later failure on the blocker is then observed
      // instead of escaping as an uncaught exception, and a rejection after this promise has
      // settled is simply a no-op.
      blocker.on('error', reject);
      blocker.listen(expected.PORT, expected.HOST, resolve);
    });

    // Pre-binding is complete before the subject is loaded, which is what makes the conflict
    // certain on every run rather than a race that usually happens to occur.
    expect(blocker.listening).toBe(true);

    // The SYNCHRONOUS variant on purpose: the async one awaits readiness and would reject with
    // the bind error, leaving no snapshot to interrogate. The bind is dispatched during the load
    // and fails on a later turn, which is exactly the window this case observes.
    loaded = loadServer();

    // Resolves from the harness's collected errors when the event has already arrived, so this
    // completes in milliseconds instead of subscribing to something that can no longer fire.
    const bindError = await loaded.waitForError();

    expect(Object.prototype.toString.call(bindError)).toBe(ERROR_BRAND);
    expect(bindError.code).toBe('EADDRINUSE');

    // Exactly one failure, and no readiness banner: the callback that logs it never runs, so a
    // failed start is silent on stdout. The subject registers no 'error' listener of its own -
    // that gap is recorded here as current behaviour and is not repaired.
    expect(loaded.errors.length).toBe(1);
    expect(loaded.logs.length).toBe(0);
    expect(loaded.server.listening).toBe(false);
  });
});
