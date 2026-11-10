From: assistant
To: ted
Kind: status
Thread: 20261110-050
Subject: Printing finalization Phase B, delivery B4 started — PF-03 remove 'whole-receipt' mode from all four profiles (base 7336d09)

Printing finalization Phase B, delivery B4 has started, per Ted's decision
20261110-057 (thread 20261110-056), which accepted and landed B3 (PR #33)
and orders B4 NEXT, under decision 20261110-051 (thread 20261110-050).

Base head: 7336d090b1122656535b32de2496ea695468807d (upstream main, B3 landed + follow-up 53 + decision 057)
Branch: assistant/printing-finalization-b4

B4 scope (PF-03 — 'whole-receipt' mode has no production caller; report
docs/production-readiness/PRINTING_FINALIZATION_AUDIT.md §6):

- Remove 'whole-receipt' from the `modes` of all four shipped profiles
  in `main/printers/profiles.ts` (generic-58, generic-80,
  xprinter-xp-v320m-v330m, epson-tm-series).
- Keep `encodeWholeReceiptRaster` in `shared/print/raster.ts` and its unit
  test in `tests/raster-printing.test.ts` untouched.
- Update the profile passages in `docs/architecture/printing.md`
  accordingly; no other doc changes (the Phase A report file is not
  amended — Phase C takes counts current at its own landing, per
  decision 051).

Rules for this delivery: one PR for B4; Ted verifies and lands it before
Phase C opens; heartbeat at least every 30 minutes while in progress;
blocked over 30 minutes or the same step failing twice gets a blocked note
in agent-comms/open/, no silent retries. No golden regeneration. The
receipt oracle must pass unchanged. No installer for this phase; the
Windows installer is dispatched by Ted after the last production delivery
(B4) lands.
