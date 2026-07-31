'use strict';

/**
 * L5 LIFECYCLE TIER - process-level behaviour, observable only from OUTSIDE the process.
 *
 * CHILD PROCESS ONLY, ON A SHIFTED FOUR-DIGIT PORT. Every scenario here runs the subject as a
 * genuine operating-system process started by the child-process harness, which writes a copy
 * differing from `server.js` on exactly one line - the port declaration - into a fresh system
 * temp directory AND LAUNCHES THE CHILD IN THAT DIRECTORY. A four-digit replacement keeps the
 * readiness banner exactly READY_BYTES long, so every byte-count assertion below holds unchanged.
 *
 * THE CHILD'S WORKING DIRECTORY IS THE GENERATED ONE, AND THE COLD-START CLAIM DEPENDS ON IT.
 * Writing a copy into an empty directory proves nothing on its own: a child that inherits the
 * runner's working directory resolves modules against THIS REPOSITORY - a tree holding a manifest
 * and hundreds of installed packages - so "starts with zero packages installed" would be asserted
 * about a directory the process never actually ran in. The harness therefore launches the child
 * with that directory as its own, and the cold-start scenario asserts the launch directory rather
 * than assuming it: equal to the generated directory, holding the generated copy, outside the
 * runner's directory entirely, and with no manifest or package tree anywhere on the chain of
 * parents Node would search upward. The claim is then evidence rather than arrangement.
 *
 * EVERY PORT IS ACQUIRED BY PROOF, NEVER ASSUMED FREE. A fixed shifted port is a fixed address
 * like any other: an unrelated process already holding one makes the child fail to bind, and the
 * scenario then fails for a reason that has nothing to do with the subject. No port literal
 * appears in this file and the harness's own default is never relied upon. Instead
 * `acquireFreePort` below walks a four-digit range from a process-derived offset and returns the
 * first candidate a real listening bind proves free, and `spawnOnFreePort` spawns on that port and
 * RE-ACQUIRES if the address was taken between the probe and the bind - a window no check can
 * close, only recover from. Ports handed out are never offered twice within a run, so scenarios
 * cannot collide with each other; the two cases that need two children on ONE address share a
 * single acquired value explicitly, because there a conflict is the point.
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
 * the guard and ~0 ms after it. Terminations are therefore awaited only through the harness's
 * `waitForExit()`, `waitForClose()` and `stop()`, all of which inspect the recorded terminal state
 * before subscribing to anything. No termination event is ever subscribed to directly in this
 * file.
 *
 * 'exit' IS NOT 'close', AND EVERY STREAM ASSERTION HERE NEEDS 'close'. A child's exit and the
 * closure of the pipes the harness reads it through are distinct events: output written just
 * before the process died can still be in flight when 'exit' fires. Every scenario that asserts on
 * `stdout()` or `stderr()` CONTENT therefore sequences on close - through `stop()`, which resolves
 * on close, or through `waitForClose()` for the contended child this file never stops itself.
 * `waitForExit()` remains available for code-and-signal-only questions.
 *
 * CONTRACT E2 - THE CONTENDED CHILD'S READINESS PROMISE IS NEVER AWAITED. In the port-contention
 * scenario the second child ends before it can become ready, so its readiness promise rejects.
 * The harness marks that promise handled at creation, which is what keeps the rejection from
 * aborting the entire run; the scenario awaits only that child's TERMINATION - on close, since it
 * asserts stream content - and then asserts on the recorded code, signal and streams. Every other
 * scenario does await readiness first.
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
 * THE SINGLE-PROCESS PROOF IS PORTABLE, AND IT LIVES IN THE COLD-START SCENARIO. No portable API
 * exposes a process's parentage or process group, and reading a host-specific process table would
 * make the claim conditional on the platform instead of on the subject - the loopback-confinement
 * scenario is the ONLY case here whose declaration depends on the environment, and it stays that
 * way deliberately. The evidence is therefore three portable facts, asserted where the process is
 * first started: not one process-multiplying entry point is even MENTIONED in the code the child
 * executed, that code makes exactly one `require` call so there is nothing it could have imported
 * to spawn with, and terminating that one child is by itself enough to release the address it was
 * serving on - a surviving fork or a detached daemon would still be holding it.
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
 * Lowest port the acquisition walk will offer.
 *
 * Above the privileged range on purpose. A bind below it is refused for want of privilege rather
 * than because anything is listening, and the classifier below treats an unanticipated refusal as
 * a failure to report rather than a verdict to guess at - so offering such a port would turn a
 * permissions fact into an unclassifiable error. Four digits, like the ceiling.
 *
 * @type {number}
 */
const PORT_FLOOR = 1024;

/**
 * Highest port the acquisition walk will offer.
 *
 * The four-digit ceiling, and the reason the readiness banner's byte count is invariant across
 * every scenario here: a port of any other width would change the banner's length and break every
 * READY_BYTES assertion in this file.
 *
 * @type {number}
 */
const PORT_CEILING = 9999;

/**
 * How many candidates the acquisition walk will try before giving up.
 *
 * Bounded so a host with no free four-digit port fails with a legible diagnostic instead of
 * looping. Generous relative to the number of ports this file needs - seven scenarios, at most one
 * acquisition each - while still tiny beside the range being walked, so exhaustion means the host
 * genuinely has nothing to offer rather than that the walk was unlucky.
 *
 * @type {number}
 */
const PORT_ACQUISITION_ATTEMPTS = 64;

/**
 * How many times a scenario's spawn will re-acquire after losing a bind race.
 *
 * A probe proves an address free at the instant it is probed, and the child binds a moment later:
 * nothing can close that window, so it is recovered from instead. More than one retry is pointless
 * on an idle host and more than a few would mask a real conflict, so the bound is small and the
 * final failure carries the original diagnostic as its cause.
 *
 * @type {number}
 */
const SPAWN_ATTEMPTS = 4;

/**
 * Ports already handed out during this file's run, so none is ever offered twice.
 *
 * Two purposes. A port that lost a bind race is recorded before the retry, so the retry cannot
 * hand back the address that just failed. And two scenarios can never be given the same port even
 * if the first one's child has since been torn down and its address released - which keeps each
 * case independent of the order they run in, exactly as distinct fixed ports used to, but without
 * assuming any of them was free.
 *
 * @type {Set<number>}
 */
const claimedPorts = new Set();

/**
 * Where the next acquisition walk starts, seeded from this process so concurrent runs diverge.
 *
 * A walk that always began at the same candidate would put two runners on the same host in step
 * with each other, each probing the port the other is about to bind. Seeding from the process
 * identifier separates them without randomness, so a failure is reproducible from the process it
 * happened in. It advances past every candidate the walk consumes, so successive acquisitions in
 * one run continue where the previous one stopped rather than re-treading it.
 *
 * @type {number}
 */
let portCursor = process.pid;

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
 * Return a four-digit port that a real listening bind has just PROVEN free.
 *
 * This is the whole reason no port literal appears in this file. A fixed shifted port is a fixed
 * address like any other, and an unrelated process already holding it makes the child fail to bind
 * - so the scenario fails for a reason that has nothing to do with the subject. Proving each
 * address before it is used moves that class of failure out of the suite.
 *
 * The proof is the same native bind probe the hygiene scenario rests on, which is what makes it a
 * proof rather than a guess: it attempts the listening bind itself, so it filters on the LISTENING
 * state for free and cannot be fooled by connections winding down on the same local address. No
 * external utility is consulted and no socket table is parsed.
 *
 * Candidates are walked from a process-derived offset rather than chosen randomly, so two runners
 * on one host diverge while a failure stays reproducible from the process it happened in. The walk
 * skips the subject's own port - reserved for the sibling tier that binds it, and rejected by the
 * harness anyway - and skips anything already handed out during this run.
 *
 * @returns {Promise<number>} A four-digit port that was free when probed and is now claimed.
 * @throws {Error} When the bounded walk finds no free candidate, naming every verdict it saw.
 */
async function acquireFreePort() {
  const span = PORT_CEILING - PORT_FLOOR + 1;
  const rejected = [];

  for (let attempt = 0; attempt < PORT_ACQUISITION_ATTEMPTS; attempt += 1) {
    // The cursor only ever increases and is seeded from a positive process identifier, so the
    // remainder is always in range and the candidate is always four digits.
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

    // Recorded so an exhausted walk can say WHAT it saw rather than merely that it failed, and
    // bounded by construction: the list can never hold more entries than the attempt budget, so
    // the diagnostic below has a fixed worst-case size rather than an open-ended one. An
    // unclassifiable refusal never reaches here - the probe rejects on those, and that rejection
    // propagates out of this helper unchanged.
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
 * Spawn a child on a freshly proven port, await its readiness, and return the tracked handle.
 *
 * A probe proves an address free at the instant it is probed, and the child binds a moment later.
 * Nothing can close that window - so instead of pretending it does not exist, this recovers from
 * it: a readiness failure whose diagnostic names a bind conflict is treated as a lost race, the
 * port is left claimed so it is never offered again, and the spawn is retried on a fresh one.
 *
 * Every other readiness failure is re-thrown UNCHANGED, which is what keeps this a race recovery
 * rather than a general retry that could mask a real defect: a child that failed for any other
 * reason fails the scenario exactly as it did before, with its original diagnostic.
 *
 * The returned handle is ALREADY REGISTERED for teardown - registration happens at creation, for
 * every attempt including the ones that lost - so callers must not register it again, and a
 * scenario that fails immediately still has every child and every generated directory reclaimed.
 *
 * @param {object} [options] Harness options; any `port` given is replaced by the acquired one.
 * @returns {Promise<object>} The tracked handle of a child that has reached readiness.
 * @throws {Error} The original readiness failure, or - after the bound is exhausted - a race
 *   diagnostic carrying the last one as its cause.
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
      // A child that is STILL RUNNING cannot have lost a bind race: the readiness failures that
      // leave one alive come from the spawn attempt itself, not from the address. Re-thrown at
      // once - which also keeps the wait below guaranteed to resolve rather than subscribing to a
      // termination that has not happened and may never happen.
      if (!handle.hasExited()) {
        throw readinessFailure;
      }

      // Sequenced on CLOSE, never on exit. The uncaught bind diagnostic is written moments before
      // the process dies and can still be in the pipe when 'exit' fires, so classifying on
      // `stderr()` any earlier would race those bytes and misread a lost race as a real failure.
      // The wait is guarded by the harness, so an already-closed child resolves immediately.
      await handle.waitForClose();

      if (handle.stderr().indexOf(ADDRESS_IN_USE) === -1) {
        throw readinessFailure;
      }

      lastRace = readinessFailure;

      // Released now rather than left to the shared teardown, so a retry does not accumulate
      // generated directories. The harness's cleanup is idempotent, so the teardown still runs
      // over this handle harmlessly.
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
 * Every directory Node would consult when resolving a module from `from` upward, root included.
 *
 * The cold-start claim is about what the child could REACH, not merely about what sits next to it:
 * module resolution walks parents until the filesystem root, so a manifest or a package tree on
 * any ancestor of the child's working directory is reachable from it. Listing the chain lets the
 * scenario assert against all of it and name the offender if one appears.
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

    // The root is its own parent, which is the only portable way to know the walk is finished.
    if (parent === current) {
      return chain;
    }

    current = parent;
  }
}

/**
 * The ENTRY POINTS by which a Node program obtains a second process, or sheds the one it has.
 *
 * Absence of every one of them from the executed code is a structural proof that no fork, no
 * worker, no cluster and no daemonisation path EXISTS to be taken - stronger than observing that
 * none happened on one run. Entry points are listed rather than the module names that host them,
 * for two reasons: a module name alone proves nothing without a call, and naming the process
 * module here would put its own token in this file, where a reader grepping for it should find
 * nothing. Reaching a second process without touching one of these names is not possible, and the
 * cold-start scenario pairs this scan with a count of the executed copy's `require` calls, which
 * closes the only remaining route - importing something to spawn with.
 *
 * @type {ReadonlyArray<string>}
 */
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
  test('S1 starts from a bare checkout as a single foreground process with zero packages installed (F-005-RQ-002, F-005-RQ-004, ST-1)', async () => {
    // Readiness is the proof that the start SUCCEEDED, and it is a stdout pattern match rather
    // than a wait: this resolves the moment the banner appears, and rejects if the child ends
    // first for any reason other than losing the bind race it retries - so a genuinely failed
    // start fails this case rather than running out the safety bound. The port was proven
    // bindable beforehand, and the handle comes back already registered for teardown.
    const handle = await spawnOnFreePort();

    // THE CHILD ACTUALLY RAN THERE - ASSERTED, NOT ASSUMED.
    //
    // Every claim below about "zero packages installed" is a claim about the directory the process
    // resolved modules from, so that directory is established FIRST. A child left to inherit the
    // runner's working directory resolves against THIS REPOSITORY - a tree carrying a manifest and
    // hundreds of installed packages - and the assertions that follow would then be describing a
    // directory the process never entered, passing while proving nothing.
    expect(handle.cwd).toBe(handle.dir);
    expect(path.dirname(handle.file)).toBe(handle.cwd);

    // The direct negation of that defect, stated separately so it cannot be met by coincidence:
    // the launch directory is neither the runner's own nor anywhere beneath it.
    expect(handle.cwd).not.toBe(process.cwd());
    expect(handle.cwd.startsWith(process.cwd() + path.sep)).toBe(false);

    // Nothing was installed for the child, and nothing could have been - not in the directory it
    // ran in, and not on any ancestor of it either, which is as far as module resolution ever
    // looks. Collecting the offenders rather than testing entries one at a time means a failure
    // names the artefact AND the directory it was reachable from.
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

    // ONE PROCESS IN THE FOREGROUND, PROVEN PORTABLY.
    //
    // Read back from the GENERATED COPY rather than from the subject, so the claim describes the
    // code that actually ran in the child. Not one of the process-multiplying entry points is even
    // mentioned in it, which is a structural proof that no fork, no worker, no cluster and no
    // daemonisation path EXISTS to be taken - stronger than observing that none happened on a
    // single run. `detached`, `setsid` and `unref` are on that list precisely because leaving the
    // runner's process group, or letting it stop waiting, is how a foreground process stops being
    // one. Filtered rather than asserted one entry point at a time, so a failure names the
    // offending name.
    const executed = fs.readFileSync(handle.file, 'utf8');
    expect(
      PROCESS_MULTIPLYING_APIS.filter((api) => executed.indexOf(api) !== -1)
    ).toStrictEqual([]);

    // The only remaining route to a second process is importing something to spawn with, so the
    // executed copy's require calls are counted too: exactly one, which is the same single import
    // the cold-start claim above rests on. Counting the CALLS rather than extracting specifiers
    // is deliberate - a computed or double-quoted specifier would escape an extraction while still
    // being an import, and it cannot escape a count.
    expect(executed.match(/\brequire\s*\(/g)).toHaveLength(1);

    // "Single" made consequential, and deliberately without reading any operating-system process
    // table: no portable API exposes parentage, and a host-specific one would make this case
    // conditional on the platform rather than on the subject. Instead the observable consequence
    // is asserted - terminating the ONE child this runner started is enough to release the
    // address it was serving on. A surviving fork or a detached daemon would still be holding
    // that address, so a listening bind succeeding here is positive evidence there was nothing
    // else to survive. The request above ran first, so the address is known to have been occupied
    // by that process rather than never claimed at all.
    await handle.stop(TERMINATION_SIGNAL);
    expect(handle.hasExited()).toBe(true);
    expect(await probeBind(expected.HOST, handle.port)).toBe(FREE);
  });

  test('S2 emits exactly one 41-byte readiness line (F-004-RQ-001)', async () => {
    const handle = await spawnOnFreePort();

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
    const handle = await spawnOnFreePort();

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
    // host or fail by accident on an idle one. The address is one this scenario has just proven
    // free, so the conflict below is the one it arranged and not one it inherited from the host.
    const first = await spawnOnFreePort();

    // Deliberately NOT awaited for readiness: this child cannot become ready, so its readiness
    // promise rejects. The harness marks that promise handled at creation, which is what stops
    // the rejection aborting the run - awaiting it here would instead turn an expected failure
    // into a thrown error and lose the exit-code evidence this case exists to collect.
    //
    // The blocker's OWN port is passed explicitly instead of acquiring a second one, because a
    // conflict is only deterministic when both children aim at the same address. This is one of
    // exactly two places in the file where a port is reused, and the only one where it is reused
    // while KNOWN to be occupied - which is the entire point of the scenario.
    const second = track(spawnServer({ port: first.port }));

    // Only this child's TERMINATION is awaited - never its readiness - and it is awaited through
    // `waitForClose()` rather than `waitForExit()`, because the assertions below read stream
    // CONTENT. 'exit' reports only that the process has ended: the uncaught EADDRINUSE stack
    // trace is written moments before it dies and can still be in the pipe at that point, so an
    // `stderr()` assertion sequenced on 'exit' alone races those bytes. 'close' is emitted once
    // the stdio streams are finished, so both accumulators are complete when this resolves. It
    // reports the same recorded code and signal, and it is guarded identically, so an
    // already-ended child resolves immediately instead of subscribing to an event that can no
    // longer fire (contract D3).
    const outcome = await second.waitForClose();

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
    const before = await spawnOnFreePort();

    const firstStdout = before.stdout();
    const firstResponse = await httpClient.get(before.port);

    // The address has to be genuinely released before it can be reclaimed, so the first process
    // is stopped and its directory removed rather than left to the shared teardown. Both steps
    // are idempotent, so the teardown still runs harmlessly afterwards.
    await before.stop(TERMINATION_SIGNAL);
    await before.cleanup();

    // The SAME port, so this is a restart rather than a second unrelated server - and passed
    // explicitly rather than acquired, because acquiring would hand back a DIFFERENT address and
    // turn a restart into two unrelated servers. Re-probing it first would be theatre: the stop
    // above released it a moment ago, and if anything else has claimed it since, this case must
    // fail loudly rather than quietly relocate and compare two different addresses.
    const after = track(spawnServer({ port: before.port }));
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
      const handle = await spawnOnFreePort();

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
    const handle = await spawnOnFreePort();

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
});
