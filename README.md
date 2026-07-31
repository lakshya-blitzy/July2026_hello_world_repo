# July2026_hello_world_repo

## Testing

Jest 30.4.2 with supertest 7.2.2 covers `server.js` across six dimensions: response payloads, status
codes, headers, startup and shutdown, error handling and edge cases. `server.js` is reference-only —
the harness intercepts `http.createServer` to reach its private handler and private server instance,
so no source edit is required.

### Commands

```bash
npm ci --ignore-scripts --no-fund --no-audit   # install; needed for the tests only
CI=true npm test                               # 5 suites, 63 tests, 100% coverage
```

| Purpose | Command | Verified outcome |
| --- | --- | --- |
| First-time install | `npm install --save-dev --save-exact jest@30.4.2 supertest@7.2.2` | resolves cleanly; generates the lockfile |
| Clean install (reproducible / pipelines) | `npm ci --ignore-scripts --no-fund --no-audit` | `added 332 packages` |
| Run the suite | `CI=true npm test` → `jest` | exit 0; 5 suites, 63 tests passed; 100% on all four coverage metrics |
| Pipeline run | `CI=true npm run test:ci` → `jest --ci --runInBand --detectOpenHandles` | exit 0; **no open-handle warning** |
| Coverage | `npm run test:coverage` → `jest --coverage` | 100% statements / branches / functions / lines |
| Tier subsets | `npm run test:unit`, `npm run test:integration`, `npm run test:e2e` | selects only the named tier — 13, 31 and 19 tests |
| Single file | `npx jest --ci test/e2e/lifecycle.test.js` | 1 suite, 8 tests passed — then see the coverage-gate note below |
| Single test by name | `npx jest --ci -t "SIGTERM"` | 1 test passed, 62 skipped, 4 suites skipped — same note applies |
| Debug | `npm run test:debug` → `node --inspect-brk node_modules/.bin/jest --runInBand` | attaches an inspector, breaks before the first test |
| Syntax gate | `node --check server.js` | exit 0 |
| Audit (whole tree) | `npm audit` | `found 0 vulnerabilities` |
| Audit (shipped artefact) | `npm audit --omit=dev` | `found 0 vulnerabilities` — the production tree is empty |
| Start the app (unchanged) | `npm start` → `node server.js` | still starts from a bare checkout with **zero** packages installed |

`npm run test:watch` (→ `jest --watch`) is provided for interactive local development only and **MUST
NEVER be invoked in an automated or non-interactive context — it does not terminate.**

`--ignore-scripts` is mandated: exactly one package in the resolved tree, `unrs-resolver@1.12.2`,
declares a lifecycle script. `.npmrc` sets it as the project default so every install honours it with
or without the flag. The `overrides` pin of `brace-expansion` to `5.0.8` closes advisory
GHSA-mh99-v99m-4gvg — a denial of service reached through `minimatch` and `glob`/`test-exclude` —
taking `npm audit` from 19 high findings to zero.

**Coverage-gate note.** Coverage is collected on every run and gated at 100%, so a selection that
never loads `server.js` in-process passes its cases and *then* exits non-zero on the gate. That is
the gate working, not a failure of the tests: `test/e2e/lifecycle.test.js` drives the server as a
child process, which contributes nothing to in-process instrumentation. Append `--coverage=false`
when selecting a single file or a single test by name. The threshold itself is never lowered.

### Test target

The entire test target is the single root file `server.js`. Coverage is scoped to it alone
(`collectCoverageFrom: ['server.js']` in `jest.config.js`), so helper, fixture and configuration code
cannot inflate the figures. Discovery is scoped to `<rootDir>/test/**/*.test.js`.

```text
test/
├── unit/handler.test.js              L1 — handler + listen callback in isolation (no socket)
├── integration/contract.test.js      L2 — wire-level response contract (ephemeral port)
├── integration/protocol.test.js      L3 — raw-socket parser/framing behaviour (ephemeral port)
├── e2e/bootstrap.test.js             L4 — real require-time bind + shutdown (ONLY binder of 127.0.0.1:3000)
├── e2e/lifecycle.test.js             L5 — child-process scenarios (runtime-generated, port-shifted copy)
├── helpers/                          captureHandler, loadServer, spawnServer, rawExchange, httpClient
└── fixtures/expected.js              frozen expected-value module
```

### Runtime

- Node.js satisfying **`^22.0.0 || >=24.0.0`** — the range declared in `package.json` `engines`. It
  deliberately admits both the Maintenance-LTS 22.x line and the Active-LTS 24.x line.
- Validated on **Node.js 24.18.1** (Active LTS, supported to 2028-04-30) with **npm 11.18.0**. Node
  24.18.1 bundles npm 11.16.0; either resolves this lockfile.
- An install step is required **for the test suite only**; the application itself continues to run
  with no install at all.
- No environment variables are required — `CI=true` is set only to keep the runner non-interactive.
  No network is required beyond loopback: there is no external service, database or credential.

### Ports

- **TCP `127.0.0.1:3000` must be free before the run.** This is both a pre-condition and a
  post-condition: after a full run **no listening socket remains**. The bootstrap tier releases port
  3000 on an unconditional teardown path, and the lifecycle tier asserts the same for its own fixture
  port with a native bind probe rather than by parsing a socket table.
- `test/e2e/bootstrap.test.js` (L4) is the only file that binds it, because it is the only file that
  loads `server.js` for real. The port is a hard-coded literal with no override path, so there is
  nothing to redirect.
- L1 binds nothing at all — the stub-mode harness records the intended host and port without ever
  creating a socket.
- L2 and L3 mount the captured handler on **ephemeral port `0`**.
- L5 spawns a child process running a runtime-generated, **port-shifted** copy of `server.js` written
  into a temporary directory and removed unconditionally afterwards. The shifted port is deliberately
  four digits, so the readiness line stays exactly 41 bytes.
- A pipeline agent that pre-binds port 3000 will fail the bootstrap and lifecycle tiers.
- The runner is pinned to a single worker (`maxWorkers: 1`) because parallel workers were observed
  colliding on the fixed port. Do not raise it while a test file still loads `server.js` for real.

### Expected values

Every literal below is centralised in the frozen module `test/fixtures/expected.js` — change it there,
once, and every tier follows.

| Constant | Value | Derived from |
| --- | --- | --- |
| `STATUS` | `200` | `server.js` line 7 |
| `CONTENT_TYPE` | `text/plain` | line 8 — **no charset parameter** |
| `BODY` | `Hello, World!\n` | line 9 |
| `BODY_BYTES` | `14` | line 9, measured |
| `BODY_SHA256` | `c98c24b677eff44860afea6f493bbaec5bb1c4cbb209c6fc2bbb47f66ff2ad31` | line 9, measured |
| `HEADER_KEYS` | `connection`, `content-length`, `content-type`, `date`, `keep-alive` | runtime-generated, measured — asserted as a complete **set** |
| `CONTENT_LENGTH` | `14` | runtime-generated |
| `KEEP_ALIVE` | `timeout=5` | runtime default, measured |
| `FORBIDDEN_HEADERS` | `server`, `x-powered-by` | verified **absent** (no version disclosure) |
| `HOST` | `127.0.0.1` | line 3 |
| `PORT` | `3000` | line 4 |
| `READY_LINE` | `Server running at http://127.0.0.1:3000/` | line 13 |
| `READY_BYTES` | `41` | line 13, measured with its newline |
| `MALFORMED_RESPONSE` | `HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n` | runtime parser, measured |
| `OVERSIZED_RESPONSE` | `HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n` | runtime parser, measured |

The five-key set is what a **keep-alive** `GET` receives; a client sending `Connection: close`, and any
`HEAD`, is answered with four keys, so asking for persistence is the consumer's responsibility. The
`400` and `431` outcomes are ordinary responses produced by the Node HTTP parser beneath the handler —
they are asserted on their response bytes and are never treated as thrown or rejected operations.

### Coverage and reporters

- Collected on every run (`collectCoverage: true`), scoped to `server.js`, written to `coverage/`.
- Reporters `text`, `text-summary`, `lcov`, `json-summary` — human-readable output for local runs plus
  machine-readable artefacts for any future pipeline: `coverage/coverage-summary.json`,
  `coverage/lcov.info`, `coverage/lcov-report/`.
- The default Babel/Istanbul provider is used, not V8: V8 accounts for **0** functions in this file,
  which would make a `functions: 100` gate vacuous. Istanbul reports **9 statements, 0 branches, 2
  functions, 9 lines**.
- `coverageThreshold` is **100 for statements, branches, functions and lines**, so a regression fails
  the build rather than quietly lowering a number. The gate has teeth: a suite whose assertions all
  pass but which never loads `server.js` reports 0% coverage and **exits non-zero** with explicit
  threshold violations for statements, lines and functions.
- `--forceExit` is deliberately never used — it conceals exactly the leaked-handle class the suite's
  unconditional teardown exists to catch. `test:ci` runs `--detectOpenHandles` instead, and reports
  none.
- `coverage/` and `node_modules/` are git-ignored (see `.gitignore`).

### Provenance

Measured rather than estimated, on **Node.js 24.18.1 / npm 11.18.0**: 63 tests across 5 suites in
0.881 s of runner time (1.386 s under `test:ci`); 332 installed packages; 0 audit findings on the whole
tree and on the production tree; 100% on all four coverage metrics (9/9, 0/0, 2/2, 9/9); the 14-byte
body with digest `c98c24b6…ad31`; and the 41-byte readiness line. The installed `jest` package is
30.4.2 while its CLI self-reports 30.4.1, because the constituent packages version independently.

`server.js` was **not modified** by this work — its SHA-256 remains
`332fc2d04eb5b8f3cb230855457af80d0dfc246f958d6e49615610d656acc2e0`, byte-identical to the committed
original, after a complete passing run. The harness reaches the module's private request handler and
private server instance by intercepting `http.createServer`, which is why no edit was required.

Because `server.js` contains no conditionals, branch coverage is trivially 100% at 0/0 and statement
coverage saturates as soon as the module is loaded once. **Full coverage on this file is therefore
best understood as a suite-liveness alarm, not as evidence of behavioural thoroughness.** The
substantive measure is requirement coverage, which moves from **0 of 20 to 20 of 20** catalogued
requirement identifiers — which is why every test title carries its requirement ID in the form
`<behaviour in present tense> (<F-ID>)`.

The suite deliberately documents rather than fixes the server's robustness gaps: there is no `'error'`
listener, so a bind conflict surfaces as an uncaught exception and a non-zero exit with an
`EADDRINUSE` diagnostic on stderr; there is no signal handling; there is no `server.close()`; and the
host and port are hard-coded with no override path. All four are asserted as current behaviour.

No user-specified rules exist for this project, so the suite is held to enterprise-standard best
practice; the eleven self-imposed standards evidenced above stand in their place.
