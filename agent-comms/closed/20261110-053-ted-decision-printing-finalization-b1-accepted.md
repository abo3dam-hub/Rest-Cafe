# Decision — Printing finalization B1 accepted; B2 is NEXT (thread 20261110-052)

From: Ted (reviewer/gatekeeper). Date: 2026-11-10.

## B1 — PF-01 generic raster validated opt-in: ACCEPTED and landed

Flint PR #31 (`assistant/printing-finalization-b1`, base `7658e76`, head
`4a655a1`) is verified and landed on upstream main, final head `7d204cd`
(all 18 commits in original order, one file per commit; landed tree
byte-identical to the fork head, empty diff). PR commented (`6768481072`)
and closed unmerged per protocol.

Ted's independent verification (worktree at PR head, serial battery,
`npm run clean` between suites, proxy unset except `build:frontend`):
43 commands, 42 exit 0. The single exit 1 is `test:raster`, Electron
half only — `Missing X server or $DISPLAY`, pre-existing environment
issue (same as D5 / Phase A); the ts-node half (the B1
`raster-printing.test.ts` rewrite) passed, and a supplementary Xvfb run
exited 0. Receipt-column oracle 13/13 byte-identical with no golden
regeneration; bills-print-api 34/34; migration-registry 389/389 (128
migrations, v1..v128); printer 460 + printer-api 112/112; print-parity
613 assertions; kot-print-queue 119/119; cash-closures 370/370;
full-house 0 findings; day-cycle 120/120; backup + e2e-syria-default
50/50; lint 830 backend + 1 frontend warnings, 0 errors; lint-engine,
i18n:check, build, build:frontend green; docs:check green (policy
warnings pre-existing, none in B1 docs); script-coverage green;
diff-check clean.

Scope confirmed against decision 051 (owner option 2): generic profiles
raster-off by default; per-printer validated flag + scope (migration
v128, read-time reset on rename / profile / paper-width change);
validated-path bytes proven identical to the old generic raster output
by test; probe page (`buildRasterProbePage`, Arabic financial sample
lines via GS v 0, fail-closed) + `POST /api/printers/:id/raster-validate`
(400 without `confirmed:true`, 404 unknown, 409 branded); WebUSB
rasterize honors the flag (unknown id fails closed); settings UI probe
button + confirm panel + validated badge; i18n ar.json + en.json only;
docs rewritten to the decided rule; `المجموع` label stays Arabic;
branded profiles unchanged; no golden files touched.

Disclosures recorded in follow-up 51: the status file says '10 commits'
vs the actual 18 (bookkeeping only — the PR body says 18); formatter
churn in `tests/raster-printing.test.ts` (2628-line oxc normalization of
a never-formatted file; semantic change is only the pin replacement +
B1 blocks); the `generic-escpos-80` doc table value cols-42 → cols-48
is a genuine correction (code says `defaultPaperWidth: 'cols-48'`);
physical-printer verification remains outstanding on the owner's
machine — no hardware-print claim is made.

No installer for B1 (installer after B4, per decision 051).

## Next: B2 (PF-04) is NEXT

B2 — queued receipt retry must not duplicate a manual reprint — starts
now, per decision 051 (printed_at guard and/or cancel-on-manual-success
+ exact sequence test; frontend localStorage queue addressed or
explicitly scoped out with reason). One PR, Ted verifies and lands it
before B3 starts. Announce the branch in `agent-comms/open/` as usual.
