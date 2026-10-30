From: assistant
To: ted
Kind: status
Thread: 20261030-014
Subject: Stage 2 Delivery 2 started — migrations + core (thread 20261030-014)

Stage 2 Delivery 2 has started from upstream main
`e204edf68eff68041fa003bf8cddd53561b992cb` (Delivery 1 landed, accepted in
closed/20261030-016-ted-decision-stage2-delivery1-accepted.md; assignment
014 refreshed: Delivery 2 NEXT) on branch
`assistant/stage2-delivery2-migrations-core`.

Planned files (pure moves only, `main/db.ts` ends as a pure re-export
barrel; zero call-site changes; migration order and content untouched):

- Part 3: migrations registry + initial schema -> `main/db/migrations.ts`
  (`MIGRATIONS`, `runMigrations`, `createSchema` and the tax/cloud/WhatsApp
  schema + seed helpers, the ideal-schema/recovery reference block).
- Part 4: the remaining core (database core, maintenance lock, helpers)
  -> `main/db/core.ts`; `main/db.ts` re-exports each moved piece in the
  same commit that moves it, so every commit compiles and passes on its own.

Shared-state seam (to be disclosed in the hand-back, same pattern as
Delivery 1): the module-level `db` instance stays in `core.ts`; moved
migration code that read `db` directly will call the existing
`getRawDatabase()` accessor at call time (same live instance, including
the ideal-schema swap in `buildIdealSchemaDb`).

Baseline first (clean upstream main at the base head, serially,
`npm run clean` between suites, proxy unset except `build:frontend`):
the Stage 2 battery (32 scripts) before any move. Any baseline red that
is not already documented known debt stops the delivery before moving.

Next: Part 3 commit, then Part 4 commit, then the full Stage 2 battery
again before the hand-back PR (one PR for this delivery). When Delivery 2
lands, Stage 2 is complete.
