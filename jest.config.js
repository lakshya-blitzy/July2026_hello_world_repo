'use strict';

/**
 * Jest configuration for the July2026 hello-world HTTP server.
 *
 * Every setting below exists for a demonstrated reason:
 *
 * - testEnvironment 'node'      no DOM is involved anywhere in this system.
 * - testMatch                   scoped to test/**\/*.test.js so the root-level
 *                               placeholder file is never discovered, even
 *                               though its name matches Jest's default glob.
 * - maxWorkers 1                parallel workers collide on the fixed port
 *                               127.0.0.1:3000 that the bootstrap tier binds.
 * - testTimeout 20000           safety bound for child-process scenarios, not
 *                               an expected duration.
 * - clearMocks / restoreMocks   strictest hook hygiene; captured output must be
 *                               snapshotted at capture time, never read lazily
 *                               from mock state.
 * - collectCoverageFrom         instrumentation is scoped to the subject alone
 *                               so helper and fixture code cannot inflate it.
 * - coverageThreshold 100       an enforcing gate: a run that stops exercising
 *                               server.js fails rather than quietly reporting a
 *                               lower number.
 * - default coverage provider   the Babel/Istanbul provider accounts for the
 *                               file's 2 functions, whereas the v8 provider
 *                               reports 0 and would make the functions
 *                               threshold vacuous.
 *
 * Note: --forceExit must never be added. It masks leaked handles, which is
 * exactly the defect class the suite's unconditional teardown exists to catch.
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.test.js'],
  maxWorkers: 1,
  testTimeout: 20000,
  clearMocks: true,
  restoreMocks: true,
  collectCoverage: true,
  collectCoverageFrom: ['server.js'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov', 'json-summary'],
  coverageThreshold: {
    global: {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100
    }
  }
};
