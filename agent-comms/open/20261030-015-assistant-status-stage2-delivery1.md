From: assistant
To: ted
Kind: status
Thread: 20261030-015
Subject: Stage 2 Delivery 1 done — backup.ts + settings.ts behind the db.ts facade (thread 20261030-014)

Delivery 1 (assignment thread 20261030-014) is done and ready for
verification. Branch `assistant/stage2-delivery1-backup-settings`, base
`9a486ec9f458452593f3ee52ea8bd877c27e6311`. Pure moves only; zero call-site
changes; no logic edits, no renames of exported symbols, no signature
changes. `main/db.ts` is now a facade for the moved pieces (re-exports at
`main/db.ts:28-91` for backup and `main/db.ts:100-118` for settings);
migration order and content are untouched (`MIGRATIONS` still in
`main/db.ts`).

Part 1 — backup / restore / replacement journals ->
`main/db/backup.ts` (3,277 lines). Moved verbatim, in original order:
replacement journals (`main/db/backup.ts:33`, journal API at `:290`),
restore safety copies (`:440`), backup creation/reset
(`:653`, `:789`), backup listing/metadata (`:1276`), restore validation
(`:1425`, `:1612`), restore execution (`:2521`, `dataOnlyRestore` at
`:2937`), FK-violation helpers (`:2816`). `getBackupDir` moved with the
cluster (`:28`); `main/db.ts` imports it back. The recovery-schema
reference block (`getRecoverySchemaReference`,
`normalizedSchemaDefinitions`, `isHealthyDatabaseFile`) deliberately
stayed in `main/db.ts` — it is ideal-schema/migration machinery for
Delivery 2 — and `backup.ts` imports `isHealthyDatabaseFile` from the
facade. Likewise `getCurrentSchemaVersion`,
`getSchemaVersionFromBackup`, `rebuildSearchIndex` and
`buildIdealSchemaDb` stayed (schema/migration machinery); `backup.ts`
imports the first three it calls.

Part 2 — settings + revision counter -> `main/db/settings.ts`
(199 lines). Moved verbatim: settings cache + `getSettingValue`
(`:17`), `tenantBusinessDayStartTime` (`:34`), `settingsRevision` state
(`:45`), `getSettingsRevision` (`:47`), `upsertSettings` (`:51`),
`GOOGLE_DRIVE_PRIVATE_SETTING_KEYS` (`:62`), settings-revision
triggers (`:112`), feature toggles (`:161`), `upsertTelemetryLastPing`
(`:197`). `sha256Hex` stayed in `main/db.ts` (used by a migration).
`getDbHealth`/`getDbPath` stayed (core).

Shared-state seam (disclosed, behavior-identical): the module-level
`db` variable stays in `main/db.ts` (core, moves to `core.ts` in
Delivery 2). Moved code that read `db` directly now calls the new
internal accessor `getRawDatabase()` (`main/db.ts:126`), which returns
the live instance with no added guards — same value, same call-time
evaluation, including the settings-cache identity check and the
`buildIdealSchemaDb` instance swap. Direct `settingsRevision += 1`
outside `settings.ts` became `bumpSettingsRevision()` calls
(`settings.ts:5`; `initDatabase`/`closeDatabase` in `main/db.ts`).
`backup.ts`/`settings.ts` import shared core functions from the facade
(`getDatabase`, `getDbPath`, `initDatabase`, `closeDatabase`, `now`,
maintenance-lock helpers); the cycle is load-time safe because the
compiled re-exports are lazy getters and no moved module calls facade
code at import time. Five internal helpers gained `export` in their new
module so staying `db.ts` code can import them without a public
re-export: `getColumns`, `pathEntryExists`, `syncFile`, `syncDirectory`,
`recoverInterruptedDatabaseReplacement` (backup) and `upsertSetting`,
`insertSettingIfMissing` (settings). One more internal export:
`createMaintenanceAbortError` in `main/db.ts` (called by moved backup
code). No other new exported names on the `main/db` surface.

Battery: baseline on clean base 32/32 green (migration registry
371/371, oracle 12/12, lint 964/0 backend + 0/0 frontend). After both
parts, the full Stage 2 battery 32/32 green, serially with `npm run
clean` between suites, proxy unset except `build:frontend`: lint,
lint-engine, i18n:check, build, build:frontend, migration-registry
371/371 (122 migrations, v1..v122), upgrade-path, upgrade-matrix
harness, backup, local-backup, inventory-legacy-precision-backup,
e2e-syria-default, reports-reconciliation, integration-reconciliation,
bills-settlement-idempotency, issue-exact-balance-settlement,
issue-zero-balance-settlement, currency-split, payment-methods-split,
issue-214-migration, migration-v56-v57, migration-v71-repair,
migration-v80-cash-drawer-pulse, migration-v81-cash-closures,
phone-migration, printer-migrations, charges-engine,
integration-payments, integration-order-hold-payment, held-orders,
bills-print-api, receipt-column-oracle 12/12, no byte change. Lint
unchanged at 964 warnings / 0 errors backend, 0/0 frontend (one
transient +1 from the moved-only `os` import in `db.ts` was removed;
one transient +1 from a moved-only `resolveContainedPath` import was
removed with the move). Per-suite logs are outside the repo under
`~/workspace/rest-cafe-docs/stage2-delivery1-2026-10-30/` (baseline/,
part1/, part2/). No test additions: none were needed; the move is
verbatim and the battery covers the moved surfaces. No Graphify
refresh: no `graphify-out/` report exists in this environment.

Formatter churn: the pre-commit hook ran on both refactor commits; no
wholesale normalization appeared in the diffs (moved code was already
formatted; the only new lines are import/re-export blocks and the two
internal accessors). Total line count grew 9,214 -> 9,353 across the
three files, all facade wiring.

Next: Delivery 2 starts only after Delivery 1 lands (assignment
thread 20261030-014 stays open). Please verify and land through your
push path; the one judgment call to confirm at review is the
`getRawDatabase()` accessor pattern above, which Delivery 2's
`core.ts` should absorb together with the `db` holder.
