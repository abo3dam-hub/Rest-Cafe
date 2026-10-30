From: ted
To: assistant
Kind: decision
Thread: 20261030-018
Subject: Stage 3 COMPLETE — Delivery 4 accepted, thermal.ts slim 3, seams 7-8 (PR #16 landed)

Stage 3 is complete. Ted verified PR #16 independently, line by line
and with the full serial Stage 3 battery on the final tree as landed:

- Patch is a pure move: seam 7, the S9 plugin ESC/POS line-template
  renderer, moved from main/printers/thermal.ts into the new
  main/printers/document-plugin-receipt.ts (583 lines); seam 8, the S8
  receipt entry dispatch plus S10 compact/classic wrappers and plugin
  column helpers, moved into the new main/printers/receipt-entry.ts
  (470 lines). thermal.ts went from 2,092 to 1,093 lines and keeps
  re-exports (it imports formatReceipt and re-exports six symbols from
  receipt-entry.ts), so no call site outside main/printers/ changed.
  No golden file was touched or regenerated. Export surface of
  thermal.ts is unchanged (60/60, counted mechanically including
  re-exports). Moved blocks were checked mechanically byte-for-byte
  against the base, modulo import lines, the export keyword, and one
  header comment per new file; the one in-delivery import retarget
  (document-plugin-receipt.ts ./thermal -> ./receipt-entry) stays
  inside main/printers/.
- Disclosed and accepted: renderPluginReceipt gained a one-word
  export (formatReceipt calls it); the four S10 helpers were declared
  without export in thermal.ts and are now exported from
  receipt-entry.ts for document-plugin-receipt.ts's internal use only;
  the thermal.ts <-> new-module import cycles are call-time use only
  (top-level constants in the new files are plain literals; every
  cross-module use sits inside a function body), the same shape
  accepted for Deliveries 2-3. Any load-time use in later work stops
  that work and is reported; it is not covered by this acceptance.
- Documented deviation (record hygiene, not behavior; same class as
  the Stage 2 Part 3 deviation): the seam 7 commit alone does not
  build as pushed — document-plugin-receipt.ts imports from
  ./receipt-entry, which only arrives with the seam 8 commit
  (TS2307, reproduced by Ted in an isolated build). The tree is green
  from the seam 8 file commit onward, and the final tree passed the
  full battery below. The seam 7 commit was still landed in order so
  the per-seam history stays intact, and the deviation is recorded in
  follow-up 25 rather than hidden.
- Battery (serial, npm run clean between suites, isolated worktree):
  30/30 effective — lint, lint-engine, i18n:check, backend build,
  frontend build, receipt-column oracle 12/12 byte-identical,
  bills-print-api 34/34, all printer suites, migration registry
  371/371 (122 migrations), backup, menu-printing 10/10, Syria
  default. test:raster is red without an X server (Missing X server
  or $DISPLAY — declared environment skip off-Windows) and green
  under xvfb, exactly as at baseline; no new red versus baseline.

Stage 3 as a whole: thermal.ts went from 4,227 lines to 1,093 lines
over eight new modules under main/printers/, with zero behavior
change in any delivery and zero golden regenerations. Delivery 1
(classification + formatAmount evidence: zero variants unify safely)
is part of this completion. The Windows installer is dispatched from
the new main after this landing; physical-printer verification on the
owner's machine remains outstanding, as always — a verification
limit, not an approval gate.

No authorized work remains in the queue: assignment 018 is closed
with this decision. Subsequent loop runs should find nothing pending
and end silently; no new work is to be invented.
