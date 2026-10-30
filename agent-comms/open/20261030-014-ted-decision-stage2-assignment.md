From: ted
To: assistant
Kind: decision
Thread: 20261030-014
Subject: Current assignment — Stage 2: restructure main/db.ts behind a facade (live queue item)

Stage 1 is complete (acceptance: closed/20261030-013-ted-decision-
stage1-complete.md). This file is the live assignment queue for
Stage 2 and stays in open/ until the stage completes. Always work
from the version on upstream main.

UPDATE 2026-10-30 — DELIVERY 1 LANDED (PR #9, accepted in
closed/20261030-016-ted-decision-stage2-delivery1-accepted.md;
report follow-up 16): main/db/backup.ts + main/db/settings.ts are
on main behind the db.ts facade. DELIVERY 2 IS NEXT AND UNLOCKED:
branch assistant/stage2-delivery2-migrations-core may start now,
with the same delivery-start announcement as its first action.

Goal: split main/db.ts (9,214 lines, 114 exports, ~305 getDatabase()
call edges) into main/db/* modules while main/db.ts becomes a
re-export barrel. ZERO call sites change; ZERO behavior change;
migration ORDER and content stay behavior-identical (the migration
registry, 371/371, is the guard). Pure moves only: no logic edits,
no renames of exported symbols, no signature changes.

Two deliveries (owner acceleration decision: two parts per delivery;
commits stay separate per part so review and revert stay granular):

DELIVERY 1 — branch assistant/stage2-delivery1-backup-settings
  Part 1: backup / restore / replacement journals -> main/db/backup.ts
  Part 2: settings + revision counter -> main/db/settings.ts

DELIVERY 2 — branch assistant/stage2-delivery2-migrations-core
  (starts only after Delivery 1 has landed)
  Part 3: migrations registry + initial schema -> main/db/migrations.ts
    Migration up() closures use module-local helpers (db, now(),
    upsertSetting, ...): move the helpers with the code that needs
    them, or pass a shared internal context — your call, disclose
    which in the stage report.
  Part 4: the remaining core (getDatabase / database core) ->
    main/db/core.ts; main/db.ts ends as a pure re-export barrel.

Every part is its own commit, and db.ts re-exports each moved piece
in the same commit that moves it, so every commit compiles and
passes on its own.

Baseline first: before Delivery 1's first move, run the Stage 2
battery below on clean upstream main and put the baseline table in
your Delivery 1 start status message. Any baseline red that is not
already documented known debt: stop and report in a comms PR before
moving anything.

Announce every delivery start: the FIRST action on a delivery is to
push its branch carrying one status message in open/ on this thread
(From: assistant, Kind: status) naming the delivery, its base head,
and the planned files. Then work the delivery on that branch; the
hand-back is one PR per delivery.

Stage 2 battery (run before hand-back; Ted re-runs it at landing):
npm run lint, npm run test:lint-engine, npm run i18n:check,
npm run build, npm run build:frontend, npm run test:migration-registry,
npm run test:upgrade-path, npm run test:upgrade-matrix-harness,
npm run test:backup, npm run test:local-backup,
npm run test:inventory-legacy-precision-backup,
npm run test:e2e-syria-default, npm run test:reports-reconciliation,
npm run test:integration-reconciliation,
npm run test:bills-settlement-idempotency,
npm run test:issue-exact-balance-settlement,
npm run test:issue-zero-balance-settlement, npm run test:currency-split,
npm run test:payment-methods-split, npm run test:issue-214-migration,
npm run test:migration-v56-v57, npm run test:migration-v71-repair,
npm run test:migration-v80-cash-drawer-pulse,
npm run test:migration-v81-cash-closures, npm run test:phone-migration,
npm run test:printer-migrations, npm run test:charges-engine,
npm run test:integration-payments,
npm run test:integration-order-hold-payment, npm run test:held-orders,
npm run test:bills-print-api, npm run test:receipt-column-oracle.

Stop conditions, every delivery: first unexplained red, any
migration-registry count other than 371/371, any upgrade-path or
upgrade-matrix failure, any receipt-oracle byte diff — stop and
report in a comms PR instead of pushing through. Test additions are
allowed only as a separate first commit of a delivery, only as new
files, and only if they also pass on the unmoved code; production
behavior stays untouched regardless.

When Delivery 2 lands, Stage 2 is complete: Ted builds the Windows
installer and closes this thread. Until then, this file stays open.
If this file ever seems missing while deliveries remain unlanded,
say so in a comms PR — the queue is Ted's to keep filled.
