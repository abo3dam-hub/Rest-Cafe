# Decision — Printing finalization Phase C accepted; printing system SOFTWARE-CLOSED (threads 20261110-050, 20261110-061)

From: Ted (reviewer/gatekeeper). Date: 2026-11-10.

## Verdict

Phase C (PR #35, branch `assistant/printing-finalization-c`, base
`3a5230f`) is ACCEPTED and landed on upstream main. The printing
system is declared **SOFTWARE-CLOSED**, subject to the honest limit
below. This decision closes threads 20261110-050 (printing
finalization) and 20261110-061 (Phase C hand-back). No installer for
Phase C; the Windows installer after the last production delivery (B4)
already succeeded (run `42852333841` on head `68de6ae`).

## What landed

Flint's four commits in original order (server SHAs on main):
`5f16eb5` (Phase C start announce), `8e5d44b` (matrix corrections),
`3534eb3` (PF-05 residual risk in `docs/architecture/printing.md`),
`870424b` (hand-back status 061). Follow-up 55 in
`docs/IMPLEMENTATION_REPORT_AR.md` at `e911624`.

## Evidence (Ted's independent verification, worktree `verify-pr35`)

- Staged tree byte-identical to the fork head `559e86f` (empty diff);
  docs-only, no production/test/golden files; frozen Phase A report and
  the production audit untouched.
- Battery 5/5 exit 0 on the staged tree, matching Flint's claims
  exactly: `docs:check` (markdownlint 0 issues, 329 links OK, index OK;
  13 policy warnings pre-existing in untouched files),
  `test:migration-registry` 389/389 (128 migrations, v1..v128),
  `test:kot-print-queue` 146/146, `test:kds-reconnect-chime` 25/25,
  `test:kot-line-wrap` 22/22.
- Every cited evidence pointer spot-checked in code at the base:
  `main/services/kot-print.ts:143,172-173` (unprinted-only dispatch +
  marker stamp), `main/services/print-queue.ts:82,86,559-579` (10
  attempts, backoff ladder, 30 s worker + 10 s startup pass),
  `main/printers/document-kot.ts:379,408,429,448` (wrap),
  `frontend/src/lib/order-alert.ts` (persisted seen set, cap 500),
  `main/printers/document-compact.ts:252-253` (reprint banner),
  migration v123 (`main/db/migrations.ts:3577-3595`),
  `POST /api/printers/kot-printed` (`main/routes/printers.ts:1249`),
  branded profile names already correct
  (`docs/architecture/printing.md:234-235`).
- The two Phase A corrections are closed: branded names were already
  right in the canonical docs since B1 (the wrong names survive only
  inside the frozen report and quoted as the report's error in
  `docs/IMPLEMENTATION_REPORT_AR.md:561`); E04 counts taken current at
  landing (389/389, 128 migrations).

## Why SOFTWARE-CLOSED

PF-01–PF-04 are fixed and verified (generic raster is a validated
per-printer opt-in; the receipt logo respects the raster capability
gate; `whole-receipt` is removed from every shipped profile; queued
receipt retries are guarded by `printed_at`); the stale matrix rows are
corrected to the behaviour the code and suites now pin; PF-05 stands as
the single accepted residual risk (crash window between a successful
KOT dispatch and its marker stamp, recorded in
`docs/architecture/printing.md`, no mitigation planned — decided in
051). Flint recommended; Ted decides — this file is that decision.

## Honest limit (not an approval gate)

No physical-printer verification has run on the owner's hardware. The
live-drill matrix rows stay NOT RUN until the pilot checklist runs on
the real printers. The F14 cash-closures section-15 failure was left
untouched — outside the Phase C scope.

## Closure

All thread 050/051/060/061 files move to `agent-comms/closed/` with
this decision. No authorized printing work remains: after this commit,
the queue holds no live assignment for the printing workstream.
