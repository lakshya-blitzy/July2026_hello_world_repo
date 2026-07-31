'use strict';

/**
 * L5 LIFECYCLE TIER - process-level behaviour, observable only from OUTSIDE the process.
 *
 * CHILD PROCESS ONLY, ON A SHIFTED FOUR-DIGIT PORT. Every scenario here runs the subject as a
 * genuine operating-system process started by the child-process harness, which writes a copy
 * differing from `server.js` on exactly one line - the port declaration - into a fresh system
 * temp directory. A four-digit replacement keeps the readiness banner exactly READY_BYTES long,
 * so every byte-count assertion below holds unchanged.
 *
 * CONTRACT D2 - THIS FILE NEVER LOADS THE SUBJECT IN-PROCESS. Loading it for real, and binding
 * its own fixed address, belongs to the sibling bootstrap tier and to that tier alone: two files
 * doing so collided under two workers, and confining it to one file is what makes the suite's
 * isolation structural rather than merely configured by the runner's single-worker setting.
 * Neither in-process harness is imported here, and no scenario touches the subject's own port.
 *
 * NO COVERAGE FROM HERE, BY CONSTRUCTION. A child process is a separate V8 instance, so nothing
 * it executes reaches the in-process instrumentation counters: this file contributes ZERO to the
 * coverage figures. The enforcing 100% gate is satisfied entirely by the bootstrap tier's real
 * load and the request it serves. Running THIS FILE ALONE therefore reports 0% and fails that
 * gate while all seven cases pass - which is correct and expected. The threshold is never
 * lowered, excluded or switched off, and the subject is never loaded here to inflate it.
 *
 * CONTRACT D3 - EVERY EXIT AWAIT IS GUARDED. Subscribing to a termination event that has already
 * fired hangs the scenario until the runner's safety bound expires - measured at 20,003 ms before
 * the guard and ~0 ms after it. Exits are therefore awaited only through the harness's
 * `waitForExit()` and `stop()`, both of which inspect the recorded terminal state before
 * subscribing to anything. No termination event is ever subscribed to directly in this file.
 *
 * CONTRACT E2 - THE CONTENDED CHILD'S READINESS PROMISE IS NEVER AWAITED. In the port-contention
 * scenario the second child ends before it can become ready, so its readiness promise rejects.
 * The harness marks that promise handled at creation, which is what keeps the rejection from
 * aborting the entire run; the scenario awaits only that child's EXIT and then asserts on the
 * recorded code, signal and streams. Every other scenario does await readiness first.
 *
 * S-2 - READINESS IS A STDOUT PATTERN MATCH, NEVER A SLEEP. This file creates no timer of any
 * kind and never synchronises on wall-clock time. The failure path is made deterministic by
 * contending a KNOWN port rather than by hoping for a conflict, and no case asserts a duration.
 *
 * S-3 - TEARDOWN IS UNCONDITIONAL. Every handle a scenario acquires is tracked the moment it is
 * created and released in the `afterEach` below, which runs after a FAILING case exactly as it
 * does after a passing one. Releases are attempted independently, so one failure cannot skip the
 * rest, and every probe socket is released on every path. Forcibly terminating the runner is
 * forbidden: a runner that will not exit is reporting a leak to be fixed here.
 *
 * THE HYGIENE CHECK IS A NODE-NATIVE BIND PROBE, NOT A SHELL-OUT. External socket-inspection
 * utilities are deliberately not relied upon - they are not universally installed, their output
 * formats differ between implementations, and parsing one would put an extra process on the
 * teardown path. `probeBind` below attempts the bind itself and classifies the outcome, which
 * filters on the LISTENING state for free: a connection lingering in TIME_WAIT on the same local
 * address does not prevent a fresh listening bind, whereas a surviving listener does. ONLY
 * EADDRINUSE means a listener remains. A refusal reporting the ADDRESS FAMILY as unusable means
 * exactly that and is NOT a listener - this container has no IPv6 loopback, so the second family
 * reports precisely that, and treating "cannot bind" as "still listening" would false-fail.
 *
 * S-11 - REPORT, DO NOT REPAIR. The subject registers no signal handler, so termination takes the
 * default disposition and the exit carries no code at all; and it registers no 'error' listener,
 * so a bind conflict is an uncaught exception with a diagnostic on stderr and nothing on stdout.
 * Both gaps are asserted as CURRENT behaviour. Neither the subject nor the generated copy is ever
 * patched to close them.
 *
 * @see server.js - the behavioural contract every assertion here derives from. It is
 *      reference-only: the harness reads it, nothing in this tier writes it.
 */

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnServer } = require('../helpers/spawnServer');
const httpClient = require('../helpers/httpClient');
const expected = require('../fixtures/expected');

/**
 * The line terminator the subject's logger appends to the banner it is handed.
 *
 * The frozen readiness line carries no newline of its own, while the frozen byte count describes
 * that line as it reaches stdout, terminator included - so the two differ by exactly this one
 * byte. Naming it here makes the difference explicit instead of looking like an off-by-one
 * waiting to be "corrected".
 *
 * @type {string}
 */
const LOG_TERMINATOR = '\n';

/**
 * The readiness banner's fixed text, up to the address it advertises.
 *
 * Stated locally rather than sliced out of the frozen line, so this tier checks the banner's
 * shape independently instead of comparing the harness against a rearrangement of itself. The
 * composition is nonetheless tied back to the fixture inside the readiness scenario, which
 * asserts that composing at the subject's own port reproduces the frozen line exactly - so this
 * text cannot drift away from the rest of the suite unnoticed.
 *
 * @type {string}
 */
const BANNER_PREFIX = 'Server running at http://';

/**
 * The readiness banner's trailing path segment.
 *
 * @type {string}
 */
const BANNER_SUFFIX = '/';

/**
 * Port shared by the two children in the port-contention scenario.
 *
 * Passed EXPLICITLY to both spawns, because a conflict is only deterministic when both children
 * aim at the same address. Four digits, so the banner's byte length is unaffected, and
 * deliberately not the harness's own default, so a port that is expected to be fought over can
 * never be confused with the one the other scenarios use.
 *
 * @type {number}
 */
const CONTENDED_PORT = 4312;

/**
 * Port bound twice in sequence by the restart-determinism scenario.
 *
 * The same reasoning applies: the second spawn must reclaim the first one's exact address for
 * the comparison to mean anything, and keeping that address distinct from every other scenario's
 * makes each case independent of the order they run in.
 *
 * @type {number}
 */
const RESTART_PORT = 4313;

/**
 * The probed address accepted a listening bind, so nothing is listening on it.
 *
 * @type {string}
 */
const FREE = 'free';

/**
 * The bind was refused because the address is already taken, so a listener survives. This is the
 * one classification the hygiene scenario must never see.
 *
 * @type {string}
 */
const LISTENER = 'listener';

/**
 * The address family itself is unavailable on this host, which says nothing about any listener.
 *
 * @type {string}
 */
const FAMILY_UNAVAILABLE = 'family-unavailable';

/**
 * The bind refusal that means - and means only - that something is already listening there.
 *
 * @type {string}
 */
const ADDRESS_IN_USE = 'EADDRINUSE';

/**
 * Bind refusals that report the ADDRESS FAMILY as unusable rather than the address as taken.
 *
 * Distinguishing these from a genuine conflict is the whole point of classifying rather than
 * merely catching: a host without IPv6 loopback refuses every `::1` bind, and a check that read
 * that as "still listening" would fail on a perfectly clean environment.
 *
 * @type {ReadonlyArray<string>}
 */
const FAMILY_UNAVAILABLE_CODES = Object.freeze(['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'ENOTSUP']);

/**
 * The connect refusal a loopback-bound listener produces for every other local address. This is
 * the positive evidence that the subject's binding host is a confinement rather than a default.
 *
 * @type {string}
 */
const CONNECTION_REFUSED = 'ECONNREFUSED';

/**
 * The IPv6 loopback address, probed alongside the IPv4 one so the hygiene check covers both
 * address families. A bare literal by necessity: the frozen fixture describes the subject's own
 * IPv4 host, and the subject never binds this family at all.
 *
 * @type {string}
 */
const IPV6_LOOPBACK = '::1';

/**
 * The family label Node reports for an IPv4 address record.
 *
 * @type {string}
 */
const IPV4_FAMILY = 'IPv4';

/**
 * The termination signal every stop in this tier uses.
 *
 * The subject installs no handler for it, so it takes the default disposition: the process ends
 * at once, without draining, and reports the signal instead of an exit code.
 *
 * @type {string}
 */
const TERMINATION_SIGNAL = 'SIGTERM';

/**
 * The exit code the runtime uses when a process ends on an uncaught exception.
 *
 * The subject registers no 'error' listener, so a failed bind is exactly that - which is why the
 * contention scenario expects a code here rather than a signal.
 *
 * @type {number}
 */
const BIND_FAILURE_EXIT_CODE = 1;

/**
 * Directory entries whose ABSENCE is what makes the cold-start scenario a genuine test: the
 * generated copy runs from a directory holding no manifest and no installed package, so its only
 * import can be a built-in one.
 *
 * @type {ReadonlyArray<string>}
 */
const INSTALL_ARTEFACTS = Object.freeze(['node_modules', 'package.json']);

/**
 * Compose the readiness banner for a given port, exactly as the subject composes it from its own
 * two constants.
 *
 * @param {number} port The port the banner should advertise.
 * @returns {string} The banner text, without the terminator the logger appends.
 */
function bannerFor(port) {
  return BANNER_PREFIX + expected.HOST + ':' + port + BANNER_SUFFIX;
}

/**
 * The host's first routable IPv4 address, or null when it has none.
 *
 * "Routable" here means an address the operating system reports as belonging to a real interface
 * rather than to loopback, which is precisely the class of address a server bound to loopback
 * must refuse. It is discovered dynamically and never hard-coded: the value differs between
 * hosts, and an environment with no such interface at all is legitimate.
 *
 * Interface names are visited in sorted order so the address chosen does not depend on the
 * runtime's enumeration order, keeping the scenario reproducible on a multi-homed host.
 *
 * @returns {(string|null)} The address, or null when the host is loopback-only.
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

/**
 * The routable address the loopback-confinement scenario aims at, resolved once at module scope
 * so the scenario can be DECLARED conditionally rather than deciding at run time whether to
 * assert anything.
 *
 * @type {(string|null)}
 */
const ROUTABLE_IPV4 = firstRoutableIpv4();

/**
 * The runner for the loopback-confinement scenario.
 *
 * A loopback-only host cannot demonstrate a refusal from a routable address, and silently
 * passing a case that asserted nothing would be worse than reporting it as skipped. Selecting
 * the runner at declaration time keeps this tier at exactly seven declared cases either way.
 *
 * @type {Function}
 */
const testWithRoutableAddress = ROUTABLE_IPV4 === null ? test.skip : test;

/**
 * Handles acquired by the case currently running, in acquisition order.
 *
 * An array rather than a single variable because two scenarios legitimately hold two children at
 * once - the contention scenario runs a blocker alongside the child that fails, and the restart
 * scenario spans two processes - and a single slot would silently leak one of them.
 *
 * @type {Array<object>}
 */
let handles = [];

/**
 * Register a handle for release, returning it so a spawn reads as one expression.
 *
 * Registration happens at CREATION rather than after the first successful assertion, so a case
 * that fails immediately still has its child and its temp directory reclaimed.
 *
 * @param {object} handle The handle returned by the child-process harness.
 * @returns {object} That same handle.
 */
function track(handle) {
  handles.push(handle);
  return handle;
}

/**
 * Attempt a listening bind on one address and classify the outcome.
 *
 * This is the hygiene check the tier's post-condition rests on, and it is deliberately native:
 * nothing is spawned, no external utility is required, and no textual socket table is parsed. It
 * also filters on the LISTENING state for free, because an address occupied only by connections
 * winding down still accepts a fresh listening bind, while a surviving listener does not.
 *
 * The promise settles inside the close callback, so the probe socket is fully released before any
 * assertion runs - on the bound path and on the refused path alike, where the runtime reports the
 * "was not running" condition to that callback instead of emitting an event. An unrecognised
 * refusal REJECTS rather than being classified: an outcome nobody anticipated must fail loudly,
 * never be waved through as "not a listener".
 *
 * @param {string} host The address to probe.
 * @param {number} port The port to probe.
 * @returns {Promise<string>} FREE, LISTENER or FAMILY_UNAVAILABLE.
 */
function probeBind(host, port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    let settled = false;

    /**
     * The single settle path: every outcome detaches both listeners exactly once and closes the
     * probe before reporting, so no socket and no subscription outlives this promise.
     *
     * @param {(string|null)} classification The verdict, or null when reporting a failure.
     * @param {(Error|null)} failure The failure to report, or null on success.
     * @returns {void}
     */
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

    /**
     * @param {Error & { code?: string }} error The refusal the runtime reported.
     * @returns {void}
     */
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

    /**
     * @returns {void}
     */
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
 * The operating system's process table, read as a filesystem.
 *
 * Reading it is a file read rather than a shell-out, which keeps the single-process scenario in
 * line with this tier's rule that no external utility is required and no extra process is put on
 * the assertion path. Its presence is a property of the HOST, so the scenario that depends on it
 * is DECLARED conditionally below rather than deciding at run time whether to assert anything.
 *
 * @type {string}
 */
const PROC_TABLE = '/proc';

/**
 * The APIs whose mere MENTION in the executed code would open the door to a second process.
 *
 * Absence of every one of them is a structural proof that no fork, no worker, no cluster and no
 * daemonisation path exists to be taken - stronger than observing that none happened on one run.
 *
 * @type {ReadonlyArray<string>}
 */
const PROCESS_MULTIPLYING_APIS = Object.freeze([
  'child_process',
  'worker_threads',
  'cluster',
  'fork',
  'detached',
  'setsid',
  'unref'
]);

/**
 * One process's parentage and process group, or null when it has no entry.
 *
 * Null means "not observable here": either the process has gone, or this host exposes no process
 * table at all - and the second of those is what the declaration-time gate below tests for. Any
 * other read failure is re-thrown, because an outcome nobody anticipated must fail loudly rather
 * than be waved through as an absence.
 *
 * EACCES is tolerated for the same reason ENOENT is: a process this user cannot inspect is by
 * definition not a child of this runner, so it can never be the one being looked for.
 *
 * @param {number} pid The process to describe.
 * @returns {?{state: string, ppid: number, pgrp: number}} Its entry, or null.
 */
function readProcessEntry(pid) {
  let raw;

  try {
    raw = fs.readFileSync(path.join(PROC_TABLE, String(pid), 'stat'), 'utf8');
  } catch (readError) {
    if (readError.code === 'ENOENT' || readError.code === 'ESRCH' ||
        readError.code === 'EACCES') {
      return null;
    }
    throw readError;
  }

  // The executable name is parenthesised and may itself contain spaces and parentheses, so the
  // fields are taken from AFTER THE LAST ')' rather than by splitting the whole line - which is
  // exactly the parse that a naive whitespace split gets wrong.
  const fields = raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/);

  return { state: fields[0], ppid: Number(fields[1]), pgrp: Number(fields[2]) };
}

/**
 * The pids whose parent is the given process, in ascending order.
 *
 * A process that ends between the listing and the read simply has no entry by then and is
 * skipped, so the scan cannot fail on a table that is changing underneath it.
 *
 * @param {number} pid The parent to look for.
 * @returns {number[]} Its immediate children.
 */
function childPidsOf(pid) {
  return fs.readdirSync(PROC_TABLE)
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number)
    .filter((candidate) => {
      const entry = readProcessEntry(candidate);
      return entry !== null && entry.ppid === pid;
    })
    .sort((first, second) => first - second);
}

/**
 * The runner for the single-process scenario.
 *
 * A host without a readable process table cannot demonstrate parentage or the absence of
 * descendants, and silently passing a case that asserted nothing would be worse than reporting it
 * as skipped - the same reasoning, and the same mechanism, as the loopback-confinement scenario.
 *
 * @type {Function}
 */
const testWithProcessTable = readProcessEntry(process.pid) === null ? test.skip : test;

/**
 * Unconditional teardown: this runs after a FAILING case exactly as it does after a passing one,
 * which is what guarantees no child, no pipe and no generated directory outlives the case that
 * created it - and therefore that the next case, and the next file, start from a clean host.
 *
 * The tracked list is taken and cleared BEFORE anything is released, so a failure here cannot
 * leave a stale handle visible to the next case. Every release is then attempted INDEPENDENTLY,
 * because a throw part-way through a shared loop is exactly how a second child gets stranded.
 * Only the FIRST failure is re-thrown, and only once every release has been attempted, so a
 * teardown problem is reported without suppressing the cleanups that still had to happen.
 *
 * The harness's own cleanup is idempotent, so a scenario that already stopped and released a
 * handle for its own purposes costs nothing here.
 */
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
  test('S1 starts from a bare checkout with zero packages installed (F-005-RQ-002)', async () => {
    const handle = track(spawnServer());

    // Readiness is the proof that the start SUCCEEDED, and it is a stdout pattern match rather
    // than a wait: the promise resolves the moment the banner appears, or rejects if the child
    // ends first, so a failed start fails this case rather than running out the safety bound.
    await handle.ready;

    // Nothing was installed for the child, and nothing could have been: the directory it runs
    // from holds no manifest to install from and no package tree to resolve against. Filtering
    // rather than testing each entry separately means a failure names the offending artefact.
    const installed = INSTALL_ARTEFACTS.filter(
      (artefact) => fs.existsSync(path.join(handle.dir, artefact))
    );
    expect(installed).toStrictEqual([]);

    // Asserted as the COMPLETE listing, so an unexpected extra file fails the case instead of
    // slipping past a check for specific absences. The generated copy's own name is read from
    // the handle rather than restated, so the two can never disagree.
    expect(fs.readdirSync(handle.dir)).toStrictEqual([path.basename(handle.file)]);

    // Still alive, so readiness was not a brief flare before an exit.
    expect(handle.hasExited()).toBe(false);

    // "Starts" made concrete: a process that binds but cannot answer has not started in any
    // sense that matters. The response is asserted on status and body only - this client
    // disables pooling, so the framing headers it sees are its own and belong to another tier.
    const response = await httpClient.get(handle.port);
    expect(response.status).toBe(expected.STATUS);
    expect(response.body).toBe(expected.BODY);
  });

  test('S2 emits exactly one 41-byte readiness line (F-004-RQ-001)', async () => {
    const handle = track(spawnServer());
    await handle.ready;

    // The banner's shape is tied back to the frozen fixture first: composing at the subject's
    // own port must reproduce the frozen line byte for byte. Without this, the local composition
    // below could drift away from the value the rest of the suite asserts and still pass.
    expect(bannerFor(expected.PORT)).toBe(expected.READY_LINE);

    // The child's banner is then the same composition at the port the harness generated. The
    // frozen line itself is deliberately NOT used here: it names the subject's own port, which
    // this tier never binds.
    expect(handle.readyLine).toBe(bannerFor(handle.port));

    // Captured stdout is the banner and the terminator, and nothing else - asserted as an exact
    // string, so a second line, a stray character or a missing terminator all fail.
    expect(handle.stdout()).toBe(handle.readyLine + LOG_TERMINATOR);

    // A four-digit shifted port leaves the byte count identical to the subject's own banner,
    // which is why the frozen count still applies to a child that is not on that port.
    expect(Buffer.byteLength(handle.stdout())).toBe(expected.READY_BYTES);

    // Exactly one line, counted on non-empty segments so the trailing terminator is not mistaken
    // for a second line.
    expect(handle.stdout().split(LOG_TERMINATOR).filter((line) => line.length > 0)).toHaveLength(1);

    // A clean start writes nothing to the diagnostic stream at all.
    expect(handle.stderr()).toBe('');
  });

  test('S3 exits immediately on SIGTERM without draining (F-002-RQ-005, F-004-RQ-003)', async () => {
    const handle = track(spawnServer());
    await handle.ready;

    // The signal and the outcome in one guarded step. Nothing waits on the clock: the harness
    // inspects the recorded terminal state before subscribing, so an exit that has already
    // happened resolves at once instead of hanging on an event that will never fire again.
    const outcome = await handle.stop(TERMINATION_SIGNAL);

    // Asserted as a whole object, so an extra or renamed field fails the case rather than
    // slipping past a field-by-field check. A null code with the signal reported alongside it is
    // the observable proof that NO handler exists: the process was terminated by the signal
    // rather than choosing to exit, and it neither drained connections nor logged a farewell.
    // That gap is reported here, never repaired.
    //
    // The signal name is stated as a LITERAL rather than read back from the constant that was
    // sent, and that is a deliberate drift alarm rather than a duplicated expectation: comparing
    // the reported signal against the one just requested holds for ANY signal, so it would keep
    // passing if this tier were ever retargeted at a different one while this case, its title and
    // the requirement it cites all still spoke about termination. Pinning it fails loudly instead.
    expect(outcome).toStrictEqual({ code: null, signal: 'SIGTERM' });
    expect(handle.hasExited()).toBe(true);

    // Logging stays confined to the one readiness line: termination adds nothing to either
    // stream, and the byte count is unchanged from the moment the child became ready.
    expect(handle.stdout()).toBe(handle.readyLine + LOG_TERMINATOR);
    expect(Buffer.byteLength(handle.stdout())).toBe(expected.READY_BYTES);
    expect(handle.stderr()).toBe('');
  });

  test('S4 exits non-zero with an EADDRINUSE diagnostic when the port is contended (F-002-RQ-004)', async () => {
    // The blocker holds the address first, which is what makes the conflict deterministic: the
    // failure is arranged rather than hoped for, so this case cannot pass by accident on a busy
    // host or fail by accident on an idle one.
    const first = track(spawnServer({ port: CONTENDED_PORT }));
    await first.ready;

    // Deliberately NOT awaited for readiness: this child cannot become ready, so its readiness
    // promise rejects. The harness marks that promise handled at creation, which is what stops
    // the rejection aborting the run - awaiting it here would instead turn an expected failure
    // into a thrown error and lose the exit-code evidence this case exists to collect.
    const second = track(spawnServer({ port: CONTENDED_PORT }));

    // Only the EXIT is awaited, through the guarded accessor.
    const outcome = await second.waitForExit();

    // A code rather than a signal, and specifically the uncaught-exception code: the subject
    // registers no 'error' listener, so the bind failure propagates as an unhandled event. This
    // is asserted as CURRENT behaviour and the gap is left exactly where it is.
    expect(outcome).toStrictEqual({ code: BIND_FAILURE_EXIT_CODE, signal: null });

    // Nothing on stdout, because the banner is emitted from the listen callback and that callback
    // never ran. An exact empty string, not merely an absence of the banner.
    expect(second.stdout()).toBe('');

    // The one containment check in this tier, and deliberately so: the diagnostic is a stack
    // trace whose surrounding text is not a stable value, while the code inside it is.
    expect(second.stderr()).toContain(ADDRESS_IN_USE);

    // The blocker is untouched by the failure next to it - it keeps the address and its own
    // output is still the single readiness line.
    expect(first.hasExited()).toBe(false);
    expect(first.stdout()).toBe(first.readyLine + LOG_TERMINATOR);
  });

  test('S5 produces a byte-identical readiness line and response after restart (F-001-RQ-003)', async () => {
    const before = track(spawnServer({ port: RESTART_PORT }));
    await before.ready;

    const firstStdout = before.stdout();
    const firstResponse = await httpClient.get(before.port);

    // The address has to be genuinely released before it can be reclaimed, so the first process
    // is stopped and its directory removed rather than left to the shared teardown. Both steps
    // are idempotent, so the teardown still runs harmlessly afterwards.
    await before.stop(TERMINATION_SIGNAL);
    await before.cleanup();

    // The SAME port, so this is a restart rather than a second unrelated server.
    const after = track(spawnServer({ port: RESTART_PORT }));
    await after.ready;

    const secondStdout = after.stdout();
    const secondResponse = await httpClient.get(after.port);

    // A genuinely new process from a genuinely new fixture directory: without this the case could
    // be comparing one server against itself.
    expect(after.port).toBe(before.port);
    expect(after.dir).not.toBe(before.dir);

    // Byte-identical output across the process boundary. Nothing is carried over because there is
    // nothing to carry: no counter, no cache, no state of any kind survives - or exists.
    expect(secondStdout).toBe(firstStdout);
    expect(Buffer.byteLength(secondStdout)).toBe(expected.READY_BYTES);

    // The same holds for what it serves, checked against the first response and against the
    // frozen expectation, by text and by byte count.
    expect(secondResponse.status).toBe(expected.STATUS);
    expect(secondResponse.status).toBe(firstResponse.status);
    expect(secondResponse.body).toBe(firstResponse.body);
    expect(secondResponse.body).toBe(expected.BODY);
    expect(Buffer.byteLength(secondResponse.body)).toBe(expected.BODY_BYTES);
  });

  testWithRoutableAddress(
    'S6 confines reachability to loopback and refuses the routable address (F-002-RQ-002)',
    async () => {
      const handle = track(spawnServer());
      await handle.ready;

      // Loopback connects and serves, so the server is genuinely reachable and the refusal below
      // cannot be explained away as a server that was never listening.
      const response = await httpClient.get(handle.port);
      expect(response.status).toBe(expected.STATUS);
      expect(response.body).toBe(expected.BODY);

      // The same port on the host's own routable address is REFUSED. This is the single most
      // security-relevant property of the subject: it binds loopback specifically, not every
      // interface, so it is unreachable from the network even though the port is open locally.
      // A refusal is the runtime's answer to a connect attempt, so it surfaces as a rejection
      // carrying that exact code - never as a response with an error status.
      await expect(
        httpClient.request({ host: ROUTABLE_IPV4, port: handle.port })
      ).rejects.toMatchObject({ code: CONNECTION_REFUSED });
    }
  );

  test('S7 leaves no listening socket after termination (F-002-RQ-005)', async () => {
    const handle = track(spawnServer());
    await handle.ready;

    // A negative control BEFORE the post-condition, because a probe that detected nothing at all
    // would satisfy the assertions below exactly as a clean host does. While the child is
    // serving, the probe must report the address as taken - which proves the check has teeth.
    expect(await probeBind(expected.HOST, handle.port)).toBe(LISTENER);

    await handle.stop(TERMINATION_SIGNAL);

    // Termination is confirmed BEFORE the directory is reclaimed, because releasing a handle also
    // terminates a child that is still running - so without this the scenario could not tell an
    // address freed by the signal from one freed by the teardown, and "after termination" would
    // be an assumption rather than an established premise.
    expect(handle.hasExited()).toBe(true);

    await handle.cleanup();

    // Loopback is available on every host this suite can run on, so the verdict here is exact:
    // the address must accept a listening bind again.
    expect(await probeBind(expected.HOST, handle.port)).toBe(FREE);

    // The second family is asserted only on what matters, because whether it exists at all is a
    // property of the host: an unavailable family is not a surviving listener, and this container
    // reports exactly that.
    expect(await probeBind(IPV6_LOOPBACK, handle.port)).not.toBe(LISTENER);

    // The generated fixture leaves nothing behind either - the copy lived only in the system temp
    // directory, and that directory is gone.
    expect(fs.existsSync(handle.dir)).toBe(false);
  });

  testWithProcessTable(
    'S8 runs as a single foreground process that neither forks nor detaches (F-005-RQ-004)',
    async () => {
      const handle = track(spawnServer());
      await handle.ready;

      // Read back from the GENERATED COPY rather than from the subject, so this describes the code
      // that actually ran in the child.
      const executed = fs.readFileSync(handle.file, 'utf8');

      // Filtered rather than asserted one API at a time, so a failure names the offending API
      // instead of merely reporting that something matched.
      expect(
        PROCESS_MULTIPLYING_APIS.filter((api) => executed.indexOf(api) !== -1)
      ).toStrictEqual([]);

      const child = readProcessEntry(handle.child.pid);
      const runner = readProcessEntry(process.pid);

      expect(child).not.toBeNull();
      expect(runner).not.toBeNull();

      // Still THIS runner's own child, and still in the runner's process group: a process that had
      // daemonised itself would have been re-parented away, and one that had detached would have
      // left the group. Together these are what "foreground" means at the operating-system level.
      expect(child.ppid).toBe(process.pid);
      expect(child.pgrp).toBe(runner.pgrp);

      // One process, not a leader with workers behind it.
      expect(childPidsOf(handle.child.pid)).toStrictEqual([]);

      // "Single" made consequential: that one process is the one serving, so it is the only thing
      // that has to be terminated. Asserted before the signal, so the address below is known to
      // have been genuinely occupied by it.
      const response = await httpClient.get(handle.port);
      expect(response.status).toBe(expected.STATUS);
      expect(response.body).toBe(expected.BODY);

      await handle.stop(TERMINATION_SIGNAL);
      expect(handle.hasExited()).toBe(true);

      // Nothing outlived it. A surviving fork or a detached daemon would still be holding the
      // address, so a free bind here is the positive evidence that the process was alone - and the
      // pid is checked against the runner's CURRENT children rather than against the process table
      // as a whole, so a recycled pid cannot be mistaken for a survivor.
      expect(childPidsOf(process.pid)).not.toContain(handle.child.pid);
      expect(await probeBind(expected.HOST, handle.port)).toBe(FREE);
    }
  );
});
