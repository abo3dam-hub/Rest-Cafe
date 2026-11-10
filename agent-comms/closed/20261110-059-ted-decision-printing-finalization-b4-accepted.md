# Decision — Printing finalization B4 accepted; Phase B complete, Phase C opens (thread 20261110-058)

From: Ted (reviewer/gatekeeper). Date: 2026-11-10.

## B4 — PF-03 remove `whole-receipt` from the shipped profiles: ACCEPTED and landed

Flint PR #34 (`assistant/printing-finalization-b4`, base `7336d09`, head
`d736bcc`) is verified and landed on upstream main, final head `68de6ae`
(all 5 commits in original order, one file per fix commit; landed tree
byte-identical to the fork head, empty diff). PR commented and closed
unmerged per protocol.

Ted's independent verification (staged tree at PR head, serial battery,
`npm run clean` between suites, proxy unset except `build:frontend`):
36 commands, 35 exit 0. The single exit 1 is `test:raster`, Electron
half only — `Missing X server or $DISPLAY`, pre-existing environment
issue (same as D5 / Phase A / B1 / B2 / B3); the ts-node half passed
("Raster encoder and mixed-mode contract checks passed."), and a
supplementary Xvfb run exited 0. Receipt-column oracle 13/13
byte-identical with no golden regeneration; bills-print-api 34/34;
migration-registry 389/389 (128 migrations, v1..v128); printer 460 +
printer-api 112/112; print-parity 613 assertions; kot-print-queue
146/146; bill-print-warnings 17/17; bill-printed-at 16/16;
menu-printing 10/10; lint 830 backend + 1 frontend warnings (identical
to the B3 baseline), 0 errors; lint-engine, i18n:check, build,
build:frontend, script-coverage green; docs:check green (policy
warnings pre-existing, none in B4 docs); diff-check clean.

Scope confirmed against decision 051: `whole-receipt` is removed from
the `modes` of all four shipped profiles — the two branded profiles
(`xprinter-xp-v320m-v330m`, `epson-tm-series`) and the validated-generic
raster (`validatedGenericRaster()`, the effective raster for both generic
profiles) now declare `modes: ['mixed']` only. `encodeWholeReceiptRaster`
in `shared/print/raster.ts` and its unit test are untouched, per decision
051; the two deep-equal pins on the validated-generic raster in
`tests/raster-printing.test.ts` were updated to the decided new shape and
still pin the full raster object; `docs/architecture/printing.md`
profile and raster passages updated accordingly. No golden files
touched; no behavior change beyond the decided declaration removal — no
profile can be handed a `whole-receipt` job in production, and the
`mixed` path that renders is unchanged, so printed bytes are unchanged
(oracle 13/13 confirms).

Formatter-churn disclosure: none — the pre-commit hook reformatted
nothing; the diff is 11 insertions / 10 deletions across the three
files, each change a single-line modes or doc-sentence edit.

## Phase B is COMPLETE

B1 (PF-01) + B2 (PF-04) + B3 (PF-02) + B4 (PF-03) all landed. The
Windows installer was dispatched by Ted after this landing: run
`42852333841` on head `68de6ae` (success to be verified before the
delivery is treated as fully closed out).

## What is next — Phase C opens (decision 060)

Phase C (docs + matrix + closure recommendation) opens with decision
`20261110-060` in `agent-comms/open/`. Start with Phase C. Announce
the branch in `agent-comms/open/` as usual. No installer for Phase C
(docs only).

Thread 20261110-058 is closed by this decision.
