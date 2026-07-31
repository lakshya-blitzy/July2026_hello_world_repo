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
| First-time install, from no manifest at all | `npm install --save-dev --save-exact --ignore-scripts --no-fund --no-audit jest@30.4.2 supertest@7.2.2` | `added 334 packages`; pins both at exact versions and generates a `lockfileVersion 3` lockfile. This is the **pre-`overrides`** figure — it also reports 19 advisories, all of which the `overrides` pin below clears |
| Install against the committed manifest | `npm install --ignore-scripts --no-fund --no-audit` | `added 332 packages`; resolves the `overrides` pin, 361 lockfile entries |
| Clean install (reproducible / pipelines) | `npm ci --ignore-scripts --no-fund --no-audit` | `added 332 packages in 1s` |
| Run the suite | `CI=true npm test` → `jest` | exit 0; 5 suites, 61 tests passed; 100% on all four coverage metrics |
| Pipeline run | `CI=true npm run test:ci` → `jest --ci --runInBand --detectOpenHandles` | exit 0; **no open-handle warning** |
| Coverage | `npm run test:coverage` → `jest --coverage` | 100% statements / branches / functions / lines |
| Tier subsets | `npm run test:unit`, `npm run test:integration`, `npm run test:e2e` | selects only the named tier — 13, 31 and 17 tests |
| Single file | `npx jest --ci test/e2e/bootstrap.test.js` | 1 suite, 10 tests passed, 100% coverage |
| Single file, child-process tier | `npx jest --ci test/e2e/lifecycle.test.js` | 1 suite, 7 tests passed — then see the coverage-gate note below |
| Single test by name | `npx jest --ci -t "SIGTERM"` | 1 test passed, 60 skipped, 4 suites skipped — same note applies |
| Brace-free-pattern check (after any config change) | `node -e "const c=require('./jest.config.js');console.log([...c.testMatch,...c.collectCoverageFrom].filter(p=>p.includes('{')).length)"` | `0` — no configured pattern contains a brace, which is the invariant the override note below explains |
| Debug | `npm run test:debug` → `node --inspect-brk node_modules/.bin/jest --runInBand` | attaches an inspector, breaks before the first test |
| Syntax gate | `node --check server.js` | exit 0 |
| Audit (whole tree) | `npm audit` | `found 0 vulnerabilities` |
| Audit (shipped artefact) | `npm audit --omit=dev` | `found 0 vulnerabilities` — the production tree is empty |
| Start the app (unchanged) | `npm start` → `node server.js` | still starts from a bare checkout with **zero** packages installed |

`npm run test:watch` (→ `jest --watch`) is provided for interactive local development only and **MUST
NEVER be invoked in an automated or non-interactive context — it does not terminate.**

`-t` takes a **regular expression**, and every test title ends in a parenthesised identifier — a
requirement ID for the cases that trace to one, otherwise the standard or scenario ID that applies
(see *Traceability* below) — so select either on a substring that omits the suffix —
`-t "SIGTERM"` — or on the full title with the parentheses escaped:
`-t "records the intended port and host without binding a socket \(F-002-RQ-001\)"`.
An unescaped `(F-002-RQ-001)` is read as a capture group and silently matches nothing.

`--ignore-scripts` is mandated, and it has to be **passed on the command line every time**: this
repository ships no npm configuration file, so nothing sets the flag for you. Two packages in the
resolved tree declare an install script — `unrs-resolver@1.12.2`, which is reached through
`jest-resolve` and installed on every platform, and `fsevents@2.3.3`, which is optional and
macOS-only and so is not even fetched here. Every install command above carries the flag for that
reason; `npm ci --ignore-scripts` is the one to copy into a pipeline. The flag does not affect
`npm run <script>`, `npm test` or `npm start`, so all nine scripts work unchanged, and the native
binding `unrs-resolver` needs arrives as an ordinary optional dependency from the registry rather
than being built by the script — which is why Jest resolves normally with scripts disabled.

**`overrides` holds exactly one entry, and what that entry does and does not cover.**
`brace-expansion` is pinned to `5.0.8` to close advisory GHSA-mh99-v99m-4gvg, a denial of service
reached through `minimatch` and `glob`/`test-exclude`. The advisory covers every release up to and
including `5.0.7` and no earlier line carries a backport, so the pin cannot be relaxed or satisfied
on an older branch. Measured on the shipped graph: a first-time install without the pin reports
**19 high-severity advisories**, and with it `npm audit` and `npm audit --omit=dev` both report
`found 0 vulnerabilities` while the suite stays green at 61 passed and 100% coverage. The automated
remediation npm proposes instead — `jest@25.0.0` — is **rejected**: it regresses the runner by five
major versions.

What the pin does **not** do is modernise the packages that consume `brace-expansion`.
`brace-expansion@5.x` replaced a callable default export with named exports (`expand`), while the
versions Jest 30.4.2 resolves — `minimatch@9.0.9` (declares `^2.0.2`), a nested `minimatch@3.1.5`
(declares `^1.1.7`), `test-exclude@6.0.0` and `glob@10.5.0` — still import the callable form. The
consequence is narrow but real, and measured rather than assumed: a pattern **containing braces**
throws (`minimatch@9` and `glob@10.5.0` raise
`TypeError: (0 , brace_expansion_1.default) is not a function`; `minimatch@3.1.5` and a
default-options `test-exclude@6.0.0` raise `TypeError: expand is not a function`), while every
brace-free pattern works normally.

Nothing this project runs is affected, and that is a property to check rather than assume:
`jest.config.js` declares exactly two pattern strings — `testMatch` and `collectCoverageFrom` — and
neither contains a brace (the check is in the table above), while the coverage path is safe because
`@jest/transform` invokes `babel-plugin-istanbul` with `exclude: []` and `extension: false`, so
`test-exclude` never evaluates the brace-bearing default exclude list that would otherwise throw.
Keep both properties true: if a future pattern needs a brace, expand it into separate brace-free
patterns rather than reaching for another `overrides` entry.

Two consequences of staying on this graph are recorded here so neither looks like an oversight.
`npm ci` prints deprecation notices for `inflight@1.0.6`, `glob@7.2.3` and `glob@10.5.0`; they are
upstream lineage, they carry **no** open advisory in this tree (`npm audit` is clean), and they are
deliberately **not** papered over by forcing newer `glob`/`test-exclude` majors into consumers that
declare older ranges — that is a second unverified override, not a fix. The real remedy is an
upstream Jest/Istanbul generation whose `minimatch` declares `brace-expansion ^5` natively, which is
a dependency upgrade for whoever owns the plan, not a local pin.

**Coverage-gate note.** Coverage is collected on every run and gated at 100%, so a selection that
never loads `server.js` in-process passes its cases and *then* exits non-zero on the gate. That is
the gate working, not a failure of the tests: `test/e2e/lifecycle.test.js` drives the server as a
child process, which contributes nothing to in-process instrumentation. Append `--coverage=false`
when selecting a single file or a single test by name. The threshold itself is never lowered.
Measured both ways: `test/e2e/lifecycle.test.js` alone reports 7 passed and exits 1 on the gate —
naming statements, lines and functions at 0% — and exits 0 with the flag; `-t "SIGTERM"` reports
1 passed / 60 skipped and behaves identically. `test/e2e/bootstrap.test.js` alone needs no flag: it
loads the subject for real and serves a request, so it reaches 100% on its own.

**Two legitimate case counts.** The loopback-confinement scenario needs a routable IPv4 address to
prove that the non-loopback interface is refused, so it declares itself through `test.skip` when the
host has none. It is the **only** case in the suite whose declaration depends on the environment.
Both outcomes are correct and both were measured on this host — the second by hiding the routable
interface from `os.networkInterfaces()`: **61 passed / 61 total** with a routable address, and
60 passed / 1 skipped / 61 total without one (17 → 16 passed / 1 skipped in the `test:e2e` subset).

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

- Node.js satisfying **`^22.0.0 || >=24.0.0`** — the range declared in `package.json` `engines`. It
  deliberately admits both the Maintenance-LTS 22.x line and the Active-LTS 24.x line.
- Validated on **Node.js 24.18.1** (Active LTS, supported to 2028-04-30) with **npm 11.18.0**. Node
  24.18.1 bundles npm 11.16.0; either resolves this lockfile.
- An install step is required **for the test suite only**; the application itself continues to run
  with no install at all.
- No environment variables are required — `CI=true` is set only to keep the runner non-interactive.
  No network is required beyond loopback: there is no external service, database or credential.

### Ports

- **TCP `127.0.0.1:3000` must be free before the run — and it is the suite's *only* port
  precondition.** This is both a pre-condition and a post-condition: after a full run **no listening
  socket remains**. The bootstrap tier releases port 3000 on an unconditional teardown path, and the
  lifecycle tier asserts the same for the port it acquired, with a native bind probe rather than by
  parsing a socket table.
- `test/e2e/bootstrap.test.js` (L4) is the **only** file in the suite that binds it, because it is
  the only file that loads `server.js` for real. The port is a hard-coded literal with no override
  path, so there is nothing to redirect. Its first case reads the address back from `address()` on
  the real server, which is where the kernel-level proof of the endpoint lives.
- **L1 binds nothing at all** — not the fixed port, not an ephemeral one, no socket of any kind. The
  stub-mode harness hands the subject a plain recorder whose `listen` only stores its arguments, so
  the intended host and port can be asserted while the address they name is left untouched. The
  endpoint case proves that structurally rather than by binding: it inspects the object the subject
  called `listen` on and shows it has `Object.prototype` for a prototype, exactly the two recording
  slots and the recording method for own properties, and none of the `address`/`close`/`listening`
  surface a bound server would carry. `npm run test:unit` therefore has **no port precondition** and
  passes while another process holds `127.0.0.1:3000` — verified by running it against an external
  holder.
- L2 and L3 mount the captured handler on **ephemeral port `0`**.
- L5 spawns a child process running a runtime-generated, **port-shifted** copy of `server.js`, written
  into a fresh temporary directory that the child is also **launched in** (`cwd`). Its module-resolution
  root is therefore that empty directory rather than this repository, which is what makes the
  cold-start claim evidence rather than arrangement — the scenario asserts the launch directory, that
  it is not the runner's own and not beneath it, and that no manifest or package tree exists on any
  ancestor Node would search. The directory is removed unconditionally afterwards.
- **L5 acquires every port by proof, and has no fixed port and no port precondition of its own.** Each
  scenario walks a four-digit range from a process-derived offset and takes the first candidate a real
  listening bind proves free, never offering the same port twice in one run. Four digits is deliberate:
  it keeps the readiness line exactly 41 bytes. A probe can only prove an address free at the instant
  it is probed, so a child that loses the race between the probe and its own bind is identified by its
  `EADDRINUSE` diagnostic and re-spawned on a freshly proven port, bounded at four attempts; every
  other start failure is reported unchanged rather than retried. Verified against an external holder:
  the tier passes with the *previously* fixed ports 4311, 4312 and 4313 all occupied, and it also
  passes with the **first 40 candidates of its own walk** pre-bound — measured by publishing the
  runner's in-band pid and gating the run until the holder confirmed all 40 addresses bound. Hold more
  candidates than the walk's 64-attempt budget and it fails in milliseconds with a diagnostic naming
  the range, the host and every verdict it saw, rather than looping.
- The two scenarios that need two children on **one** address — port contention and restart — share a
  single acquired value explicitly. That is the only place a port is deliberately reused, and in the
  contention case reusing an address while it is *known* to be occupied is the entire point.
- A pipeline agent that pre-binds port 3000 will fail the bootstrap tier and nothing else. The unit,
  contract, protocol and lifecycle tiers are unaffected: none of them touches that address.
- The runner is pinned to a single worker (`maxWorkers: 1`) because parallel workers were observed
  colliding on the fixed port. Do not raise it while a test file still loads `server.js` for real.

**If something else already holds the port.** Measured with an external holder on
`127.0.0.1:3000`: **9 of the 10 bootstrap cases fail** with
`listen EADDRINUSE: address already in use 127.0.0.1:3000`, the tenth passes because it is purely
structural and never needs the bind to succeed, and **all four other suites pass** — 52 passed /
9 failed / 61 total, one failed suite. Selected alone under that same holder, `test:unit` reports
13 passed and `test/e2e/lifecycle.test.js` reports 7 passed, which is the positive confirmation that
neither tier depends on that address. The remedy is to free the port, never to change it:
`server.js` hard-codes the endpoint and is the
behavioural contract this suite asserts, so it is read and never edited. The usual holders are a
stray `node server.js` left behind by an earlier `npm start` and a second checkout of this
repository running its own bootstrap tier at the same moment. Check the port with a bind probe
rather than a process listing, because a closed client connection legitimately lingers in
`TIME_WAIT` on the same local address — the same reason the suite's own hygiene assertions filter on
socket state:

```bash
node -e "const s=require('net').createServer();s.once('error',e=>{console.log(e.code);process.exit(1)});s.once('listening',()=>{console.log('free');s.close()});s.listen(3000,'127.0.0.1')"
```

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

The five-key set is what a **keep-alive `GET`** receives, so asking for persistence is the
consumer's responsibility, and the method and disposition each drop one key. Measured on the wire,
all four combinations:

| Request | Keys | Set |
| --- | --- | --- |
| `GET`, `Connection: keep-alive` | 5 | `connection`, `content-length`, `content-type`, `date`, `keep-alive` |
| `GET`, `Connection: close` | 4 | `connection`, `content-length`, `content-type`, `date` |
| `HEAD`, `Connection: keep-alive` | 4 | `connection`, `content-type`, `date`, `keep-alive` |
| `HEAD`, `Connection: close` | 3 | `connection`, `content-type`, `date` |

`content-length` goes with the body the runtime suppresses for a `HEAD`, and `keep-alive` exists
only while the connection does. `HEADER_KEYS` above is therefore asserted against keep-alive `GET`
requests, and the `HEAD` cases assert that same set minus `content-length` — derived from the
fixture rather than restated, so a change to either half fails a test instead of quietly
disagreeing. The close-disposition `HEAD` case asserts the zero-body property on the bytes rather
than the key set, because the connection ends and the whole response is in hand. The `400` and `431`
outcomes are ordinary responses produced by the Node HTTP parser beneath the handler — they are
asserted on their response bytes and are never treated as thrown or rejected operations.

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

Measured rather than estimated, on **Node.js 24.18.1 / npm 11.18.0**: 61 tests across 5 suites in
0.705 s of runner time (1.194 s under `test:ci`); 13 / 31 / 17 tests in the unit, integration and
e2e subsets; **332 installed packages from 361 lockfile entries** (`lockfileVersion 3`, every entry
carrying a `resolved` URL and an `integrity` digest); 0 audit findings on the whole tree and on the
production tree, with `npm ls --omit=dev --all` reporting an empty tree; 100% on all four coverage
metrics (9/9, 0/0, 2/2, 9/9); the 14-byte body with digest `c98c24b6…ad31`; and the 41-byte readiness
line. The installed `jest` package is 30.4.2 while its CLI self-reports 30.4.1, because the
constituent packages version independently.

The delivery is exactly the seventeen artefacts the project plan enumerates — no extra file, and one
`overrides` entry rather than a fork of the plan's dependency design. The one property the plan's
graph does not give you is brace-pattern support in the older `minimatch`/`glob` generation Jest
30.4.2 resolves; that is measured, bounded and explained under *`overrides` holds exactly one entry*
above rather than worked around locally.

`server.js` was **not modified** by this work — its SHA-256 remains
`332fc2d04eb5b8f3cb230855457af80d0dfc246f958d6e49615610d656acc2e0`, byte-identical to the committed
original, after a complete passing run. The harness reaches the module's private request handler and
private server instance by intercepting `http.createServer`, which is why no edit was required.

Because `server.js` contains no conditionals, branch coverage is trivially 100% at 0/0 and statement
coverage saturates as soon as the module is loaded once. **Full coverage on this file is therefore
best understood as a suite-liveness alarm, not as evidence of behavioural thoroughness.** The
substantive measure is requirement coverage, which moves from **0 of 20 to 20 of 20** catalogued
requirement identifiers.

**Traceability.** Every test title ends in the identifier of the thing it proves, in the form
`<behaviour in present tense> (<ID>)`, so the mapping is checkable from the titles alone. The ID is
a requirement ID (`F-002-RQ-001`) wherever the behaviour is one of the 20 catalogued requirements,
and otherwise the applicable **supplemental-standard** ID, because exactly five cases assert runtime
or security properties that no `F-` requirement covers: version-header non-disclosure
(`contract.test.js` — `ST-3`); the parser's `400` and `431` rejections (`protocol.test.js` — `ST-6`,
twice); and unthrottled concurrent service together with event-driven exchange settling
(`protocol.test.js` — `ST-7`, twice). Several further titles carry both kinds at once
(`… (F-001-RQ-002, ST-4)`), and the lifecycle tier additionally **prefixes** its scenario ID
(`S1`…`S7`) so a child-process scenario is identifiable by number as well as by requirement. No
title carries an invented ID, and none is left unlabelled.

The suite deliberately documents rather than fixes the server's robustness gaps: there is no `'error'`
listener, so a bind conflict surfaces as an uncaught exception and a non-zero exit with an
`EADDRINUSE` diagnostic on stderr; there is no signal handling; there is no `server.close()`; and the
host and port are hard-coded with no override path. All four are asserted as current behaviour.

No user-specified rules exist for this project, so the suite is held to enterprise-standard best
practice; the eleven self-imposed standards evidenced above stand in their place.
