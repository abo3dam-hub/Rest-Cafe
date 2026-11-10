From: assistant
To: ted
Kind: status
Thread: 20261110-056
Subject: Printing finalization Phase B, delivery B3 done — PF-02 logo raster respects the capability gate (thread 20261110-050)

Printing finalization Phase B, delivery B3 is complete, per Ted's decision
20261110-055 (thread 20261110-054), which accepted and landed B2 (PR #32)
and orders B3 NEXT, under decision 20261110-051 (thread 20261110-050).

Base head: b7b5b546b987eec7f082a797e665268a7dd03500 (upstream main, B2 landed + follow-up 52 + decision 055)
Branch: assistant/printing-finalization-b3

## What changed (PF-02 — receipt logo raster respects the capability gate)

Receipt-logo GS v 0 bands are raster output, so they now follow the raster
gate on both render paths: a logo is emitted only when the effective
capabilities have raster on (`rasterCapabilityEnabled`), and a configured
logo suppressed by the gate produces an explicit warning through the
existing bill-print-warnings channel instead of vanishing silently.

- shared/print/warnings.ts:18 — new `makeLogoRasterSuppressedWarning()`
  (field `receipt logo`, kind `configuration`, message "Receipt logo was
  not printed because raster printing is not enabled for this printer.").
  Shared by backend and frontend so both paths warn with identical text.
  The logo is non-financial, so this is a warning, never a refusal — the
  receipt still prints.
- main/printers/document-classic.ts:640 — the business-header logo block
  in `renderBillDocumentToClassicLines` now emits bands only when
  `rasterCapabilityEnabled(options.capabilities)`; otherwise it pushes the
  suppression warning (line 653). New optional `warnings` sink on
  `ClassicDocumentRenderOptions` (line 288), passed through by
  `renderClassicReceiptViaDocument` (line 1449) into the warnings array
  `prepareReceipt`/`printReceipt` already return and the print queue
  already records with the bill via `markBillPrintedOnDispatch`.
- main/printers/document-merchant.ts:73 — merchant templates render
  through the same classic lines, so they pass their warnings array too;
  a merchant receipt with a configured logo is gated and warned the same way.
- frontend/src/lib/printer/receipt-encoder.ts:626 (classic) and :1163
  (compact) — the same gate + warning in both encoder paths. The warnings
  land in the `encoderWarnings` array `usePrinter.ts` already collects and
  returns from `printBill`, so they are recorded with the bill like any
  other print warning. The native-fallback caps shape
  (`nativeFallbackCapabilities`, raster off with width kept) is what the
  frontend passes here, so an unvalidated generic printer no longer emits
  logo GS v 0 bands from the browser path either.

Deliberately unchanged: `buildBillDocument` still attaches `logoRaster`
whenever a logo is configured (the document model stays capability-agnostic;
the gate lives where capabilities are known). The backend compact renderer
has no logo path and needed no change. No golden regeneration; the oracle
fixture configures no logo, and its bytes are unchanged (13/13 below).

## Tests (tests/receipt-logo-printing.test.ts, §6–§7, run inside test:print-document)

- §3 updated: the "logo emitted" case now passes explicit raster-on
  capabilities (previously it called `formatReceipt` with no capabilities
  and relied on the ungated default) and asserts no suppression warning.
- §6 (line 509, backend classic via `formatReceipt`): raster on emits
  GS v 0 with no warning; native-fallback caps (raster off, widthDots 576)
  suppress with exactly one `configuration` logo warning; strict generic
  baseline (raster off, widthDots 0) suppresses with one warning; no
  capabilities at all suppresses with one warning (no effective capability
  has raster on).
- §7 (line 586, frontend classic + compact encoders via
  `loadFrontendPrintModules` and the parity fixtures): raster on emits
  GS v 0 with no warning; native-fallback caps suppress with exactly one
  logo warning, on both templates.

## Battery (full protecting battery)

31 commands, 30 exit 0. The single exit 1 is `test:raster`, Electron half
NOT RUN on this host — `Missing X server or $DISPLAY`, pre-existing since
D5, reproduced on a pristine checkout. Supplementary Xvfb run of
`test:raster`: exit 0 ("Chromium raster surface rendered styled RTL
output", "Warm Chromium raster singleton lifecycle passed").

- test:printer 0 (printer.test.ts 460 passed, 0 failed; printer-api
  112/112 passed, 0 failed; menu-selection passed; printer-ipc passed)
- test:printing-settings 0, test:print-parity 0 (613 assertions passed,
  0 failed), test:receipt-column-oracle 0 (13/13 pass, 0 fail —
  byte-identical, no golden regeneration), test:receipt-column-width 0
- test:thermal-capabilities 0, test:kot-print-queue 0 (146/146 passed,
  0 failed), test:kot-line-wrap 0, test:kot-order-notes 0,
  test:bill-print-warnings 0 (17/17), test:bill-printed-at 0 (16/16),
  test:menu-printing 0, test:print-kernel 0, test:print-document 0
  (46 checks passed; receipt-logo suite all green incl. new §6–§7),
  test:merchant-print-templates 0, test:delivery-slip 0,
  test:printer-width-refresh 0, test:printer-migrations 0,
  test:webusb-printer-selection 0, test:receipt-printing 0,
  test:bills-print-api 0 (34/34 passed, 0 failed),
  test:issue-printing-and-kds-resilience 0,
  test:issue-266-currency-symbol-print 0, test:print-labels 0
- i18n:check 0, lint 0 (1 frontend warning / 0 errors — the
  pre-existing warning, same as baseline), build 0,
  build:frontend 0, docs:check 0, test:migration-registry 0
  (389/389 checks passed, 128 migrations v1..v128)
- Pre-move baseline at base b7b5b54 (oracle + lint) was green before
  any edit; `npm run clean` between suites; proxy unset except
  build:frontend (proxy on). Logs under
  ~/workspace/rest-cafe-docs/printing-finalization-b3-2026-11-10/logs/
  (summary.tsv + per-suite logs + test-raster-xvfb.log).
  Battery script: printing-finalization-b3-2026-11-10/b3-battery.sh (B2's
  script, same 31 commands).

## Disclosures

- Formatter churn (pre-commit hook, oxc): none beyond the edited lines —
  the committed diff is exactly the 5 B3 files (4 fix + 1 test), no
  wholesale normalization of any never-formatted file.
- No import cycle introduced: the shared warning helper lives in
  shared/print/warnings.ts, which both the backend renderer and the
  frontend encoder already import from (type-only before, now also the
  helper); no new cross-layer edge was added.
- Physical-printer verification is outstanding (owner's machine) — no
  real-printer claim is made here. The gate + warning are proven in code
  and pinned by test, not by a hardware print.

## What is next

B4 (PF-03: remove 'whole-receipt' from all four profiles' modes, keep
`encodeWholeReceiptRaster` + its test) starts only after B3 lands, per
decision 051. No installer for B3; the installer is dispatched after the
last production delivery (B4), per decision 051.
