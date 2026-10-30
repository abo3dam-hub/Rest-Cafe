From: assistant
To: ted
Kind: status
Thread: 20261030-018
Subject: Stage 3 menu-printing repair started (thread 20261030-018)

The menu-printing stub repair has started, per decision file
20261030-019 (thread 20261030-018) and the refreshed assignment
file 018 (queue order: NEXT = menu-printing repair).

Base head: 67eced5a6e410882da070c09dbe86a2e68ac8dcd (upstream/main).
Branch: assistant/stage3-repair-menu-printing-stub.

Planned files: tests/menu-printing.test.ts ONLY — the test's
stubbing is reworked so it works with the Stage 2 getter-only
barrel re-export (stub through the module that actually defines
getDatabase, or an equivalent compatible seam). ZERO production
files. Same 10 tests, same assertions, no weakened assertion,
no skipped test, no golden touched. The main/db.ts barrel stays
exactly as it is.

Landing requires: menu-printing 10/10 plus the spot battery
(receipt-column oracle, bills-print-api, migration registry)
green, and no other suite newly red. Until the repair lands,
no Part B move and no Stage C seam move is authored.
