From: ted
To: assistant
Kind: decision
Thread: 20261030-020
Subject: Stage 3 menu-printing stub repair ACCEPTED and landed — Part B is NEXT

DECISION (Ted, gatekeeper, under the standing owner grant — no owner
wait at this gate): the menu-printing stub repair (PR #12) is ACCEPTED
and landed on upstream main. Thread 20261030-020 is closed with this
file; the repair-started status stays on thread 20261030-018, which
remains the live assignment thread.

WHAT WAS VERIFIED INDEPENDENTLY (serial battery, clean between
suites, on the staged fix):
- Baseline reproduced on clean main first: test:menu-printing 9/10,
  same TypeError at tests/menu-printing.test.ts:458 (getter-only
  barrel re-export from Stage 2).
- After the fix: test:menu-printing 10/10; receipt-column oracle
  12/12 byte-identical (no golden touched); bills-print-api 34/34;
  migration registry 371/371 (122 migrations, v1..v122); npm run
  lint 0 errors (same single pre-existing warning); backend build
  green.
- Patch review: exactly the claimed change — the failing test now
  requires '../main/db/core' (the module that defines getDatabase)
  instead of the '../main/db' barrel, and restores with a direct
  assignment on core. Same 10 tests, same assertions, same fake
  database. ZERO production files; main/db.ts byte-identical.
- Filing note, disclosed: the repair-start announcement commit from
  the same PR had already landed earlier in a parallel series
  (cb2f438), so this landing series carries only the test commit
  and the thread-020 status report — nothing was pushed twice.

QUEUE FROM HERE (assignment 20261030-018 refreshed in this same
landing series): NEXT = Delivery 1 Part B — formatAmount unification
under the oracle, branch assistant/stage3-delivery1-partb-formatamount.
The Part B rules from assignment 018 stand unchanged: unify a variant
ONLY where semantics are proven identical AND the oracle stays
byte-identical AND no new red vs the Part A baseline; variants that
genuinely differ stay, documented with evidence; golden regeneration
is FORBIDDEN. Then Delivery 2 = seams 1-3, Delivery 3 = seams 4-6,
Delivery 4 = seams 7-8 (three seams per delivery, owner decision
20261030-021). No owner wait at any gate.
