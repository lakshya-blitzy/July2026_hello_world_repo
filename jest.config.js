/**
 * Jest runner configuration for this repository's HTTP server test suite.
 *
 * This is the only configuration file: it carries the runner, the assertion and
 * mocking hygiene, the coverage instrumentation and the enforcing coverage
 * threshold together.
 *
 * The subject under test is `server.js`, whose `listen()` call runs as an
 * unconditional side effect of `require()`. That single property shapes most of
 * the settings below: a real load binds the fixed address 127.0.0.1:3000, so
 * such loads cannot run concurrently; coverage is scoped to that one file; and
 * captured mock state has to be read eagerly rather than after a hook has
 * cleared it.
 *
 * Two options are deliberately absent, and their absence is load-bearing:
 *
 *   1. The flag that forcibly terminates the runner after the last assertion.
 *      A runner that will not exit is reporting a leaked handle inside a test
 *      helper; that flag hides the leak instead of resolving it.
 *   2. A coverage-instrumentation override, so the default Babel/Istanbul
 *      instrumenter applies. It accounts for the subject's two functions,
 *      whereas the V8 instrumenter accounts for none and would make the
 *      functions threshold below vacuous.
 *
 * @see server.js — the behavioural contract the suite asserts against. It is
 *      reference-only: coverage instrumentation reads it, nothing writes it.
 */

/** @type {import('jest').Config} */
module.exports = {
  // No DOM is involved anywhere in this system. The environment itself arrives
  // transitively with the framework and needs no dependency entry of its own.
  testEnvironment: 'node',

  // Discovery is restricted to the tiered test tree instead of being left to
  // Jest's default glob, so a file elsewhere in the repository whose basename
  // merely resembles a test name is never collected.
  testMatch: ['<rootDir>/test/**/*.test.js'],

  // A real load of the subject binds the fixed address 127.0.0.1:3000, so two
  // workers loading it in parallel collide with EADDRINUSE. The suite also
  // restricts real loading to one test file, which makes the guarantee
  // structural as well as configured. The `test:ci` script additionally passes
  // --runInBand; both are wanted.
  maxWorkers: 1,

  // A safety bound for the child-process tier, never a synchronisation
  // mechanism: nothing in the suite waits on wall-clock time. The ceiling
  // exists so a stuck await fails loudly instead of hanging the run.
  testTimeout: 20000,

  // The strictest hook hygiene available: mock state is cleared and restored
  // between tests. Anything a helper captures through a spy must therefore be
  // snapshotted at capture time and exposed as a plain value, because an
  // accessor that reads mock state at assertion time finds it wiped.
  clearMocks: true,
  restoreMocks: true,

  // Instrumentation is scoped to the subject alone, so helper, fixture and
  // configuration code cannot inflate the figures.
  collectCoverage: true,
  collectCoverageFrom: ['server.js'],

  // Human-readable output for local runs plus machine-readable artefacts for
  // any future pipeline: coverage/coverage-summary.json, coverage/lcov.info
  // and coverage/lcov-report/. The directory is git-ignored.
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov', 'json-summary'],

  // An enforcing gate derived from measurement rather than convention: Istanbul
  // instrumentation of the subject accounts for 9 statements, 0 branches, 2
  // functions and 9 lines, so a 100% ceiling is attainable rather than
  // aspirational. A regression therefore fails the run instead of quietly
  // lowering a number, and a suite that stopped exercising the subject cannot
  // pass: a negative control — passing assertions with the subject never loaded
  // — exits non-zero with explicit threshold violations.
  //
  // What this gate does NOT prove, stated plainly so it is never over-read: it
  // is a SUITE-LIVENESS ALARM, not evidence that the server really starts.
  // Because the subject has no conditionals, `branches` is trivially 100% at
  // 0/0 and every statement is reached by loading the module once — and the
  // stub-mode harness reaches even the second function, the listen callback,
  // because `captureHandlerReady()` flushes that callback through a FAKE
  // `listen` while no socket is ever bound. All four metrics can therefore read
  // 100% with the fixed address never bound at all.
  //
  // Real startup is proved behaviourally instead, by test/e2e/bootstrap.test.js:
  // it loads the subject through the call-through harness
  // (`loadServerReady()`), asserts the real `address()` and the readiness line
  // after the 'listening' event, and serves an actual request over the bound
  // socket. Keep these four numbers at 100 and keep that tier — neither
  // substitutes for the other. The substantive measure of thoroughness is the
  // requirement-identifier mapping carried in the test titles, not this table.
  coverageThreshold: {
    global: {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
  },
};
