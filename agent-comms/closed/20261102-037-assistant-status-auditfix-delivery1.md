# Assistant status — audit fix Delivery 1, test infrastructure (thread 20261102-037)

- **From:** assistant
- **To:** ted
- **Kind:** status
- **Thread:** 20261102-037
- **Date:** 2026-11-02
- **Base:** `bd534dc20969c244094aea198080953cf356c173` (upstream `main` at assignment time)
- **Branch:** `assistant/auditfix-d1-test-infra`
- **Assignment:** `agent-comms/open/20261102-037-ted-decision-production-audit-fixes-assignment.md`

## Summary

Delivery 1 is complete as code: all five findings (F-001, F-020, F-019, F-008 test
side, F-010) are fixed in 8 commits on the branch. The protecting battery is green
wherever it could be run. **One environment fault blocks the final re-run of a
few battery items** (see "Environment write fault" below): `npm run build`,
`test:lint-engine`, the translations test, and a full tier-2 re-run could not be
re-executed after ~23:18 because the host intermittently denies file-content
writes with `EPERM`. The fault is not caused by the app or by any D1 change; it
also clobbered the loop state file to 0 bytes the same night. Where a re-run was
blocked, this file cites the pre-fault green evidence instead and says so
explicitly. Nothing in this delivery changes money math, tax behaviour,
settlement semantics, production printing code, or any locked behaviour.

## F-001 — Playwright harness starts; test-side rot diagnosed and partly fixed

Commit `3ffa1c5` — `test: repair e2e harness startup after WhatsApp service removal (F-001)`.
`tests/e2e-server.cjs` required `../dist/main/services/whatsapp`, a module deleted
end-to-end (no `whatsapp` module under `main/services/` or `dist/main/services/`;
only settings keys / migration table names remain; `FLO_WHATSAPP_SOCKET_DISABLED`
referenced only by this file). Removed the dead require, its shutdown hook, the
`onShutdownRequested` option (optional in `main/shutdown.ts:500`), and the dead env
line; fixed the stale seed comment. `whatsapp_enabled: 'true'` setting untouched
(blocklist UI gated on it). Diff: 2 insertions / 16 deletions. Verified: harness
starts, `:3001/:3002/:3003 /api/health` all 200, clean SIGTERM shutdown.

### Tier results (actual, logs in `~/workspace/rest-cafe-docs/auditfix-d1-2026-11-02/`)

- Default browser run (`test:e2e:browser`, 325 tests in 55 files): stopped early
  after 82 tests executed (21 pass / 61 fail) — failure pattern already systemic,
  full run would take ~2+ hours serially (`workers: 1`).
- Tier 1 (`test:e2e:browser:tier1`): **3/3 passed, RC=0**, 7.0s.
- Tier 2 pre-fix (`test:e2e:browser:tier2`, 69 tests): **15 passed / 54 failed,
  RC=1**, 29.6m. The 3 `FINDING:` tests (order-history:176, order-history:219,
  staff-roles:225) and the refund test (orders-lifecycle:80) all now RUN (F-020
  verified working) but FAIL on stale English selectors.
- Tier 2 post-fix re-run: **INVALID — 9 passed / 60 failed, 11.3m.** The run was
  hit by the environment write fault: test 16 (order-history:400) died with
  `locator.click: Target crashed` on the POS 'Place Order' click; tests 17+ then
  failed at browser launch (`browserType.launch: Target page, context or browser
  has been closed`, browser exited `signal=SIGTRAP`, plus `Error: EPERM:
  operation not permitted, write`). Its 9 passes are a subset of the pre-fix 15.
  **Do NOT report 9/60 as a regression — the run never measured the fixes.**
- Electron tier pre-fix (`test:e2e:electron`, 11 tests): 1 passed / 3 failed / 7
  did not run, RC=1. All 3 failures shared one root cause:
  `native-harness.ts:414` waits for URL `=== '/pos'` after owner login, but the
  owner lands on `/dashboard`.
- Electron tier post-fix: **7 passed / 4 skipped (declared `test.skip`,
  hidden-window/platform-gated) / 0 failed, RC=0**, 48.8s.

### Root cause of the rot (proven by single-spec reproduction)

The login page renders Arabic-first: email field labelled «البريد الإلكتروني»,
password «كلمة المرور», button «تسجيل الدخول». Specs using English accessible
names (`getByLabel('Email')`, `getByLabel('Password')`, `getByRole('button',
{ name: 'Sign In'})`) never match. The working pattern (e.g. `expenses.spec.ts`,
which passes) uses `page.locator('#email')` / `page.locator('#password')` +
`button[type="submit"]` + waiting to leave `/auth/login`. The login form has
`id="email"` / `id="password"` (`frontend/src/app/auth/login/page.tsx:192-193`)
and a `type="submit"` button (line 236), so id-based selectors are
locale-independent. Owner landing page is `/dashboard` (cashier/server →
`/tables`; `getLandingPage` in `frontend/src/components/layout/AuthGuard.tsx:30`),
so `waitForURL(/\/pos/)` after owner login is stale.

### Login-rot fixes applied (3 logical groups; one fork API commit per file — local commits pending the fault, see "Commits" below)

- Class A+B — 54 replacements across 15 spec files: `page.getByLabel('Email')` →
  `page.locator('#email')` (18×), `page.getByLabel('Password')` →
  `page.locator('#password')` (18×), `page.getByRole('button', { name: 'Sign In'})
  .click()` → `page.locator('button[type="submit"]').click()` (18×). Files:
  category-inactive-addon-groups, customer-display-pairing, diagnostics-screen,
  floorplan-editor, floorplan-view-order-live, menu-printing,
  product-cost-price-roundtrip, qa-print-test-page, qa-settings-permissions-roles,
  qa-settings-receipts-printers, qa-settings-store-locale, qa-settings-tax,
  settings-kds-navigation, table-move-live, variant-recipe-portions. NOT touched
  (deliberate): the 3 assertion occurrences — `i18n-batch-5d.spec.ts:84,137`
  (KDS standalone / Server App login forms after `setLanguage 'en'`, a different
  surface) and `server-app-ordering.spec.ts:125` (Server App logout flow).
- Class C — `waitForURL(/\/pos/)` after owner login →
  `waitForURL((url) => !url.pathname.startsWith('/auth/login'), { timeout: 20000})`,
  13 replaced: `title-bar-platform.spec.ts` all 8 (lines 41, 90, 201, 272, 291, 360,
  438, 457); `layout-integrity.spec.ts` lines 69, 141, 310;
  `cashier-status-bar.spec.ts` lines 42 and 278 (plus `await page.goto(
  `${BASE}/pos`)` after :278 — that test needs POS for the shift-close modal and
  never navigates there itself). Deliberately KEPT: `cashier-status-bar.spec.ts:321`
  (reload on /pos — correct there) and `layout-integrity.spec.ts:420` (waits for
  /pos after clicking the POS nav link — correct there).
- Electron harness (`frontend/e2e/desktop/native-harness.ts`): after login submit,
  wait only for leaving `/auth/login`, then drive to `/pos` explicitly (mirroring
  the existing else-branch); the persisted-session `waitForFunction` now waits for
  `path !== '/auth/login'` instead of `path === '/pos'`.
  `frontend/e2e/desktop/title-bar.electron.spec.ts:66`: expected app name
  `'flo-desktop'` → `'rest-cafe-desktop'` (stale pre-rename expectation;
  `package.json` name is `rest-cafe-desktop`; the `data-flo-desktop-titlebar` DOM
  attributes are real and were left alone).

### Verification of the login fix (single-spec runs)

- `floorplan-editor.spec.ts:239` post-fix: sails past login in ~13s (was a 30s
  timeout at `getByLabel('Email')`), now fails at the NEXT layer —
  `getByRole('heading', { name: 'Tables'})` not found on the Arabic-first tables
  page.
- `cashier-status-bar.spec.ts:6` post-fix: passes login and the testid-based
  checks, fails at line 86: `toContainText('Open shift')` vs actual «فتح وردية».
- So the login layer is fixed and verified; the next layer is page-level English
  strings (see inventory below).

### Remaining rot — NOT fixed, inventoried for a follow-up assignment

~1,151 English UI-string occurrences (`getByRole` name / `getByText` /
`toHaveText` / `getByPlaceholder` with ASCII capital start: 860 + 223 + 28 + 40)
across 61 of 71 spec files. That is an upper bound — some are legitimate (i18n
specs that set locale `en` first, KDS/server-app English surfaces, API-driven
strings). Examples of the next layer: `'Tables'` heading, `'Floor plan'` button,
`'Add Customer'` button (`customers.spec.ts:31` fails waiting for it), `'All'`
pill (`order-history.spec.ts:319,366` — Arabic UI has «الكل»), `'Open shift'`
pill. The 3 FINDING: tests and the refund test now RUN but cannot execute their
assertions until this layer is re-localized; they are NOT application-behaviour
failures. Fixing all of it in D1 would be re-localizing the whole suite — out of
proportion for this delivery. **Recommendation: a follow-up assignment to
re-localize the browser suite's page-level strings** (or record expected strings
per locale). No application behaviour was fixed or hidden in this delivery.

## F-020 — FINDING:-tagged tests no longer silently excluded

Commit `f8bc641` — `test: stop excluding FINDING:-tagged e2e tests from the default
browser run (F-020)`. Removed the `FINDING:` exclusion AND the by-title
refund-test exclusion from `test:e2e:browser` (now
`--grep-invert='@ci-tier1|@ci-tier2'`) and from `test:e2e:browser:tier2`
(grep-invert removed entirely). The `@ci-tier1`/`@ci-tier2` exclusion stays —
those tests ARE run by the tier scripts. The refund-title exclusion (`a paid
order offers a refund, and issuing it settles against the recorded sale`,
`frontend/e2e/ops-admin/orders-lifecycle.spec.ts:80`) is the same defect class as
the FINDING: exclusion. This commit also wires `test:run-test-wrapper` into the
main `test` chain (F-019 suite, shares the file). Verified in the tier-2 pre-fix
run: the 3 FINDING: tests and the refund test all RUN (they fail on stale English
selectors — see F-001 inventory, not on the exclusion).

## F-019 — exit 77 fails loudly unless a declared environment skip

Commit `471b4d8` — `test: fail loudly on exit 77 except declared environment skips
(F-019)`. Rewrote `scripts/run-test.cjs`: a `DECLARED_ENVIRONMENT_SKIPS` map (26
entries: the 24 script names that run the 25 better-sqlite3 ABI-guard files, plus
composite `test:printer`, plus alias `test:upgrade-regression` of
`test:upgrade-path`). Exit 77 + declared suite → skip line naming suite and
reason, exit 0; exit 77 + undeclared/unidentifiable suite → loud stderr failure
naming the rule, exit 1; other statuses pass through. Decision is a pure exported
function (`resolveExitCode`); CLI guarded by `if (require.main === module)`. New
regression suite `tests/run-test-wrapper.test.ts` (throwing assert helpers; runs
via `run-electron-node-test.cjs`): **91 passed, 0 failed**. Maintenance rule (in
the commit message, restated here): when a new suite gains an ABI-guard exit 77,
add its script name to `DECLARED_ENVIRONMENT_SKIPS` with a reason; when a guard
is removed, remove the entry.

## F-008 (test side ONLY) — cash-closures section 15 green

Commit `c63c5e1` — `test: mock Z-print on its defining module so cash-closures
section 15 runs (F-008)`. No production printing code touched. Root cause PROVEN
by probe: `main/printers/thermal.ts:42` re-exports `printZReport` as a getter-only
property (TypeScript compiles re-exports that way), so assigning the mock on the
barrel silently did nothing; the real `printZReport`
(`main/printers/document-z-report.ts:493`) opened a socket to 127.0.0.1:9100 and
the suite crashed at line 1694, so sections 15a/15b/15c/16 never executed. Fixed
all four mock sites in `tests/cash-closures.test.ts` (§15 ~1630, §15a ~2225,
§15b ~2296, §16 F4(c) ~2633, with restores at ~2007, ~2262, ~2358, ~2669) to
assign the mock on `require('../main/printers/document-z-report')` (the route
destructures per-request at `main/routes/cash-closures.ts:1382`, so the barrel
getter sees it). **Verified: `test:cash-closures` 370/370 passed, 0 failed.**
The known red entering the round is now green. Whether Z-print works on a real
printer stays a device-phase item.

## F-010 — CI runs the protecting suites; Playwright job created (non-gating)

Commit `44f49f1` — `ci: run the protecting suites and the Playwright tiers in CI
(F-010)`. `validate` job extended from 7 focused suites to a gating protecting
list (existing 7 + `test:run-test-wrapper`, `test:smoke`, `test:startup-cache`,
`test:shutdown-lifecycle`, `test:full-house`, `test:restaurant-day-cycle`,
`test:refunds`, `test:tax-engine`, `test:charges`, `test:currency`,
`test:cash-closures`, `test:cash-sessions`, `test:reports-reconciliation`,
`test:order-totals-recompute`, `test:receipt-column-oracle`,
`test:receipt-column-width`, `test:backup`, `test:local-backup`,
`test:migration-registry`, `test:upgrade-path`, `test:migration-v56-v57`,
`test:migration-v71-repair`, `test:migration-v80-cash-drawer-pulse`,
`test:migration-v81-cash-closures`; timeout 45 → 60 min). New `playwright` job
(timeout 90 min, `continue-on-error: true`, i.e. non-gating): checkout,
setup-node 22, `npm ci`, `sudo apt-get install -y xvfb` + `cd frontend && npx
playwright install --with-deps chromium`, build + build:frontend, tier1, tier2,
`xvfb-run -a npm run test:e2e:electron`. Non-gating because the browser tiers
carry known test-side failures (English selectors in specs written against an
English UI while the app is Arabic-first; inventory above); the job runs so
failures stay visible and Ted routes them separately. Validator
`TEST_EXCLUSIONS` citations corrected (no longer cites Playwright jobs that did
not exist): tier1/tier2/electron now name the real Playwright CI job;
`test:e2e:browser` recorded as a full 325-test local diagnostic run only,
`test:e2e` likewise; `test:e2e:server` is the process the Playwright jobs start.
Pre-commit hook reformatted the validator (+1 line). No CI run is available to
me; verified by reading the run definition (job steps, script names, timeouts)
and by the direct validator run below. Never made CI green by removing suites.

## Battery (commands run serially; `npm run clean` between suites; proxy unset except `build:frontend`)

Logs in `~/workspace/rest-cafe-docs/auditfix-d1-2026-11-02/` (baseline + per-suite
logs named below). Full `npm test` was NOT run (hours-long; the audit baseline
battery ran specific suites). Where an item could not be re-run after the fault
started, the pre-fault evidence is cited and the item is marked BLOCKED, not
green.

| Check | Result |
|---|---|
| `npm run lint` | **GREEN, RC=0** (backend 969 warnings / 0 errors; frontend 1 warning / 0 errors — pre-existing oxlint noise). Run after all e2e changes. |
| `git diff --check` | **GREEN, RC=0**. |
| `npm run docs:check` | **GREEN** (verified by direct invocation: `markdownlint-cli2` 0 issues; `check-docs.cjs --links --index` 324 links OK, 35 pages / 38 index links; `--policy` RC=0 with the one pre-existing phase-numbering warning in `docs/IMPLEMENTATION_REPORT_AR.md:115`, non-gating — same warning as the 035 landing). |
| `npm run test:script-coverage` | **GREEN** (verified by direct invocation of all 3 parts: `validate-test-script-coverage.cjs` RC=0 — "260 reachable, 8 explicitly excluded; 310 run by the default suite, 1 excluded with a stated reason"; `test-script-coverage.test.cjs` RC=0; `test-harness-assertions.test.ts` RC=0, "harness contract verified"). |
| `npm run test:cash-closures` (full) | **370/370 passed, 0 failed** (post-F-008 fix). |
| `npm run test:run-test-wrapper` | **91 passed, 0 failed** (new F-019 suite). |
| `test:e2e:browser:tier1` | **3/3 passed, RC=0**, 7.0s. |
| `test:e2e:electron` (post-fix) | **7 passed / 4 skipped (declared `test.skip`) / 0 failed, RC=0**, 48.8s. |
| `npm run build` | **GREEN at 23:17** (post-change tree — the electron post-fix2 run's build step succeeded with all e2e changes in the tree). Re-run after 23:18 **BLOCKED by the fault** (10 attempts 23:48–23:51, all RC=2, `TS5033: Could not write file ... EPERM`). |
| `npm run build:frontend` | **GREEN at 23:17** (post-change tree, same electron run). Re-run **BLOCKED by the fault**. |
| `npm run i18n:check` | Checks printed "✅ All translation integrity checks passed." in the earlier battery run; `generate-print-labels --check` **PASSED** (direct run: "drift check passed"); frontend `tsc --noEmit --incremental false` **RC=0** (direct run; plain `--noEmit` fails only on writing `frontend/tsconfig.tsbuildinfo`, EPERM). The translations test itself is **BLOCKED by the fault** (EPERM on write). |
| `npm run test:lint-engine` | **BLOCKED by the fault** (the test writes a fixture file; the run dies with `EPERM, syscall: 'write'`). Its leftover fixture `shared/__lint_parity_forbidden.ts` was removed; the earlier failure was that artifact, not the code. |
| `test:e2e:browser:tier2` (post-fix, full) | **INVALID — fault-interrupted** (9 passed / 60 failed; browser died mid-run, see F-001). Pre-fix run: 15 passed / 54 failed. Single-spec post-fix verifications (floorplan-editor:239, cashier-status-bar:6) confirm the login layer is fixed. |
| CI workflow | Verified by reading the run definition (job steps, script names, timeouts) + direct validator run. No CI run is available to me. |

## Environment write fault (BLOCKING — discovered 2026-11-02 ~23:18, still active)

An intermittent host/sandbox fault denies file-content writes with `EPERM` /
`SQLITE_IOERR_WRITE`, in waves. Evidence gathered 2026-11-02:

- First seen 23:18: two npm `EPERM: operation not permitted, write` log failures
  at the end of the tier-2 post-fix run; the run's browser died with SIGTRAP
  around the same time.
- npm: `npm run X` fails instantly with empty output when stdout is a regular
  file (RC=1/255), but works when stdout is a pipe or `/dev/null`;
  `npm --logs-max=0` bypasses npm's own log-file write failure. `npm run` (list
  scripts) with redirect: RC=0 but 0 bytes — output lost.
- Python: `os.write` / `flush()` / `os.pwrite` to any file (both `/tmp` and
  `/home/hatch`, new and existing) fail `PermissionError: [Errno 1] Operation not
  permitted`; `sys.stdout.write` to a file fails (RC=120). Python stdout (pipe)
  works.
- Node: `writeSync`/`pwrite64`/`fsync` succeed in clear windows, fail with EPERM
  in fault windows (e.g. `writeFileSync` EPERM at 23:46 after succeeding at
  23:35).
- better-sqlite3: file-backed DB writes fail consistently since ~23:32
  (`SQLITE_IOERR_WRITE` at `Database.pragma`, `main/db/core.js:587`; all journal
  modes OFF/MEMORY/DELETE/WAL/TRUNCATE fail at first write; `:memory:` works).
  `pwrite64(19,..., 512, 0) = -1 EPERM` seen under strace. Plain-node
  `pwrite`/`ftruncate`/`fsync`/`flock`/`lockf` all OK in the same windows — so
  it is not the filesystem, modes, locks, or journal mode; it is the write
  syscall being denied in waves (also seen for plain node at 23:34 and 23:46).
- `oxlint` with file stdout aborts (RC=134 SIGABRT, 0 bytes); via pipe it works.
  `strace -o <file>` writes nothing. `tee`/`cat`/`dd`/shell `echo`/plain
  `node -e` usually work.
- `tests/e2e-server.cjs` cannot start while the fault is active (SQLite
  `SQLITE_IOERR_WRITE` opening its `/tmp/flo-e2e-*/flo.db`), so no Playwright run
  can proceed.
- `dist/` was damaged by the fault: `npm run build` (`rm -rf dist && tsc`)
  deleted `dist/` and then tsc failed on every file with `error TS5033: Could not
  write file... EPERM` — **all 693 files in `dist/` are 0 bytes**. `dist/` is
  gitignored and is NOT in this PR; it must be rebuilt (on a healthy host) before
  any further local e2e/battery run. Ted builds from source on his side.
- `git add` fails the same way (`fatal: sha1 file '.git/index.lock' write error:
  Operation not permitted`). The three local login-rot commits and the local
  status commit are still pending after 600+ consecutive rapid retries
  (2s-cadence loop, then 0.2s-cadence busy loop — 600 attempts in ~2 minutes, all
  failed); their content reached the fork via API commits instead (byte-verified
  per file). The earlier six local commits landed before the fault started.
- Probe loop (20 cycles × 20s): SQLite probes 1–13 all FAULT (23:43:09–23:47:11).
  Rapid retry at ~23:47: 0/20 SQLite writes and 0/20 plain writes succeeded.
  A single probe read CLEAR at 23:47:26, then the fault returned within seconds.
  10 build attempts 23:48–23:51 all RC=2.
- The same EPERM pattern clobbered the loop state file to 0 bytes at ~02:33 the
  same night (rebuilt by another worker; `in_progress` for D1 intact).

The fault is NOT caused by the app or by any D1 change. It invalidated: the
tier-2 post-fix re-run, the build / build:frontend / lint-engine / translations
re-runs. Workarounds used: run npm commands with stdout piped through `tee`;
`npm --logs-max=0`; direct `node`/`ts-node` invocations bypassing npm;
`tsc --incremental false`. **The fault needs a host-side look before the next
delivery's battery** — a delivery that cannot rebuild `dist/` cannot verify
itself locally.

## Disclosures

1. The PR diff carries the announce file
   (`agent-comms/open/20261102-037-assistant-status-auditfix-d1-started.md`) and
   this status file in addition to the D1 code/test/CI changes — the announce
   rides along per the general announce rule.
2. The tier-2 post-fix number (9/60) is invalid (fault-interrupted); it is NOT
   a regression and must not be reported as one.
3. Build / lint-engine / translations re-runs after 23:18 are blocked by the
   fault; pre-fault green evidence is cited above for build and build:frontend.
4. `dist/` on this VM is 0-byte files (fault damage, gitignored, not in the PR).
5. The Playwright CI job is non-gating (`continue-on-error: true`) because the
   browser tiers carry the inventoried test-side rot; failures stay visible and
   Ted routes them separately. Never made CI green by removing suites.
6. F-013 (KDS progression) was resolved by the owner while D1 was in flight
   (Ted decision 20261102-038, upstream `9a7e81e`): progression flexibility is
   INTENDED; no code change to progression rules anywhere in the 037 round.
   D1 touches nothing in that area.
7. Upstream `main` moved past the D1 base (`9a7e81e` for decision 038). This PR
   is against `main` from base `bd534dc`; no conflicts are expected (D1 files do
   not overlap the KDS decision docs) — verified at publish time.
8. No `docs/production-readiness/*` files were edited; the only docs-adjacent
   changes are the agent-comms status/announce files. No application files were
   changed for F-008 (test side only) or F-001's rot fixes (specs + harness
   only). Money math, tax behaviour, settlement semantics, and all locked
   behaviours are untouched.

## What remains / next steps

- This PR is for Ted's review and landing (serial, per protocol). Deliveries
  2–6 are separate assignments in order; nothing in this delivery starts them.
- Recommended follow-up assignment: re-localize the browser suite's page-level
  English strings (~1,151 occurrences, 61/71 files) so the FINDING: tests, the
  refund test, and the rest of tier 2 can actually execute their assertions.
- The environment write fault needs a host-side look before the next delivery:
  rebuild `dist/` and re-run the blocked battery items (build, build:frontend,
  lint-engine, translations, full tier 2) once writes are healthy.
- F-013 is closed by the owner's decision (038); Delivery 3 adds only the
  documentation half (1–2 sentences on the order-lifecycle/KDS docs page).

## Commits — local branch and fork (base `bd534dc`)

Local commits on `assistant/auditfix-d1-test-infra` (landed before the fault):

- `54b6fb5` docs(agent-comms): announce audit-fix Delivery 1 start (thread 20261102-037)
- `3ffa1c5` test: repair e2e harness startup after WhatsApp service removal (F-001)
- `f8bc641` test: stop excluding FINDING:-tagged e2e tests from the default browser run (F-020)
- `471b4d8` test: fail loudly on exit 77 except declared environment skips (F-019)
- `c63c5e1` test: mock Z-print on its defining module so cash-closures section 15 runs (F-008)
- `44f49f1` ci: run the protecting suites and the Playwright tiers in CI (F-010)

Fork API commits (one commit per file, same content, each byte-verified against
the local file — see "Environment write fault" for why the fork carries them):
`c245544` run-test-wrapper.test.ts (F-019); `5353528` e2e-server.cjs (F-001);
`0be1fd9` package.json (F-020); `eb2ad07` run-test.cjs (F-019); `27aa2ef`
cash-closures.test.ts (F-008); `3c7ba39` ci.yml + `19a0344` validator (F-010);
login-rot class A+B, 15 spec files: `9030247`, `06187d5`, `b1236f3`, `aaf85d4`,
`cc46243`, `046a4cb`, `078ce20`, `c975ff0`, `cc4f57d`, `16a71f6`, `b9a0380`,
`716c28e`, `84a98bd`, `8b0457b`, `8fb4c42`; class C: `a1698a0` cashier-status-bar,
`ebd9db1` layout-integrity, `698b603` title-bar-platform; electron harness:
`eca0a8f` native-harness.ts, `8eb9f2c` title-bar.electron.spec.ts; this status
file (commit recorded in the PR). The three local login-rot commits and the
local status commit are still pending — the environment write fault blocks
`git add`/`git commit` on this VM (600+ consecutive failures, see below). Their
content is on the fork byte-identical; the local branch will be reconciled
(re-committed and tree-compared) once writes recover. The fork branch head is
the status-file commit; the PR below is the hand-back.
