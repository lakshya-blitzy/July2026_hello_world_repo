# July2026_hello_world_repo

## Testing

Jest 30.4.2 with supertest 7.2.2 covers `server.js` across six dimensions: response payloads, status
codes, headers, startup and shutdown, error handling and edge cases. `server.js` is reference-only —
the harness intercepts `http.createServer` to reach its private handler and private server instance,
so no source edit is required.

### Commands

```bash
npm ci --ignore-scripts --no-fund --no-audit   # install; needed for the tests only
CI=true npm test                               # 5 suites, 61 tests, 100% coverage
```

| Purpose | Command | Verified outcome |
| --- | --- | --- |
| Install | `npm ci --ignore-scripts --no-fund --no-audit` | `added 332 packages in 1s` |
| Run the suite | `CI=true npm test` → `jest` | exit 0; 5 suites, 61 tests passed; 100% on all four coverage metrics |
| Pipeline run | `CI=true npm run test:ci` → `jest --ci --runInBand --detectOpenHandles` | exit 0; **no open-handle warning** |
| Coverage | `npm run test:coverage` → `jest --coverage` | 100% statements / branches / functions / lines |
| Tier subsets | `npm run test:unit`, `npm run test:integration`, `npm run test:e2e` | 13, 31 and 17 tests |
| Single file | `npx jest --ci test/e2e/bootstrap.test.js` | 1 suite, 10 tests passed, 100% coverage |
| Single file, child-process tier | `npx jest --ci test/e2e/lifecycle.test.js --coverage=false` | 1 suite, 7 tests passed — the flag is required, see below |
| Single test by name | `npx jest --ci -t "SIGTERM" --coverage=false` | 1 passed, 60 skipped, 4 suites skipped |
| Debug | `npm run test:debug` → `node --inspect-brk node_modules/.bin/jest --runInBand` | attaches an inspector, breaks before the first test |
| Syntax gate | `node --check server.js` | exit 0 |
| Audit | `npm audit`, `npm audit --omit=dev` | `found 0 vulnerabilities` from both — the production tree is empty |
| Start the app | `npm start` → `node server.js` | serves `http://127.0.0.1:3000/` from a bare checkout with **zero** packages installed |

**Run every command from the repository root.** The harnesses resolve the subject as
`path.resolve(process.cwd(), 'server.js')`, so a bare `npx jest` started from a subdirectory fails
every case with `unable to resolve the subject at <cwd>/server.js (ENOENT …)` — measured from
`test/unit`: 5 failed suites, 61 failed / 61 total. That is the harnesses' own drift alarm firing,
not a broken suite. All nine `npm run` entry points are cwd-safe, because npm resets the working
directory to the package root: `npm run test:unit` from that same subdirectory passes 13/13.

`npm run test:watch` (→ `jest --watch`) is provided for interactive local development only and **MUST
NEVER be invoked in an automated or non-interactive context — it does not terminate.**

`-t` takes a **regular expression**, and every test title ends in a parenthesised identifier, so
select on a substring that omits the suffix — `-t "SIGTERM"` — or escape the parentheses:
`-t "records the intended port and host without binding a socket \(F-002-RQ-001\)"`. An unescaped
`(F-002-RQ-001)` is read as a capture group and silently matches nothing.

`--ignore-scripts` has to be passed on the command line every time, because this repository ships no
npm configuration file and nothing sets the flag for you; it does not affect `npm run <script>`,
`npm test` or `npm start`. It is needed because two of the 361 lockfile entries declare an install
script — `unrs-resolver@1.12.2`, which `jest-resolve` requires and which is installed on every
platform, and `fsevents@2.3.3`, which is optional and macOS-only and so is never fetched here.
Nothing is lost by switching them off: the native binding `unrs-resolver`'s script would otherwise
fetch arrives as an ordinary optional dependency (`@unrs/resolver-binding-linux-x64-gnu` on this
platform), so Jest resolves normally.

`overrides` holds exactly one entry — `brace-expansion` pinned to `5.0.8`, which closes advisory
GHSA-mh99-v99m-4gvg, a denial of service reached through `minimatch` and `glob`/`test-exclude`,
taking `npm audit` from 19 high-severity findings to zero on both the whole tree and the production
tree. Keep every `jest.config.js` pattern brace-free: the `minimatch`/`glob` generation Jest 30.4.2
resolves still imports the callable default export that `brace-expansion@5` removed, so a
brace-bearing pattern would throw. Neither shipped pattern contains one.

**Coverage-gate note.** Coverage is collected on every run and gated at 100%, so a selection that
never loads `server.js` in-process passes its cases and *then* exits non-zero on the gate — that is
the gate working, not a failing test. `test/e2e/lifecycle.test.js` drives the server as a child
process and so contributes nothing to in-process instrumentation: append `--coverage=false` when
selecting a single file or a single test by name. `test/e2e/bootstrap.test.js` needs no flag, because
it loads the subject for real and serves a request, reaching 100% on its own. The threshold itself is
never lowered.

### Test target

The entire test target is the single root file `server.js`. Coverage is scoped to it alone
(`collectCoverageFrom: ['server.js']` in `jest.config.js`), so helper, fixture and configuration code
cannot inflate the figures. Discovery is scoped to `<rootDir>/test/**/*.test.js`.

```text
test/
├── unit/handler.test.js              L1 — handler + listen callback in isolation (no socket at all)
├── integration/contract.test.js      L2 — wire-level response contract (ephemeral port)
├── integration/protocol.test.js      L3 — raw-socket parser/framing behaviour (ephemeral port)
├── e2e/bootstrap.test.js             L4 — real require-time bind + shutdown (ONLY binder of 127.0.0.1:3000)
├── e2e/lifecycle.test.js             L5 — child-process scenarios (generated copy, acquired free port)
├── helpers/                          captureHandler, loadServer, spawnServer, rawExchange, httpClient
└── fixtures/expected.js              frozen expected-value module
```

### Runtime

- Node.js satisfying **`^22.0.0 || >=24.0.0`** — the range declared in `package.json` `engines`, which
  admits both the Maintenance-LTS 22.x line and the Active-LTS 24.x line.
- Validated on **Node.js 24.18.1** with **npm 11.18.0**.
- An install step is required **for the test suite only**; the application itself runs with none.
- No environment variables, services, databases or credentials are required, and no network beyond
  loopback. `CI=true` is set only to keep the runner non-interactive.

### Ports

- **TCP `127.0.0.1:3000` must be free before the run, and it is the suite's only port
  precondition** — both a pre-condition and a post-condition, since after a full run no listening
  socket remains.
- `test/e2e/bootstrap.test.js` (L4) is the **only** file that binds it, because it is the only file
  that loads `server.js` for real, and the port is a hard-coded literal with no override path. A
  pre-bound port therefore fails that tier and nothing else; the remedy is to free the port rather
  than edit the behavioural contract this suite asserts.
- **L1 binds nothing at all** — no fixed port, no ephemeral port, no socket of any kind. The
  stub-mode harness hands the subject a recorder whose `listen` only stores its arguments, so the
  intended host and port are asserted structurally while the address they name is left untouched.
  `npm run test:unit` consequently has no port precondition.
- L2 and L3 mount the captured handler on **ephemeral port `0`**.
- L5 spawns a child running a runtime-generated, **port-shifted** copy of `server.js` from a fresh
  temporary directory, which is also the directory the child is launched in. That launch directory is
  asserted rather than assumed, together with the absence of any manifest or package tree on every
  ancestor Node would search, which is what makes the cold-start claim evidence rather than
  arrangement. It is not why the copy resolves its import: that import is the built-in `http`, so no
  package lookup happens at all. The directory is removed unconditionally afterwards.
- **L5 acquires every port by proof and has no fixed port of its own.** Each scenario walks a
  four-digit range from a process-derived offset and takes the first candidate a real listening bind
  proves free, never offering the same port twice in one run; four digits keeps the readiness line
  exactly 41 bytes. A child that loses the race between the probe and its own bind is identified by
  its `EADDRINUSE` diagnostic and re-spawned on a freshly proven port, bounded at four attempts,
  while every other start failure is reported unchanged. The two scenarios that need two children on
  **one** address — port contention and restart — share a single acquired value explicitly, which is
  the only place a port is deliberately reused.
- The runner is pinned to a single worker (`maxWorkers: 1`) because parallel workers were observed
  colliding on the fixed port. Do not raise it while a test file still loads `server.js` for real.
- The loopback-confinement scenario needs a non-loopback IPv4 address in order to show that interface
  being refused, so it declares itself through `test.skip` on a host that has none. It is the only
  case in the suite whose declaration depends on the environment, which is why the counts above are
  quoted as declared.

**If something else already holds the port.** Measured with an external holder pre-bound on
`127.0.0.1:3000`: **one suite fails and 9 of the 61 cases fail** with
`listen EADDRINUSE: address already in use 127.0.0.1:3000` — nine of the ten bootstrap cases. The
tenth passes because it is purely structural and never needs the bind to succeed
(`exposes no API and depends on nothing but one built-in module`), and the unit, contract, protocol
and lifecycle tiers all pass, because none of them touches that address: selected alone under the
same holder, `npm run test:unit` reports 13 passed and `test/e2e/lifecycle.test.js` reports 7
passed. The remedy is to free the port, never to change it: `server.js` hard-codes the endpoint and
is the behavioural contract this suite asserts, so it is read and never edited. The usual holders
are a stray `node server.js` left behind by an earlier `npm start` and a second checkout of this
repository running its own bootstrap tier at the same moment. Check the port with a bind probe
rather than a process listing, because a closed client connection legitimately lingers in
`TIME_WAIT` on the same local address — the same reason the suite's own hygiene assertions filter on
socket state. It prints `free` and exits 0, or the refusal code and exits 1:

```bash
node -e "const s=require('net').createServer();s.once('error',e=>{console.log(e.code);process.exit(1)});s.once('listening',()=>{console.log('free');s.close()});s.listen(3000,'127.0.0.1')"
```

`npm start` runs `node server.js` as a **child** of the npm wrapper, and stopping the wrapper alone
does not stop that child: measured on npm 11.18.0, `SIGTERM` to the wrapper exits it with 143 while
the `node server.js` process keeps `127.0.0.1:3000` bound. Signal the `node server.js` process
itself — or run it directly rather than through npm — when you need the port back.

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

The five-key set is what a **keep-alive `GET`** receives, so asking for persistence is the consumer's
responsibility; the method and the disposition each drop one key, measured on the wire:

| Request | Keys | Set |
| --- | --- | --- |
| `GET`, `Connection: keep-alive` | 5 | `connection`, `content-length`, `content-type`, `date`, `keep-alive` |
| `GET`, `Connection: close` | 4 | `connection`, `content-length`, `content-type`, `date` |
| `HEAD`, `Connection: keep-alive` | 4 | `connection`, `content-type`, `date`, `keep-alive` |
| `HEAD`, `Connection: close` | 3 | `connection`, `content-type`, `date` |

`content-length` goes with the body the runtime suppresses for a `HEAD`, and `keep-alive` exists only
while the connection does. `HEADER_KEYS` is therefore asserted against keep-alive `GET` requests,
while the `HEAD` key set is *derived* from it by dropping `content-length` rather than restated, so a
change to either half fails a test instead of quietly disagreeing. The zero-body property is proved
separately on the raw bytes, because a compliant client discards a `HEAD` body by specification and
would report an empty body even if the server had wrongly written some. The `400` and `431` outcomes
are ordinary responses produced by the Node HTTP parser beneath the handler — asserted on their
response bytes, never treated as thrown or rejected operations.

### Coverage and reporters

- Collected on every run (`collectCoverage: true`), scoped to `server.js`, written to `coverage/`.
- Reporters `text`, `text-summary`, `lcov`, `json-summary` — console output for local runs plus
  `coverage/coverage-summary.json`, `coverage/lcov.info` and `coverage/lcov-report/` for a pipeline.
- The default Babel/Istanbul provider is used, not V8: V8 accounts for **0** functions in this file,
  which would make a `functions: 100` gate vacuous. Istanbul reports **9 statements, 0 branches,
  2 functions, 9 lines**.
- `coverageThreshold` is **100 for statements, branches, functions and lines**, so a regression fails
  the build rather than quietly lowering a number. The gate has teeth: a suite whose assertions all
  pass but which never loads `server.js` reports 0% and exits non-zero, naming statements, lines and
  functions.
- `--forceExit` is deliberately never used — it conceals exactly the leaked-handle class the suite's
  unconditional teardown exists to catch. `test:ci` runs `--detectOpenHandles` instead, and reports
  none.
- `coverage/` and `node_modules/` are git-ignored (see `.gitignore`).

### Provenance

Measured rather than estimated, on **Node.js 24.18.1 / npm 11.18.0**: 61 tests across 5 suites in
0.71–0.73 s of runner time across five runs (1.21–1.28 s under `test:ci`); 13 / 31 / 17 tests in the
unit, integration and e2e subsets; **332 installed packages from 361 lockfile entries**
(`lockfileVersion 3`); zero audit findings on the whole tree and on the production tree, which
`npm ls --omit=dev --all` reports as empty; 100% on all four coverage metrics (9/9, 0/0, 2/2, 9/9);
the 14-byte body with digest `c98c24b6…ad31`; and the 41-byte readiness line. The installed `jest`
package is 30.4.2 while its CLI self-reports 30.4.1, because the constituent packages version
independently.

`server.js` was **not modified** by this work — its SHA-256 remains
`332fc2d04eb5b8f3cb230855457af80d0dfc246f958d6e49615610d656acc2e0`, byte-identical to the committed
original, after a complete passing run. The harness reaches the module's private request handler and
private server instance by intercepting `http.createServer`, which is why no edit was required.

Because `server.js` contains no conditionals, branch coverage is trivially 100% at 0/0 and statement
coverage saturates as soon as the module is loaded once. **Full coverage on this file is therefore
best understood as a suite-liveness alarm, not as evidence of behavioural thoroughness.** The
substantive measure is requirement coverage: all **20 of 20** catalogued requirement identifiers are
exercised by at least one case.

**Traceability.** Every test title ends in the identifier of the thing it proves, in the form
`<behaviour in present tense> (<ID>)`, so the mapping is checkable from the titles alone. The ID is a
requirement ID (`F-002-RQ-001`) wherever the behaviour is one of the 20 catalogued requirements, and
otherwise the applicable **supplemental-standard** ID, because five cases assert runtime or security
properties that no `F-` requirement covers: version-header non-disclosure (`ST-3`), the parser's
`400` and `431` rejections (`ST-6`, twice) and unthrottled concurrent service together with
event-driven exchange settling (`ST-7`, twice). Six further titles carry both kinds at once, from
three declarations — one of them a `test.each` that expands into the four input-inertness cases — and
the lifecycle tier additionally prefixes its scenario ID (`S1`…`S7`). Counting declarations rather
than the titles the runner reports is what makes those two numbers differ, so both are given.

The suite deliberately documents rather than fixes the server's robustness gaps: there is no `'error'`
listener, so a bind conflict surfaces as an uncaught exception and a non-zero exit with an
`EADDRINUSE` diagnostic on stderr; there is no signal handling; there is no `server.close()`; and the
host and port are hard-coded with no override path. All four are asserted as current behaviour.
