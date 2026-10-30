From: assistant
To: ted
Kind: status
Thread: 20261030-017
Subject: Stage 2 Delivery 2 done — migrations.ts + core.ts behind the db.ts barrel (thread 20261030-014)

Delivery 2 (assignment thread 20261030-014) is done and ready for
verification. Branch `assistant/stage2-delivery2-migrations-core`, base
`e204edf68eff68041fa003bf8cddd53561b992cb`. Pure moves only; zero call-site
changes; no logic edits, no renames of exported symbols, no signature
changes. `main/db.ts` (150 lines) is now a pure re-export barrel for
`main/db/backup.ts`, `main/db/settings.ts`, `main/db/core.ts`, and
`main/db/migrations.ts`. Migration order and content are untouched
(`MIGRATIONS` still one array, same identity via the barrel re-export,
so tests that mutate it keep working). Zero lost exports: 137/137 public
names from the base `main/db.ts` are re-exported by the barrel, no extras.

Part 3 — migrations registry + initial schema -> `main/db/migrations.ts`
(4,396 lines). Moved verbatim, in original order: `USER_ROLE_SQL_CHECK`
(`main/db/migrations.ts:30`), `sha256Hex` (`:32`), the ideal-schema /
recovery reference block (`getRecoverySchemaBuildCount` `:47`,
`isHealthyDatabaseFile` `:100`, `normalizedSchemaDefinitions`),
`buildIdealSchemaDb` (`:159`), `MIGRATIONS` (`:178`, 122 migrations,
v1..v122), `syncBackupBeforeMigration`, `SchemaVersionMismatchError`,
`runMigrations` (`:3662`), `createSchema` (`:3704`) and the tax-pack /
cloud-sync / WhatsApp schema + seed helpers. Commit `e59aeda`.

Part 4 — remaining core -> `main/db/core.ts` (1,530 lines). Moved
verbatim: the `db` instance + `getRawDatabase()` (`main/db/core.ts:30`),
maintenance-lock machinery, `getDbHealth`/`getDbPath`, `initDatabase`
(`:544`), `getDatabase` (`:873`), `now()` (`:1153`), sequence/date/KDS
helpers and the `dayBoundsInTimezone`/`utcDayBounds` re-export. Commit
`22bfe2d`. In Part 4 only, `main/db/migrations.ts` changed by one line:
its shared-core import source moved from the `../db` facade to `./core`.

Shared-state seams (disclosed, behavior-identical; Delivery 1 pattern):
the module-level `db` variable stays in `core.ts`. Moved migration code
that read `db` directly now calls the existing `getRawDatabase()` accessor
at call time (313 AST-verified substitutions, code identifiers only — the
`.db` backup filename string literal is untouched; same live instance,
including the ideal-schema swap). The swap itself goes through one new
internal function, `setRawDatabase()` (`main/db/core.ts:500`, exported
from `core.ts` only, NOT re-exported by the barrel), used solely by
`buildIdealSchemaDb` with the original try/finally restore. `runMigrations`
gained `export` in `migrations.ts` so `core.ts` can import it; it is NOT
re-exported by the barrel. `core.ts` imports `runMigrations` from
`./migrations` and `migrations.ts` imports core helpers from `./core`:
a module cycle, load-time safe because neither module calls the other at
import time (same argument as Delivery 1's facade cycle, which Ted
accepted) — all cross-calls happen at migration/init runtime, after both
modules are loaded. `backup.ts`/`settings.ts` still import from the
`../db` facade exactly as in Delivery 1; untouched here.

Relocation adjustments (the only non-verbatim edits besides the seam
above, all required by the new file locations, each behavior-identical):
relative import/require paths rewritten for `main/db/` (`../lib/phone`
for the two dynamic requires in migrations v23/v24, `../tax-packs`,
`../../shared/*`, `./backup`, `./settings`, `../shutdown`,
`../../shared/business-date`, `../countries`); `getDbPath()` in
`core.ts` (`:512`) resolves one extra level per layout because `core.ts`
sits one level deeper than `main/db.ts` did — verified arithmetically
that the computed root is identical in both the source layout
(`main/db` -> repo root) and the built layout (`dist/main/db` -> repo
root). No call site, migration body, SQL string, or default changed.

Helper placement (assignment's choice, disclosed): migration `up()`
closures use module-local helpers — the helpers moved with the code that
needs them: `insertSettingIfMissing`/`upsertSetting` imported from
`./settings`, `getColumns`/`getTables`/`getForeignKeyViolationKeys`/
`pathEntryExists`/`syncFile`/`syncDirectory`/`getBackupDir` imported
from `./backup`, `now`/`insertOrderItemAddons`/`getCurrentSchemaVersion`/
`getDbPath`/`registerOrderSearchFunctions` imported from `./core`. No
shared internal context object was introduced. `sha256Hex` moved into
`migrations.ts` (its only use is one migration) rather than gaining an
export from `core.ts`.

Battery (serially, `npm run clean` between suites, proxy unset except
`build:frontend`): baseline on clean base 32/32 green (migration registry
371/371, 122 migrations; receipt-column oracle 12/12; lint 964 warnings /
0 errors backend, 0/0 frontend). Part 3 intermediate commit also 32/32
green after two explained reds were fixed and the battery re-run from
scratch (first Part 3 run: `build` failed on the new relative import
paths and `runMigrations` lacking an export, and the registry suite then
failed on `require('./lib/phone')` from the new directory — all three
were relocation path errors, fixed as above, no stop condition fired).
Post-move battery 32/32 green on the final bytes: migration registry
371/371, upgrade-path and upgrade-matrix green, receipt-column oracle
12/12 with no byte change, lint unchanged (964/0 backend, 0/0 frontend),
`build` and `build:frontend` green. Logs are outside the repo under
`~/workspace/rest-cafe-docs/stage2-delivery2-2026-10-30/` (`baseline/`,
`part3/`, `post-move/`).

Formatter churn disclosure: the pre-commit hook (prettier) reflowed the
longer `getRawDatabase()` call chains in `migrations.ts` (line breaks
only) and reordered/collapsed imports in `core.ts`; no semantic change.
No file outside `main/db.ts`, `main/db/core.ts`, `main/db/migrations.ts`
and the two agent-comms status files is in the diff. No printing code
touched; physical-printer verification remains outstanding (owner's
machine), as always.

Next: Ted verifies and lands; when Delivery 2 lands, Stage 2 is complete
and Ted builds the Windows installer and closes thread 20261030-014.
Please check in particular the `core.ts` <-> `migrations.ts` cycle, the
`setRawDatabase()` swap seam, and the `getDbPath()` depth adjustment.
