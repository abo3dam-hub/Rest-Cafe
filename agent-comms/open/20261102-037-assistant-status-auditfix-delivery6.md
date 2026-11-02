From: assistant
To: ted
Kind: status
Thread: 20261102-037
Subject: Audit-fix Delivery 6 done — hardening, hygiene, procedures (F-031, F-033, F-025, F-021, F-022)

Delivery 6 of assignment 037 is done, per decision 043.

Base head: e0d99611977b479e609a6b99b287d01f259d6db8 (upstream main, Delivery 5 landed)
Branch: assistant/auditfix-d6-hardening
Head: b4bd6edfdd110cc02b1888de7e87db08031f69c3 (implementation head; this status file is committed on top of it)
Commits: 7 (announce + 5 findings + this status file)

## What was done, per finding

### F-031 — The general API rate limiter applies on the LAN too
- The blanket private-IP skip is gone. The general API limiter
  (`main/middleware/security.ts:263`, `generalApiRateLimit()`, used by
  `main/server.ts:222`) now allows 100 requests/min per IP off-LAN and 600/min
  per IP on-LAN (`API_RATE_LIMIT_PER_MINUTE` / `API_LAN_RATE_LIMIT_PER_MINUTE`,
  `security.ts:17-19`). The static-route limiter (`security.ts:277`) allows
  600/min off-LAN and 3600/min on-LAN. The shared in-memory limiter
  (`rateLimit()`, `security.ts:45`) gives LAN clients 6x its strict max
  (`LAN_RATE_LIMIT_MULTIPLIER = 6`, `security.ts:14`); the per-IP effective
  ceiling is computed at `security.ts:66-68` and reported in the
  `RateLimit-*` headers. The KDS server (`main/kds-server.ts:142`, max 100)
  and Server App (`main/server-app.ts:235`, max 150) limiters use the same
  helper, so they get the LAN ceiling (600 / 900) with no code change there.
- The ceiling is 6x because a real restaurant device polls at most a few
  requests a second (KDS liveness 10 s, POS order alert 20 s, KDS REST poll
  a few seconds), while a retry loop floods at tens per second — 10/sec
  sustained per IP is far above any real device and cuts a flood off
  within seconds.
- Auth, PIN, and order-write buckets are unchanged: `authRateLimit`,
  `loginAuthRateLimit`, the PIN limiters, and the held-order limiters still
  apply their strict budgets to every IP. The pre-login support-ticket
  limiter (`main/routes/support-ticket.ts:17`) now passes `lanCeiling: false`
  instead of the renamed `bypassPrivateIp: false` — same strict-for-everyone
  behaviour. The `bypassPrivateIp` option is renamed `lanCeiling` (default
  true); its meaning changed from "skip the limit" to "use the generous LAN
  ceiling", and the old name would have lied about it.
- `tests/cors-security.test.ts` is updated to the new behaviour: private,
  loopback, and IPv4-mapped IPv6 clients get the LAN ceiling (12 pass, 13th
  is 429 with max 2); the `lanCeiling: false` cases still share the strict
  limit; the static limiter asserts the same ceiling; and a new section 10
  drives the production `generalApiRateLimit()` factory (public IP stops at
  100, LAN IP stops at 600).
- Deliberately unchanged: the diagnostics-write limiter
  (`main/routes/diagnostics.ts:22`, 30/min with a private-IP skip) is a
  separate narrow bucket for diagnostic event writes, not the general API
  limiter — flagging it here rather than widening this delivery's scope.

### F-033 — Idempotency records get a retention cleanup
- New `pruneIdempotencyRecords()` (`main/db/core.ts:1181`), exported from
  the barrel (`main/db.ts:118-119`): one atomic batch per table deletes
  `payment_idempotency`, `order_idempotency`, and `refund_idempotency` rows
  with `created_at` older than the retention window, and returns the
  per-table counts. Tables that do not exist on an old database are skipped
  rather than failing. The window is 90 days (`IDEMPOTENCY_RETENTION_DAYS`,
  `main/db/core.ts:1170`).
- Why 90 days: retries happen within minutes of the original request, so 90
  days is far beyond any retry window a client can still be in, while a key
  becomes reusable after expiry (a repeat with a pruned key is treated as a
  new request, which is the intended consequence). Nothing in the window is
  ever matched, so replay inside the window is untouched.
- The startup job runs in `initialize()` (`main/index.ts:1166`) right after
  `initDatabase()`; it logs the pruned counts and a failure is logged and
  never blocks startup.
- `payment_transaction_refs` / `payment_transaction_ref_conflicts` are NOT
  pruned: they are the card-reference dedup mechanism, not idempotency
  records, and clearing them would weaken duplicate-payment protection.
- New suite `tests/idempotency-retention.test.ts` (20 checks, wired into
  `package.json` as `test:idempotency-retention` and into the `test` chain):
  91- and 400-day-old rows are pruned (2 per table), recent and 89-day-old
  rows survive, a repeat prune is a no-op, the exact replay SELECTs the
  three handlers run still return the stored response for in-window keys,
  a pruned key no longer replays, and a 30-day window prunes a 31-day-old row.

### F-025 — Lint headroom restored to at most 900 backend warnings
- Backend warnings: 966 → 822, 0 errors (budget 1000). All removals are
  behaviour-preserving.
- 141 `catch (error: any)` annotations dropped where the error value is never
  property-accessed: the binding becomes `unknown` (the TypeScript default),
  and every use in those blocks (`console.error`, `throw`, `String(...)`,
  template interpolation) accepts `unknown`, so the emitted JS is unchanged.
  `npm run build` (tsc) passes on the result.
- Two unused imports removed from `main/printers/thermal.ts`
  (`renderKotDocumentToLines`, `printViaCups`), and the rest-destructure in
  `main/routes/bills.ts:3097` that only stripped `payment_method_id` became a
  spread plus `delete` of the same key on the copy (the field is optional in
  `PaymentInput`, so the delete typechecks; the original object is untouched
  in both versions).
- Left as-is, and reported: the 100 remaining `catch (x: any)` sites read
  `error.message` / `err.code` or similar and would need narrowing, i.e. a
  logic change, so they were not touched. The 963 `no-explicit-any` warnings
  are otherwise dominated by `as any` casts and `any`-typed DB row shapes,
  which need per-site precise types — a later typing pass, not this delivery.
- Formatter churn: the pre-commit hook reformatted never-formatted regions in
  the 29 touched files, so the commit is 686 insertions / 443 deletions
  against 144/144 of intended change. Pure formatting (import collapsing,
  line wrapping), verified by inspection; no logic in the extra diff.

### F-021 — Documentation drifts fixed
- `docs/architecture/runtime-and-lifecycle.md`: the startup list now matches
  `initialize()` in `main/index.ts` — `initDatabase()` + idempotency prune,
  `applyAutostartSetting()`, `startServer()`, `localBackup.start()` +
  `printQueue.start()`, KDS, Server App, mDNS, printer, IPC, `ready`,
  window + power-monitor recovery + child-process crash telemetry + tray +
  menu, and the delayed tax-pack catalog check. The `cloudSync` /
  `telemetry` / `googleDrive` steps and the auto-updater step are gone
  (they do not exist; updates are manual). The failure and
  uncaught-exception passages no longer claim a telemetry report: failures
  are logged, shown in an error box, and captured in local operation
  diagnostics. The `dev-server.js` divergence table drops `auto-updater`.
- `docs/architecture/data-and-migrations.md`: the pre-migration backup is
  `rest-cafe-backup-<timestamp>-pre-v<from>-to-v<to>.db`, the restore safety
  copy is `rest-cafe-backup-<timestamp>-pre-restore-v<version>.db`, the daily
  backup lives in `Documents/RestCafe/Backups` as
  `rest-cafe-backup-<UTC timestamp with milliseconds>Z.db` (legacy
  `flo-backup-` names still recognised), and `main/db.ts` is described as
  the 150-line re-export barrel it is since Stage 2, with `MIGRATIONS`
  living in `main/db/migrations.ts`. The schema-mismatch failure passage no
  longer claims a telemetry report either.
- The telemetry claims fixed here are the ones inside the passages this
  finding touches. Two other telemetry mentions remain elsewhere in `docs/`
  and were not touched: `docs/decisions/0001-offline-first-core.md` (a
  historical decision record, which correctly describes the old design) and
  `docs/architecture/printing.md:202` / `docs/guides/testing-printers.md:74`
  (generic "what telemetry reports" phrasing, not a startup claim).

### F-022 — Restore onto a replacement host: runbook + fresh-install proof (DEFECT FOUND AND FIXED)
- The probe confirmed the defect the audit left unverified. On a fresh
  install the live database has no users (the owner is created only by
  first-run setup), so `captureUserSecurityState` returned `[]` and
  `mergeUserSecurityState` (`main/db/backup.ts`) disabled EVERY restored
  user — the backup's owner came back `is_active = 0`. The operator was
  then fully locked out: login fails on the inactive owner, first-run
  setup refuses because a user row already exists (`/setup/initialize`
  returns 403 when `getUserCount() > 0`), and password recovery needs an
  active owner. The new suite failed exactly there before the fix
  (`expected 1, got 0` on the owner active flag).
- The fix (`main/db/backup.ts:2471` and `:2218`): the merge skips the
  "disable restored-only users" step and the station-assignment wipe when
  there is no live security state to protect — when the preserved user list
  (or user-id list) is empty, the backup's accounts and station assignments
  come through as the backup had them. The disable rule is unchanged
  whenever the live store has users: a backup-only account still stays
  disabled, and live assignments still win. No other merge behaviour
  changed (protected settings still follow live-wins; KDS and customer
  display pairing tokens are still cleared; revocations are still merged).
- New suite `tests/restore-fresh-install.test.ts` (20 checks, wired into
  `package.json` as `test:restore-fresh-install` and into the `test` chain):
  a backup is restored onto a wiped fresh install and the backup owner
  stays active with its password hash, PIN hash, and email intact, the
  chef stays active with its station assignment, and the product, order,
  and business name survive; then a second restore proves the boundary —
  a backup-only user stays disabled once the live store has users, and the
  live owner stays active through it. The suite was run against the
  unfixed merge first and failed on the owner flag, then green after.
- Runbook: `docs/maintainers/upgrade-testing.md` gains a "Restore onto a
  replacement host" section (steps, what survives, the setup-first
  consequence, the userless-restore case, and the verify-before-reopening
  checklist), and the `docs/README.md` maintainers row for that page now
  names it. One point the runbook states plainly: the supported UI path
  (Settings → Database → Restore from file) needs an authenticated owner,
  so on a replacement host the operator completes first-run setup first
  and logs in with those setup credentials afterwards — the backup's owner
  account is present but disabled until the setup owner re-enables it from
  the Staff page. The merge fix covers restores onto a userless database
  (the `restoreBackup()` mechanism itself, including any future pre-login
  restore); it does not change the setup-first UI outcome, where the live
  owner correctly wins.

## Battery (2026-11-02, this VM, serial, `npm run clean` between suites)

30/30 green.

- `lint` exit 0 — backend 822 warnings, 0 errors; frontend 1 warning (pre-existing), 0 errors.
- `test:lint-engine` exit 0.
- `i18n:check` exit 0.
- `build` exit 0.
- `build:frontend` exit 0.
- `test:script-coverage` exit 0.
- `docs:check` exit 0 — one pre-existing phase-numbering policy warning in
  `docs/IMPLEMENTATION_REPORT_AR.md`, non-gating.
- `test:cors` exit 0.
- `test:csp-lan` exit 0.
- `test:security` exit 0.
- `test:staff-authz` exit 0.
- `test:orders-authz` exit 0.
- `test:backup` exit 0.
- `test:local-backup` exit 0.
- `test:migration-registry` exit 0 — 377/377 checks (124 migrations, v1..v124).
- `test:upgrade-path` exit 0.
- `test:idempotency-retention` exit 0 — 20/20.
- `test:restore-fresh-install` exit 0 — 20/20.
- `test:cash-closures` exit 0 — 370/370.
- `test:full-house` exit 0 — 0 findings, 9.6 s.
- `test:restaurant-day-cycle` exit 0 — 116/116.
- `test:receipt-column-oracle` exit 0 — no byte change.
- `test:cross-server-login-rate-limits` exit 0 — ALL PASSED.
- `test:kds-integration` exit 0.
- `test:kds-live-push` exit 0.
- `test:bills-print-api` exit 0 — 34/34.
- `test:printer` exit 0.
- `test:bills-settlement-idempotency` exit 0 — 134/134.
- `test:issue-788-order-attempt-storage` exit 0.
- `test:authorization-permissions` exit 0 — permission-label-i18n,
  permission-matrix-self-access, authorization-permissions,
  authorization-api ("Authorization management API tests passed"),
  authorization-static-audit, static-audit-posix-paths (40/40 assertions);
  2904 assertions, 0 failures.

Correction, recorded plainly: the battery script invoked
`test:authorization-api`, which does not exist as an npm script — it exited 1
with `npm error Missing script: "test:authorization-api"`. That was a
battery-script name error, not a product failure. The suite lives in
`test:authorization-permissions`, which runs `authorization-api.test.ts`
among six files; it was re-run under its correct name and is green (exit 0).
No suite was skipped or emptied to get here; the battery is 30/30.

## Disclosures
- Formatter churn: the F-031 commit's pre-commit hook reflowed long lines in
  `tests/cors-security.test.ts` (pure formatting); the F-025 commit carries
  the larger reformat described under F-025 above. No logic in either.
- Published via the GitHub API helper because local git push cannot
  authenticate in this environment (same as Deliveries 1–5).
- No money/tax/settlement/refund semantics changed; `refund.ts` untouched.
  No `docs/production-readiness/*` edits. No new i18n keys. No golden
  regeneration.

## Not done / open for Ted
- The diagnostics-write limiter's private-IP skip (`main/routes/diagnostics.ts:22`)
  is out of this delivery's scope — flagged under F-031 above.
- The remaining 100 `catch (x: any)` sites and the `as any` / row-shape
  clusters still need a typing pass if headroom below ~800 is ever wanted.
- Physical-printer verification on Ali's machine is still outstanding, as is
  the real Windows-login autostart test from Delivery 4. No installer for
  this delivery — the single installer comes after the last production delivery.
