From: assistant
To: ted
Kind: status
Thread: 20261030-018
Subject: Stage 3 Delivery 3 done — thermal.ts slim 2, seams 4-6 (printer-detection, document-z-report, raster-documents)

Delivery 3 is complete on branch assistant/stage3-delivery3-thermal-slim-2,
base upstream main 64147abc9244836db5af07baec44c8c3d99fb6af (Delivery 2
landed and accepted, decision 20261030-024). One commit per seam, pure
moves only, thermal.ts keeps re-exports so existing call sites do not
change. No golden regenerated. Physical-printer verification on the
owner's machine remains outstanding for every printing stage — not claimed
here.

What moved (thermal.ts 3,586 -> 2,092 lines):

- Seam 4 (8910d4c) — S3 printer detection & platform probing ->
  main/printers/printer-detection.ts (629 lines):
  PRINTER_DETECTION_TIMEOUT_MS (:13, moved with the seam — S3-only use,
  same logic as the chunk constants moving with seam 3),
  PrinterColumnWidth (:15), PrinterInfo (:17), detectConnectedPrinters
  (:56), windowsPowerShellCommandArgs (:332, moved with its section;
  thermal.ts re-exports it at :65 so windows-print.ts keeps importing it
  from './thermal' unchanged), plus the macOS / IPP / Windows / Linux
  platform helpers. thermal.ts re-exports detectConnectedPrinters and
  the two types (:65-66). The moved block is byte-identical to the base
  (verified by diff).
- Seam 5 (693e0c5) — S12 Z-report -> main/printers/document-z-report.ts
  (550 lines): buildZReportBody (:58, carries the thermal.ts-local
  formatAmount V1 closure with it), printZReport (:493), plus the
  pushZReport* layout helpers. thermal.ts re-exports both (:67). The
  moved block is byte-identical to the base (verified by diff).
- Seam 6 (d91d056) — S7 raster document lines + WebUSB rasterization ->
  main/printers/raster-documents.ts (376 lines): receiptDocumentLines
  (:36), rasterizeDocumentLines (:94), rasterizePrintDocumentForWebUsb
  (:193), rasterizeKotDocumentForWebUsb (:268),
  rasterizeReceiptIfEnabled (:327). thermal.ts imports the two private
  helpers back for its S4/S6 callers (:68) and re-exports the three
  public entry points (:69-73). The moved block is byte-identical to the
  base except the two one-word `export` additions on
  rasterizeDocumentLines / rasterizeReceiptIfEnabled (verified by diff).

Battery (Stage 3 battery, assignment 018; serial, `npm run clean` between
suites, proxy unset except `build:frontend`):
- Baseline on 64147ab before any move: 29/30 green plain; test:raster
  rc=1 plain (Missing X server / $DISPLAY — declared environment skip),
  green rc=0 under xvfb-run (30/30 effective). Oracle 12/12
  byte-identical; bills-print-api green; menu-printing 10/10; migration
  registry 371/371; lint rc=0; lint-engine verified; build +
  build:frontend rc=0; i18n:check rc=0.
- After seam 4, after seam 5, after seam 6: same 29/30 plain + raster
  green under xvfb (30/30 effective each time); oracle 12/12, bills-
  print-api green, registry 371/371 at every step. No new red vs
  baseline. Logs: ~/workspace/rest-cafe-docs/stage3-delivery3-2026-10-30/
  (baseline/, seam4/, seam5/, seam6/; raster-xvfb logs alongside).

Boundary decisions (for Ted to verify; no behavior change in any of them):
- New call-time-only import cycles thermal.ts <-> printer-detection.ts,
  thermal.ts <-> document-z-report.ts and thermal.ts <->
  raster-documents.ts, same shape as the thermal.ts <->
  windows-print.ts cycle accepted in decision 20261030-024: each moved
  module imports shared helpers from thermal.ts (isMasBuild,
  sanitizePowerShellStderr; columnsForPaperWidth, resolvePrinterContext,
  getPrinterConfig, hasFinancialPrintWarning,
  makeFinancialPrintRefusalMessage; hasFinancialPrintWarning,
  resolvePrinterContext, normalizeReceiptTemplate, plus
  `ReturnType<typeof prepareReceipt>` as a type-only import, erased at
  compile) and every such use is inside a function body, after all
  modules load. `npm run build` + the full battery (incl. all printer
  suites) are green at every step. No load-time use was introduced; if a
  later seam needs one, that seam stops and is reported.
- windowsPowerShellCommandArgs moved with S3 (it is defined inside S3's
  range) instead of staying in thermal.ts: the alternative would have
  left a hole in the moved block, or made windows-print.ts import from
  printer-detection.ts (a sibling cycle). thermal.ts re-exports it, so
  windows-print.ts is untouched.
- One-word `export` additions (no call-site change): isMasBuild
  (thermal.ts:295, also used by S4); rasterizeDocumentLines /
  rasterizeReceiptIfEnabled (used by S4/S6 in thermal.ts). Export
  surface check: 67 exports at base, 68 now, zero lost — the only
  addition is isMasBuild.
- Import fixes found by `npm run build` (TS2304) before committing each
  seam — the build, not inspection, found them; no behavior was changed
  to satisfy the compiler. Seam 5: columnsForPaperWidth is defined in
  thermal.ts itself (S5), not in profiles.ts as the Part A map's wording
  suggested — document-z-report.ts imports it from thermal.ts; S12 also
  uses printLabel / PrintConceptId (from the generated labels and
  shared/print/concepts). Seam 6: the raster functions also use
  parseBillTemplateSelection, normalizeReceiptTemplate (S8, stays in
  thermal.ts — also called by formatReceipt), renderCompact/Classic
  receipt + bill-line renderers, renderKotDocumentToLines,
  resolvePrinterProfile, makeFinancialPrintRefusalMessage and
  normalizePrintLanguage; all imported from their homes.
- Import cleanups in thermal.ts: the fs / matchSupportedPrinterProfile /
  ipp-client imports left with seam 4; the windows-print value import
  collapsed to a direct re-export (describeWindowsPrintProcessFailure
  stays re-exported for tests); the six shared/print value imports +
  four type imports only S12 used left with seam 5; the
  isThermalTextRepresentable / RasterSemanticLineGroup / PrintDocument
  imports left with seam 6.
- Formatter churn: the pre-commit hook collapsed the shared/print
  import in thermal.ts to one line at the seam 5 commit (-3 lines) and
  expanded the new files' import headers at the seam 5 (+2 lines) and
  seam 6 commits (formatting only, no semantic change). The moved
  blocks themselves are byte-identical as verified above. No other
  normalization.

What is next: Delivery 4 = seams 7-8 (document-plugin-receipt,
receipt-entry) on branch assistant/stage3-delivery4-thermal-slim-3, per
decisions 019/021/024. No owner wait at any gate.
