From: assistant
To: ted
Kind: status
Thread: 20261110-058
Subject: Printing finalization Phase B, delivery B4 done — PF-03 remove 'whole-receipt' mode from the four shipped profiles (thread 20261110-050)

Printing finalization Phase B, delivery B4 is complete, per Ted's decision
20261110-057, which accepted and landed B3 (PR #33, final head 5ba440a) and
orders B4 NEXT, under decision 20261110-051 (thread 20261110-050).

Base head: 7336d090b1122656535b32de2496ea695468807d (upstream main, B3 landed)
Branch: assistant/printing-finalization-b4

## What changed (PF-03 — `whole-receipt` mode removed from the shipped profiles)

`whole-receipt` had no production caller; only a test exercised it. The mode
is removed from every shipped raster declaration, so no profile — branded or
validated generic — can be handed a `whole-receipt` job in production. The
encoder and its unit test are untouched, per decision 051.

- main/printers/profiles.ts:59 — `xprinter-xp-v320m-v330m` raster modes
  `['mixed', 'whole-receipt']` → `['mixed']`.
- main/printers/profiles.ts:82 — `epson-tm-series` raster modes
  `['mixed', 'whole-receipt']` → `['mixed']`.
- main/printers/profiles.ts:205 — `validatedGenericRaster()` modes
  `['mixed', 'whole-receipt']` → `['mixed']`. This is the raster a validated
  generic printer gains, i.e. the generic profiles' effective raster, so it
  follows the same removal; a validated generic printer's printed bytes are
  unchanged (the `mixed` path is what renders).
- tests/raster-printing.test.ts:194,201 — the two deep-equal pins on the
  validated-generic raster (`validated80` / `validated58`) updated to the
  decided new shape, `modes: ['mixed']`. The pins still pin the full raster
  object (enabled, widthDots, maxBandHeight, modes); nothing was weakened.
  The synthetic-capability pins are untouched: the `capability()` helper
  (:120) and the legacy-generic caps (:414), which keep proving the
  validated path's bytes match the old generic output.
- docs/architecture/printing.md:239,244 — the profile passage now says the
  branded profiles declare mode `mixed` only, and a validated generic gains
  raster with mode `mixed` only.
- docs/architecture/printing.md:335-338 — the Raster printing passage now
  says the declared mode is `mixed` only, and that no shipped profile
  declares `whole-receipt`; `encodeWholeReceiptRaster` keeps that path for
  its unit test with synthetic capabilities only.

Untouched, per decision 051: `encodeWholeReceiptRaster` in
shared/print/raster.ts:209 (and the `ThermalRasterMode` type, which still
includes `'whole-receipt'` for that synthetic path) and its unit test in
tests/raster-printing.test.ts:1230; docs/production-readiness/
PRINTING_FINALIZATION_AUDIT.md (the Phase A report is frozen — Phase C
takes counts current at its own landing).

## Battery (serial, `npm run clean` between suites, proxy unset except `build:frontend`)

18 commands, 17 exit 0. Logs:
~/workspace/rest-cafe-docs/printing-finalization-b4-2026-11-10/

- lint exit 0 — backend 830 warnings / 0 errors, frontend 1 warning / 0 errors
- lint-engine (test:lint-engine) exit 0 — parity + formatter behaviour verified
- i18n:check exit 0 — translation integrity + negative tests passed,
  print-labels drift check passed, frontend tsc clean
- build exit 0
- build:frontend exit 0 (proxy on)
- script-coverage (test:script-coverage) exit 0
- docs:check exit 0 (policy findings are warnings, not gated)
- receipt-column-oracle exit 0 — 13/13, fail 0, golden byte-identical (no
  golden regeneration)
- test:raster exit 1 on the Electron half only — NOT RUN: no X server /
  $DISPLAY on this host (pre-existing since D5; the Node half passed:
  "Raster encoder and mixed-mode contract checks passed."). Xvfb
  supplementary (`xvfb-run -a npm run test:raster-electron`) exit 0.
- thermal-capabilities exit 0 — backend/WebUSB fixture parity passed,
  Windows stderr/encoding/detail/toast/chunking suites passed
- printer exit 0 — printer 460 passed, printer-api 112/112, print-menu
  printer selection passed
- print-parity exit 0 — 613 assertions passed, 0 failed
- menu-printing exit 0 — 10/10
- bills-print-api exit 0 — 34/34
- kot-print-queue exit 0 — 146/146
- migration-registry exit 0 — 389/389 (128 migrations, v1..v128)

Baseline (before editing, at base 7336d09): receipt-column oracle 13/13 and
lint exit 0 (1 warning / 0 errors frontend), both green.

No `diff-check` script exists in this tree (no such entry in package.json);
diff scope was verified manually instead: `git diff --stat
upstream/main...origin/assistant/printing-finalization-b4` contains only the
three files above plus the announce file and this status file.

## Formatter-churn disclosure

None. The pre-commit hook did not reformat any file: the diff is 11
insertions / 10 deletions across the three files above, each change a
single-line modes or doc-sentence edit.

## What is next

Phase C (docs + matrix + closure recommendation) opens with a separate Ted
decision after B4 lands — PF-06/07/08 and PF-05 (accepted residual risk)
are recorded there. No Windows installer until after B4 lands, per
decision 051; the installer is dispatched by Ted after this last production
delivery.

Physical-printer verification remains outstanding on the owner's machine —
no hardware-print claim is made.
