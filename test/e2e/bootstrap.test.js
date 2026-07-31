'use strict';

/**
 * L4 BOOTSTRAP TIER - call-through mode, and the SOLE binder of 127.0.0.1:3000 (contract D2). Real
 * module loading stays confined to this file, so the call-through harness must not be imported
 * elsewhere and worker concurrency must not be raised while it lives in a test file. The port must
 * be free before this file runs: it is a hard-coded literal with no override path, every case
 * loads the subject afresh, and the unconditional teardown below releases it before the next bind.
 *
 * At least one case must serve a REAL request - the handler body is reachable no other way
 * in-process, and without it this tier reports 6 of 9 statements and 1 of 2 functions against the
 * enforcing 100% gate, which is never lowered. The child-process tier adds no in-process coverage.
 *
 * Readiness and bind failures are asynchronous relative to `require()`, and the runner clears mock
 * state between tests, so both are read from the harness's plain snapshots after the corresponding
 * event rather than from spy internals (contracts D5, D7). The blocker uses `net.createServer` so
 * it cannot displace the subject as the harness's first recorded call, and its bind failure is an
 * unhandled 'error' event because the subject registers none - current behaviour, asserted and not
 * repaired, which is also why forcing the runner to exit is forbidden.
 */

const fs = require('fs');
const http = require('http');
const net = require('net');
const nodeModule = require('module');
const { loadServer, loadServerReady } = require('../helpers/loadServer');
const httpClient = require('../helpers/httpClient');
const expected = require('../fixtures/expected');

// `console.log` appends this, so READY_BYTES counts one byte more than READY_LINE's own length.
const LOG_LINE_TERMINATOR = '\n';

const IPV4_FAMILY = 'IPv4';

// Realm-independent stand-in for `instanceof Error`: an error raised inside the runtime's
// internals is not an instance of the constructor in the context the runner evaluates this file
// in.
const ERROR_BRAND = '[object Error]';

const ONLY_SPECIFIER = 'http';

// Sentinels for the mock-ownership half of the interception case: the spy returning them belongs
// to the TEST, so the harness must leave it exactly as it found it.
const OWNED_BY_TEST = 'installed-by-the-test';
const NOT_SPIED = 'the-real-implementation';

/**
 * Every `require(...)` call in a source text, as the specifiers it names.
 *
 * Single-quoted literals only, matching the subject's style: a computed or double-quoted specifier
 * is deliberately invisible here and is caught instead by the total require-CALL count the
 * structural case asserts alongside this list.
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

// Both are module-scoped only so the unconditional teardown can reach them; every case assigns
// afresh and none reads what another left behind.
let loaded = null;
let blocker = null;

// A close error is surfaced rather than swallowed: a blocker still holding the fixed port would
// break every following case, and every following file, with a bind conflict.
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

// Unconditional teardown, so the fixed port is free again for the next case and the next file even
// after a failure. The two releases are attempted INDEPENDENTLY - a throw in the first is exactly
// how a blocker gets stranded on the port - and only the first failure is re-thrown, once both
// have run. The harness closes the subject's server only while it is still listening, which is
// what leaves the second-close error available for the shutdown case that asserts it.
afterEach(async () => {
  let firstFailure;

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

    expect(loaded.server.address()).toStrictEqual({
      address: expected.HOST,
      family: IPV4_FAMILY,
      port: expected.PORT
    });
    expect(loaded.server.listening).toBe(true);
  });

  test('creates exactly one HTTP server (F-001-RQ-001)', async () => {
    // A spy owned by the TEST, installed before the harness and still needed after it: this case
    // is also the regression guard for the harness restoring only the two spies it installed
    // itself.
    const target = {
      probe() {
        return NOT_SPIED;
      }
    };
    const targetSpy = jest.spyOn(target, 'probe').mockReturnValue(OWNED_BY_TEST);

    loaded = await loadServerReady();

    // A plain number snapshotted at load time, never a read of spy state (contract D7). One call
    // means one server: the subject creates no second listener and no fallback.
    expect(loaded.createServerCalls).toBe(1);
    expect(loaded.server).toBeInstanceOf(http.Server);
    expect(typeof loaded.handler).toBe('function');
    expect(loaded.handler.length).toBe(2);

    // Torn down MID-TEST on purpose: a blanket restore-all inside the harness would uninstall the
    // spy above before this case could use it again. The `afterEach` teardown is idempotent.
    await loaded.teardown();

    // The runner's automatic restoration cannot account for this: it runs at the start of the NEXT
    // test, so the console spy being gone is the harness's own doing.
    expect(jest.isMockFunction(console.log)).toBe(false);
    expect(jest.isMockFunction(target.probe)).toBe(true);
    expect(target.probe()).toBe(OWNED_BY_TEST);

    targetSpy.mockRestore();
    expect(target.probe()).toBe(NOT_SPIED);
  });

  test('logs exactly one readiness line after the listening event (F-004-RQ-001)', async () => {
    loaded = await loadServerReady();

    expect(loaded.logs.length).toBe(1);
    expect(loaded.logs[0]).toBe(expected.READY_LINE);

    // The frozen count describes the line as stdout receives it, hence the added terminator.
    expect(Buffer.byteLength(loaded.logs[0] + LOG_LINE_TERMINATOR)).toBe(expected.READY_BYTES);
  });

  test('composes the readiness banner from the same host and port constants (F-002-RQ-003, F-004-RQ-002)', async () => {
    loaded = await loadServerReady();

    const recomposedBanner =
      'Server running at http://' + expected.HOST + ':' + expected.PORT + '/';

    expect(loaded.logs[0]).toBe(recomposedBanner);
    expect(recomposedBanner).toBe(expected.READY_LINE);
  });

  test('serves a real HTTP request on the bound socket (F-003-RQ-001, F-003-RQ-003)', async () => {
    loaded = await loadServerReady();

    // The one case that drives traffic through the real socket, which executes the handler body
    // and takes this tier to full coverage. The client disables pooling, so it sees four header
    // keys rather than five - the complete set belongs to the L2 contract tier.
    const response = await httpClient.get(expected.PORT);

    expect(response.status).toBe(expected.STATUS);
    expect(response.body).toBe(expected.BODY);
    expect(Buffer.byteLength(response.body)).toBe(expected.BODY_BYTES);
    expect(response.headers['content-type']).toBe(expected.CONTENT_TYPE);
  });

  test('exposes no API and depends on nothing but one built-in module (F-005-RQ-001, F-005-RQ-003)', () => {
    // The synchronous variant is enough for a question about shape. Both halves of the claim go
    // through the path the harness resolved: re-requiring it returns the ALREADY CACHED object, so
    // no second bind happens - identity with the harness's snapshot is asserted first to prove it.
    loaded = loadServer();

    const subjectModule = require(loaded.subjectPath);

    expect(subjectModule).toBe(loaded.subjectExports);
    expect(Object.keys(subjectModule)).toStrictEqual([]);
    expect(Object.keys(subjectModule).length).toBe(0);
    expect(subjectModule.server).toBeUndefined();
    expect(subjectModule.handler).toBeUndefined();

    const source = fs.readFileSync(loaded.subjectPath, 'utf8');
    const specifiers = requireSpecifiers(source);

    expect(specifiers).toStrictEqual([ONLY_SPECIFIER]);
    expect(source.match(/\brequire\s*\(/g)).toHaveLength(1);
    expect(nodeModule.isBuiltin(specifiers[0])).toBe(true);
    expect(nodeModule.builtinModules).toContain(specifiers[0]);
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\bfrom\s+['"]/);
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
      // Left attached, so a later failure on the blocker is observed instead of escaping as an
      // uncaught exception; a rejection after this promise has settled is a no-op.
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

    // No banner: the callback that logs it never runs, so a failed start is silent on stdout. The
    // subject registers no 'error' listener - recorded here as current behaviour, not repaired.
    expect(loaded.errors.length).toBe(1);
    expect(loaded.logs.length).toBe(0);
    expect(loaded.server.listening).toBe(false);
  });
});
