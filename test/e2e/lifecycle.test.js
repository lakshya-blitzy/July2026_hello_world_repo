'use strict';

/**
 * L5 LIFECYCLE TIER - process-level behaviour, observable only from OUTSIDE the process.
 *
 * Every scenario spawns a harness-generated copy of `server.js` differing on one line - the port -
 * from a fresh temp directory, which is also the child's working directory: S1 asserts that rather
 * than assuming it, and it is not why the copy resolves its import, since `http` is built in and
 * no package lookup happens. The replacement port is four digits so the readiness banner stays
 * exactly READY_BYTES long, and every port is acquired by proof - a real listening bind accepted
 * it moments before, none is offered twice, and the two scenarios needing a conflict share one
 * explicitly.
 *
 * CONTRACT D2 - the subject is never loaded in-process here, so this file contributes ZERO
 * coverage and run alone reports 0% against the 100% gate, which is never lowered to accommodate
 * it; S6 needs a non-loopback IPv4 address and reports skipped without one, so counts are quoted
 * as declared. CONTRACT D3 - terminations go through `waitForExit()`/`waitForClose()`/`stop()`,
 * which read the recorded terminal state before subscribing, because subscribing after the fact
 * hung a scenario for the full safety bound; stream CONTENT is sequenced on close, never exit.
 * CONTRACT E2 - the contended child's readiness is never awaited, only its termination. Readiness
 * is a stdout pattern match, never a sleep (S-2); teardown is unconditional (S-3), tracked at
 * creation and released independently, so no child, pipe or directory outlives the case that made
 * it.
 *
 * Hygiene uses `probeBind`, a native bind rather than a shell-out to a socket utility that may be
 * absent; it filters on LISTENING for free, since TIME_WAIT does not block a fresh bind. ONLY
 * EADDRINUSE means a listener remains - a refusal naming the address family as unusable is a
 * property of the host, and reading that as "still listening" would false-fail. S-11 - REPORT, DO
 * NOT REPAIR: no signal handler, so termination carries no exit code, and no 'error' listener, so
 * a bind conflict is an uncaught exception. Both are asserted; neither is patched.
 */

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnServer } = require('../helpers/spawnServer');
const httpClient = require('../helpers/httpClient');
const expected = require('../fixtures/expected');

// `console.log` appends this, so READY_BYTES counts one byte more than the banner's own length.
const LOG_TERMINATOR = '\n';

// Composed locally rather than sliced out of the frozen line, so this tier checks the banner's
// shape instead of comparing the harness against a rearrangement of itself; S2 ties it back to the
// fixture.
const BANNER_PREFIX = 'Server running at http://';
const BANNER_SUFFIX = '/';

// Unprivileged and four digits: below the floor a bind is refused for want of privilege rather
// than because anything listens, and any other width would change the banner's length.
const PORT_FLOOR = 1024;
const PORT_CEILING = 9999;

// Bounded so a host with nothing free fails with a legible diagnostic instead of looping.
const PORT_ACQUISITION_ATTEMPTS = 64;

// A probe proves an address free only at the instant it is probed; the residual race is recovered
// from, with a small bound so a real conflict is not masked by retrying.
const SPAWN_ATTEMPTS = 4;

// No port is offered twice in one run, which is what keeps each case independent of run order.
const claimedPorts = new Set();

// Seeded from this process so two runners on one host diverge without randomness.
let portCursor = process.pid;

// Bind-probe verdicts. ONLY EADDRINUSE means a listener survives; classifying the family-unusable
// refusals is what stops a host without IPv6 loopback from false-failing the hygiene scenario.
const FREE = 'free';
const LISTENER = 'listener';
const FAMILY_UNAVAILABLE = 'family-unavailable';
const ADDRESS_IN_USE = 'EADDRINUSE';
const FAMILY_UNAVAILABLE_CODES = Object.freeze(['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'ENOTSUP']);

const CONNECTION_REFUSED = 'ECONNREFUSED';

// A bare literal by necessity: the frozen fixture describes the subject's own IPv4 host.
const IPV6_LOOPBACK = '::1';

const IPV4_FAMILY = 'IPv4';
const TERMINATION_SIGNAL = 'SIGTERM';

// The uncaught-exception code: with no 'error' listener a bind conflict ends the process this way.
const BIND_FAILURE_EXIT_CODE = 1;

const INSTALL_ARTEFACTS = Object.freeze(['node_modules', 'package.json']);

function bannerFor(port) {
  return BANNER_PREFIX + expected.HOST + ':' + port + BANNER_SUFFIX;
}

/**
 * The host's first non-loopback IPv4 address, discovered dynamically because a loopback-only host
 * is legitimate; interfaces are visited in sorted order so a multi-homed host picks the same one
 * twice.
 *
 * @returns {(string|null)} The address, or null when the host reports no non-loopback IPv4.
 */
function firstRoutableIpv4() {
  const interfaces = os.networkInterfaces();
  const names = Object.keys(interfaces).sort();

  for (const name of names) {
    const records = interfaces[name] || [];

    for (const record of records) {
      if (record.family === IPV4_FAMILY && !record.internal) {
        return record.address;
      }
    }
  }

  return null;
}

const ROUTABLE_IPV4 = firstRoutableIpv4();

// Passing a case that asserted nothing would be worse than reporting it skipped, and choosing the
// runner at DECLARATION time keeps this tier at exactly seven declared cases either way.
const testWithRoutableAddress = ROUTABLE_IPV4 === null ? test.skip : test;

// An array because two scenarios legitimately hold two children at once, and registration happens
// at CREATION, so a case that fails immediately still has everything it acquired reclaimed.
let handles = [];

function track(handle) {
  handles.push(handle);
  return handle;
}

/**
 * Attempt a listening bind on one address and classify the outcome. It settles inside the close
 * callback, so the probe socket is released before any assertion runs, and an unrecognised refusal
 * REJECTS rather than being waved through as "not a listener".
 *
 * @param {string} host The address to probe.
 * @param {number} port The port to probe.
 * @returns {Promise<string>} FREE, LISTENER or FAMILY_UNAVAILABLE.
 */
function probeBind(host, port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    let settled = false;

    // Single settle path: every outcome detaches both listeners once and closes the probe before
    // reporting, so no socket and no subscription outlives this promise.
    function settle(classification, failure) {
      if (settled) {
        return;
      }
      settled = true;
      probe.removeListener('error', onProbeError);
      probe.removeListener('listening', onProbeListening);
      probe.close(() => {
        if (failure !== null) {
          reject(failure);
          return;
        }
        resolve(classification);
      });
    }

    function onProbeError(error) {
      if (error.code === ADDRESS_IN_USE) {
        settle(LISTENER, null);
        return;
      }

      if (FAMILY_UNAVAILABLE_CODES.indexOf(error.code) !== -1) {
        settle(FAMILY_UNAVAILABLE, null);
        return;
      }

      settle(null, new Error(
        'probeBind: unclassifiable bind refusal on ' + host + ':' + port + ' (code=' +
        error.code + ', message=' + JSON.stringify(error.message) + ')',
        { cause: error }
      ));
    }

    function onProbeListening() {
      settle(FREE, null);
    }

    probe.once('error', onProbeError);
    probe.once('listening', onProbeListening);

    try {
      // `exclusive` keeps the bind this process's own rather than letting it be delegated, so a
      // refusal is always this host's answer about this address and never an artefact of socket
      // sharing.
      probe.listen({ host: host, port: port, exclusive: true });
    } catch (listenError) {
      settle(null, listenError);
    }
  });
}

/**
 * Return a four-digit port a real listening bind has just PROVEN free. The walk skips the
 * subject's own port - reserved for the sibling tier that binds it - and anything handed out
 * during this run.
 *
 * @returns {Promise<number>} A four-digit port that was free when probed and is now claimed.
 * @throws {Error} When the bounded walk finds no free candidate, naming every verdict it saw.
 */
async function acquireFreePort() {
  const span = PORT_CEILING - PORT_FLOOR + 1;
  const rejected = [];

  for (let attempt = 0; attempt < PORT_ACQUISITION_ATTEMPTS; attempt += 1) {
    // The cursor only increases and starts from a positive identifier, so the candidate stays in
    // range and always four digits.
    const candidate = PORT_FLOOR + (portCursor % span);
    portCursor += 1;

    if (candidate === expected.PORT || claimedPorts.has(candidate)) {
      continue;
    }

    const verdict = await probeBind(expected.HOST, candidate);

    if (verdict === FREE) {
      claimedPorts.add(candidate);
      return candidate;
    }

    // Recorded so an exhausted walk can say WHAT it saw, bounded by the attempt budget.
    rejected.push(candidate + '=' + verdict);
  }

  throw new Error(
    'acquireFreePort: no free port in ' + PORT_FLOOR + '-' + PORT_CEILING + ' on ' +
    expected.HOST + ' after ' + PORT_ACQUISITION_ATTEMPTS + ' candidates (verdicts: ' +
    (rejected.length === 0 ? 'none probed' : rejected.join(', ')) + '; claimed this run: ' +
    (claimedPorts.size === 0 ? 'none' : Array.from(claimedPorts).join(', ')) + ')'
  );
}

/**
 * Spawn a child on a freshly proven port, await readiness, and return the ALREADY TRACKED handle -
 * callers must not register it again. Only a readiness failure naming a bind conflict is retried
 * on a fresh port; every other failure is re-thrown UNCHANGED, so this cannot mask a real defect.
 *
 * @param {object} [options] Harness options; any `port` given is replaced by the acquired one.
 * @returns {Promise<object>} The tracked handle of a child that has reached readiness.
 * @throws {Error} The original readiness failure, or a race diagnostic carrying it as its cause.
 */
async function spawnOnFreePort(options) {
  const requested = options === undefined || options === null ? {} : options;
  let lastRace;

  for (let attempt = 1; attempt <= SPAWN_ATTEMPTS; attempt += 1) {
    const port = await acquireFreePort();
    const handle = track(spawnServer(Object.assign({}, requested, { port: port })));

    try {
      await handle.ready;
      return handle;
    } catch (readinessFailure) {
      // A child that is STILL RUNNING cannot have lost a bind race, so re-throwing at once also
      // keeps the wait below from subscribing to a termination that may never happen.
      if (!handle.hasExited()) {
        throw readinessFailure;
      }

      // Sequenced on CLOSE: the bind diagnostic can still be in the pipe when 'exit' fires, so
      // classifying on `stderr()` earlier would race those bytes.
      await handle.waitForClose();

      if (handle.stderr().indexOf(ADDRESS_IN_USE) === -1) {
        throw readinessFailure;
      }

      lastRace = readinessFailure;

      // Released now rather than at teardown, so a retry accumulates no generated directories.
      await handle.cleanup();
    }
  }

  throw new Error(
    'spawnOnFreePort: lost the bind race on ' + SPAWN_ATTEMPTS +
    ' freshly probed ports in a row, so the host is churning through four-digit addresses faster ' +
    'than they can be claimed',
    { cause: lastRace }
  );
}

/**
 * Every directory Node would consult when resolving a package from `from` upward, root included:
 * the cold-start claim is about what the child could REACH, not only about what sat next to it.
 *
 * @param {string} from The directory to start from.
 * @returns {Array<string>} The directory and each of its ancestors, nearest first.
 */
function resolutionChain(from) {
  const chain = [];
  let current = path.resolve(from);

  for (;;) {
    chain.push(current);
    const parent = path.dirname(current);

    // The root is its own parent, which is the portable way to know the walk is finished.
    if (parent === current) {
      return chain;
    }

    current = parent;
  }
}

// Entry points by which a Node program obtains a second process, or sheds the one it has. S1 scans
// the executed copy for these tokens as a targeted regression check on the subject's shape - a
// text scan, NOT a proof that a second process is impossible.
const PROCESS_MULTIPLYING_APIS = Object.freeze([
  'worker_threads',
  'cluster',
  'fork',
  'spawn',
  'exec',
  'detached',
  'setsid',
  'unref'
]);

// Unconditional teardown. The list is cleared BEFORE anything is released so a failure here leaves
// no stale handle visible to the next case, and releases are attempted INDEPENDENTLY, because a
// throw part-way through a shared loop is how a second child gets stranded.
afterEach(async () => {
  const acquired = handles;
  handles = [];

  let firstFailure;

  for (const handle of acquired) {
    try {
      await handle.cleanup();
    } catch (cleanupError) {
      if (firstFailure === undefined) {
        firstFailure = cleanupError;
      }
    }
  }

  if (firstFailure !== undefined) {
    throw firstFailure;
  }
});

describe('lifecycle (L5)', () => {
  test('S1 starts from a bare checkout as a single foreground process with zero packages installed (F-005-RQ-002, F-005-RQ-004, ST-1)', async () => {
    // Readiness is the proof the start SUCCEEDED: a pattern match that rejects if the child ends
    // first, so a genuinely failed start fails this case rather than timing out.
    const handle = await spawnOnFreePort();

    // Asserted rather than assumed, and FIRST: every "zero packages installed" claim below is
    // about the directory the process actually ran in, and a child left to inherit the runner's
    // would run inside this repository instead.
    expect(handle.cwd).toBe(handle.dir);
    expect(path.dirname(handle.file)).toBe(handle.cwd);
    expect(handle.cwd).not.toBe(process.cwd());
    expect(handle.cwd.startsWith(process.cwd() + path.sep)).toBe(false);

    // Nothing installed where the child ran, nor on any ancestor a package lookup would search.
    // Collecting offenders rather than asserting one at a time names the artefact AND its
    // directory.
    const reachable = [];

    for (const directory of resolutionChain(handle.cwd)) {
      for (const artefact of INSTALL_ARTEFACTS) {
        const candidate = path.join(directory, artefact);

        if (fs.existsSync(candidate)) {
          reachable.push(candidate);
        }
      }
    }

    expect(reachable).toStrictEqual([]);

    // The COMPLETE listing, so an unexpected extra file fails rather than slipping past a check
    // for specific absences.
    expect(fs.readdirSync(handle.dir)).toStrictEqual([path.basename(handle.file)]);
    expect(handle.hasExited()).toBe(false);

    // "Starts" made concrete: a process that binds but cannot answer has not started. Status and
    // body only - this client disables pooling, so the framing headers it sees belong to another
    // tier.
    const response = await httpClient.get(handle.port);
    expect(response.status).toBe(expected.STATUS);
    expect(response.body).toBe(expected.BODY);

    // Scanned on the GENERATED COPY, so the check describes the code that actually ran. A token
    // scan plus a require count: a targeted regression check on the subject's shape, NOT a proof
    // that a second process is impossible.
    const executed = fs.readFileSync(handle.file, 'utf8');
    expect(
      PROCESS_MULTIPLYING_APIS.filter((api) => executed.indexOf(api) !== -1)
    ).toStrictEqual([]);
    expect(executed.match(/\brequire\s*\(/g)).toHaveLength(1);

    // "Single" made consequential without reading a host-specific process table: terminating the
    // ONE child this runner started releases the address the request above proved it occupied,
    // whereas a surviving fork or detached daemon would still be holding it.
    await handle.stop(TERMINATION_SIGNAL);
    expect(handle.hasExited()).toBe(true);
    expect(await probeBind(expected.HOST, handle.port)).toBe(FREE);
  });

  test('S2 emits exactly one 41-byte readiness line (F-004-RQ-001)', async () => {
    const handle = await spawnOnFreePort();

    // Tied back to the frozen fixture first, so the local composition cannot drift from the rest
    // of the suite. The frozen line is not used against the child: it names a port this tier never
    // binds.
    expect(bannerFor(expected.PORT)).toBe(expected.READY_LINE);
    expect(handle.readyLine).toBe(bannerFor(handle.port));
    expect(handle.stdout()).toBe(handle.readyLine + LOG_TERMINATOR);
    expect(Buffer.byteLength(handle.stdout())).toBe(expected.READY_BYTES);

    // Counted on non-empty segments so the trailing terminator is not mistaken for a second line.
    expect(handle.stdout().split(LOG_TERMINATOR).filter((line) => line.length > 0)).toHaveLength(1);
    expect(handle.stderr()).toBe('');
  });

  test('S3 exits immediately on SIGTERM without draining (F-002-RQ-005, F-004-RQ-003)', async () => {
    const handle = await spawnOnFreePort();

    // The signal and the outcome in one guarded step: the harness inspects the recorded terminal
    // state before subscribing, so an exit that has already happened resolves at once (contract
    // D3).
    const outcome = await handle.stop(TERMINATION_SIGNAL);

    // A null code with the signal alongside it is the observable proof that NO handler exists, and
    // that gap is reported, never repaired. The signal name is a LITERAL rather than the constant
    // just sent, because comparing against the request would hold for any signal.
    expect(outcome).toStrictEqual({ code: null, signal: 'SIGTERM' });
    expect(handle.hasExited()).toBe(true);

    // Logging stays confined to the one readiness line: termination adds nothing to either stream.
    expect(handle.stdout()).toBe(handle.readyLine + LOG_TERMINATOR);
    expect(Buffer.byteLength(handle.stdout())).toBe(expected.READY_BYTES);
    expect(handle.stderr()).toBe('');
  });

  test('S4 exits non-zero with an EADDRINUSE diagnostic when the port is contended (F-002-RQ-004)', async () => {
    // The blocker holds the address first, on a port just proven free, so the conflict is the one
    // this scenario arranged rather than one inherited from a busy host.
    const first = await spawnOnFreePort();

    // The blocker's OWN port, passed explicitly: the one place a port is reused while KNOWN
    // occupied, because a conflict is only deterministic when both children aim at the same
    // address.
    const second = track(spawnServer({ port: first.port }));

    // Only TERMINATION is awaited, never this child's readiness - it cannot become ready, and the
    // harness already marked that rejection handled (contract E2). `waitForClose()` because the
    // assertions below read stream CONTENT, which is only complete on close.
    const outcome = await second.waitForClose();

    // The uncaught-exception code rather than a signal: with no 'error' listener the bind failure
    // propagates as an unhandled event. Reported, not repaired.
    expect(outcome).toStrictEqual({ code: BIND_FAILURE_EXIT_CODE, signal: null });

    // An exact empty string: the banner is emitted from the listen callback, which never ran.
    expect(second.stdout()).toBe('');

    // The one containment check in this tier, and deliberately so: the diagnostic is a stack
    // trace whose surrounding text is not a stable value, while the code inside it is.
    expect(second.stderr()).toContain(ADDRESS_IN_USE);

    // The blocker is untouched by the failure next to it: same address, same single readiness
    // line.
    expect(first.hasExited()).toBe(false);
    expect(first.stdout()).toBe(first.readyLine + LOG_TERMINATOR);
  });

  test('S5 produces a byte-identical readiness line and response after restart (F-001-RQ-003)', async () => {
    const before = await spawnOnFreePort();

    const firstStdout = before.stdout();
    const firstResponse = await httpClient.get(before.port);

    // The address has to be genuinely released before it can be reclaimed, so this happens here
    // rather than at teardown; both calls are idempotent.
    await before.stop(TERMINATION_SIGNAL);
    await before.cleanup();

    // The SAME port, passed explicitly: acquiring would hand back a different address and turn a
    // restart into two unrelated servers. Re-probing would be theatre - the stop above released
    // it.
    const after = track(spawnServer({ port: before.port }));
    await after.ready;

    const secondStdout = after.stdout();
    const secondResponse = await httpClient.get(after.port);

    // A genuinely new process from a new fixture directory, so the case cannot be comparing one
    // server against itself.
    expect(after.port).toBe(before.port);
    expect(after.dir).not.toBe(before.dir);

    expect(secondStdout).toBe(firstStdout);
    expect(Buffer.byteLength(secondStdout)).toBe(expected.READY_BYTES);
    expect(secondResponse.status).toBe(expected.STATUS);
    expect(secondResponse.status).toBe(firstResponse.status);
    expect(secondResponse.body).toBe(firstResponse.body);
    expect(secondResponse.body).toBe(expected.BODY);
    expect(Buffer.byteLength(secondResponse.body)).toBe(expected.BODY_BYTES);
  });

  testWithRoutableAddress(
    'S6 confines reachability to loopback and refuses the routable address (F-002-RQ-002)',
    async () => {
      const handle = await spawnOnFreePort();

      // Loopback connects and serves, so the refusal below cannot be explained away as a server
      // that was never listening.
      const response = await httpClient.get(handle.port);
      expect(response.status).toBe(expected.STATUS);
      expect(response.body).toBe(expected.BODY);

      // The tested fact: the same port on the ONE non-loopback local address selected above is
      // refused, because the subject binds loopback specifically rather than every interface. A
      // refusal surfaces as a rejection carrying that code, never as a response with an error
      // status.
      await expect(
        httpClient.request({ host: ROUTABLE_IPV4, port: handle.port })
      ).rejects.toMatchObject({ code: CONNECTION_REFUSED });
    }
  );

  test('S7 leaves no listening socket after termination (F-002-RQ-005)', async () => {
    const handle = await spawnOnFreePort();

    // A negative control BEFORE the post-condition, because a probe that detected nothing at all
    // would satisfy the assertions below exactly as a clean host does. While the child is
    // serving, the probe must report the address as taken - which proves the check has teeth.
    expect(await probeBind(expected.HOST, handle.port)).toBe(LISTENER);

    await handle.stop(TERMINATION_SIGNAL);

    // Confirmed BEFORE the directory is reclaimed, because releasing a handle also terminates a
    // child that is still running - so otherwise the scenario could not tell which freed the
    // address.
    expect(handle.hasExited()).toBe(true);

    await handle.cleanup();

    // The child bound this very address moments ago, so an exact verdict is warranted here.
    expect(await probeBind(expected.HOST, handle.port)).toBe(FREE);

    // The second family is asserted only on what matters, because whether it is available at all
    // is a property of the host: an unavailable family is not a surviving listener.
    expect(await probeBind(IPV6_LOOPBACK, handle.port)).not.toBe(LISTENER);

    expect(fs.existsSync(handle.dir)).toBe(false);
  });
});
