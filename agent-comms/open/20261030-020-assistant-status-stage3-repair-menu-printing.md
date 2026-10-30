From: assistant
To: ted
Kind: status
Thread: 20261030-020
Subject: Stage 3 menu-printing stub repair done — menu-printing 10/10 (thread 20261030-018)

The menu-printing repair is done, per decision file 20261030-019
(thread 20261030-018). Base head:
67eced5a6e410882da070c09dbe86a2e68ac8dcd (upstream/main).
Branch: assistant/stage3-repair-menu-printing-stub.

WHAT CHANGED (test-only; ZERO production files; the main/db.ts
barrel is byte-identical):
- tests/menu-printing.test.ts:391-393 — the failing test now
  requires '../main/db/core', the module that actually defines
  getDatabase, instead of the '../main/db' barrel. The barrel is
  a getter-only re-export since Stage 2, so assigning the stub
  on it threw `TypeError: Cannot set property getDatabase of
  #<Object> which has only a getter` at the old line 458.
- tests/menu-printing.test.ts:458 — the stub assignment itself
  is unchanged (same fake database, same prepare/all/get
  behavior); it now lands on core's writable export, and the
  barrel's re-export getter reads the stub at call time, so the
  print-menu route sees the fake exactly as before.
- tests/menu-printing.test.ts:631 — the finally restore is now
  a direct assignment on core (`database.getDatabase =
  originals.getDatabase`); the old `Object.assign` on the barrel
  would have thrown the same getter error on restore.
- Same 10 tests, same assertions, no weakened assertion, no
  skipped test, no golden touched. No other file changed.

BATTERY (base 67eced5, then after the fix; logs in
~/workspace/rest-cafe-docs/stage3-repair-menu-printing-2026-10-30/):
- test:menu-printing: baseline 9/10 (the line-458 red,
  reproduced at base) -> post-fix 10/10.
- test:receipt-column-oracle: 12/12 before and after,
  byte-identical (no oracle diff).
- test:bills-print-api: 34/34 before and after.
- test:migration-registry: 371/371 (122 migrations, v1..v122)
  before and after.
- npm run lint: exit 0 before and after (same single warning).
- No other suite was run: the change is confined to one test
  file, no production file changed, and Ted re-runs the full
  battery at landing. Physical-printer verification on the
  owner's machine remains outstanding for every printing stage.

WHAT IS NEXT: per the refreshed assignment (thread 20261030-018),
Part B (branch assistant/stage3-delivery1-partb-formatamount)
starts only after this repair lands; no Part B move and no
Stage C seam move is authored until then.
