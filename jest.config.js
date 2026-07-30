/**
 * Jest runner configuration for the July2026 hello-world HTTP server.
 *
 * This is the only configuration file in the suite: it carries the runner, the
 * assertion and mocking hygiene, the coverage instrumentation and the enforcing
 * coverage threshold together. Every option below exists for a demonstrated
 * reason — most were discovered by running the suite design and watching it
 * fail — so each is annotated with the standard (S-*) or implementation
 * contract (D-*) that mandates it. Nothing here is decorative.
 *
 * Subject under test: `server.js`, a 14-line module whose `listen()` call runs
 * as an unconditional side effect of `require()`. That single property drives
 * most of the settings below: real binding of 127.0.0.1:3000 must never happen
 * concurrently, coverage must be scoped to that one file, and mock state must
 * never be read lazily after a hook has cleared it.
 *
 * Discovered tiers (five files, one shared behavioural contract):
 *   test/unit/*.test.js         binds nothing at all
 *   test/integration/*.test.js  ephemeral port 0
 *   test/e2e/bootstrap.test.js  the SOLE binder of 127.0.0.1:3000
 *   test/e2e/lifecycle.test.js  child process on a shifted port
 *
 * Deliberately ABSENT options, each recorded as an anti-regression note. They
 * are described rather than named so that a mechanical audit of this file finds
 * zero occurrences of the option keys it must never contain:
 *
 *   1. The flag that forcibly terminates the runner after the last assertion is
 *      FORBIDDEN by standard S-3 and implementation contract D1. It conceals
 *      leaked handles, which is precisely the defect class the suite's
 *      unconditional teardown exists to catch. A runner that will not exit is
 *      reporting a leak inside a test helper: fix the helper, never silence the
 *      symptom here. The suite is proven to exit cleanly under open-handle
 *      detection without it.
 *   2. No coverage-instrumentation override is declared, so the default
 *      Babel/Istanbul instrumenter applies. That instrumenter accounts for the
 *      subject's 2 functions (with 9 statements, 0 branches and 9 lines),
 *      whereas the alternative V8 instrumenter reports 0 functions and would
 *      render the 100% functions gate below vacuous. The default also matches
 *      the figures published in the project specification.
 *   3. No ignore list for discovered test paths is declared. The root-level
 *      placeholder that used to match Jest's default discovery glob has been
 *      deleted, and the explicit discovery pattern below already excludes it;
 *      such a list is a documented contingency third layer only.
 *   4. No global or file-level setup and teardown hooks are registered. Every
 *      resource — server, socket, child process, temporary directory — is
 *      acquired and released inside the test that needs it, on an unconditional
 *      teardown path, so there is no shared bootstrap state to install.
 *   5. No module rewriting, path aliasing or bundled base-configuration layer
 *      is configured. The subject and the entire suite are plain CommonJS, so
 *      no compilation step is required.
 *   6. No reporting-detail, early-exit, order-randomisation, custom-sequencer
 *      or cache-location overrides are configured. Each would alter reporting
 *      or ordering semantics that the suite's determinism guarantees depend on.
 *
 * @see server.js — the immutable behavioural contract every assertion derives
 *      from. Coverage only ever READS it (standard S-1).
 */

/** @type {import('jest').Config} */
module.exports = {
  // No DOM is involved anywhere in this system. Resolved from the framework
  // install by the transitively supplied `jest-environment-node`, which is
  // deliberately NOT declared as a dependency of its own.
  testEnvironment: 'node',

  // Defence in depth against a proven hazard, not a stylistic choice. A
  // 13-byte root-level `test.js` holding two bare identifiers matched Jest's
  // DEFAULT discovery glob and failed at load with a ReferenceError, producing
  // one failed suite and zero tests. Scoping discovery to the tiered suite
  // directories selects only the intended files, and keeps doing so even if
  // such a file were ever reintroduced at the repository root.
  testMatch: ['<rootDir>/test/**/*.test.js'],

  // Contract D2, a reproduced defect: two files loading the subject under two
  // workers failed with EADDRINUSE on port 3000, while the same files passed
  // under a single worker. Standard S-4. The suite additionally confines all
  // real module loading to test/e2e/bootstrap.test.js, so the guarantee is
  // structural as well as configured — do not raise this while that remains
  // the case. The `test:ci` script also passes --runInBand; both are wanted.
  maxWorkers: 1,

  // A SAFETY BOUND for the child-process tier, never a synchronisation
  // mechanism (standard S-2 forbids waiting on wall-clock time). The full
  // suite completes in well under two seconds; this ceiling exists so a
  // genuinely stuck await fails loudly instead of hanging the run. Contract D3
  // originated in exactly such a hang, which ran to 20,003 ms before the
  // already-exited child case was guarded and completed in 136 ms.
  testTimeout: 20000,

  // The strictest hook hygiene available, enabled deliberately BECAUSE it
  // exposed contracts D5 and D7 during validation. The readiness line is
  // emitted from the listen callback and is therefore asynchronous relative to
  // require(), so a spy's recorded calls read at assertion time were found
  // wiped by automatic clearing. The remedy belongs in the helpers — snapshot
  // captured output at capture time, never expose it as a getter over mock
  // state — so do NOT disable either flag to make a test pass.
  clearMocks: true,
  restoreMocks: true,

  // Instrumentation is scoped to the subject ALONE so helper, fixture and
  // configuration code cannot inflate the figures. Exactly one entry: adding
  // any further glob would break standard S-8's guarantee that the gate
  // measures the subject and nothing else.
  collectCoverage: true,
  collectCoverageFrom: ['server.js'],

  // Human-readable output for local runs plus machine-readable artefacts for
  // any future pipeline: coverage/coverage-summary.json, coverage/lcov.info
  // and coverage/lcov-report/. The directory is git-ignored.
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov', 'json-summary'],

  // Standard S-8 — an enforcing gate, derived from measurement rather than
  // convention. Istanbul instrumentation of the subject reports exactly 9
  // statements, 0 branches, 2 functions and 9 lines, and the suite reaches
  // 100% on all four, so the ceiling is attainable rather than aspirational.
  // The `functions` metric is the meaningful one: the second function is the
  // listen callback, reachable only when a bind genuinely succeeds, so a
  // passing run is itself evidence that startup was really exercised. A
  // negative control (passing assertions that never load the subject) exits
  // non-zero here. NEVER lower these numbers to make a run pass.
  coverageThreshold: {
    global: {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
  },
};
