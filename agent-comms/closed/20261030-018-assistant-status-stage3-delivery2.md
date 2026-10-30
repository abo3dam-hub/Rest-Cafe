From: assistant
To: ted
Kind: status
Thread: 20261030-018
Subject: Stage 3 Delivery 2 done — thermal.ts slim 1, seams 1-3 (escpos-preview, windows-print, print-transport)

Delivery 2 is complete on branch assistant/stage3-delivery2-thermal-slim-1,
base upstream main fa3958f7f59982d9e3b4c16f9b67aa25ad856c82. One commit per
seam, pure moves only, thermal.ts keeps re-exports so existing call sites
do not change. No golden regenerated. Physical-printer verification on the
owner's machine remains outstanding for every printing stage — not claimed
here.

What moved (thermal.ts 4,227 -> 3,586 lines):

- Seam 1 (dce9fd7) — S13 ESC/POS preview + code pages ->
  main/printers/escpos-preview.ts (97 lines): escPosToText (:6),
  THERMAL_CODE_PAGE_HIGH_HALVES (:73), THERMAL_CODE_PAGE_BY_ID (:83),
  decodeThermalPreviewBytes (:90). thermal.ts re-exports escPosToText
  (:56); the now-unused ThermalCodePage import was removed from thermal.ts.
  The moved block is byte-identical to the base (verified by diff).
- Seam 2 (acd8511) — S15 Windows spooler + Windows print failure
  reporting -> main/printers/windows-print.ts (342 lines):
  WINSPOOL_HELPER_SOURCE (:19), WINSPOOL_HELPER_SCRIPT (:154),
  execFileAsync (:188), describeWindowsPrintProcessFailure (:229),
  capWindowsPrintDetail (:260), printViaUSBWindows (:288),
  getPrinterStatus (:339), plus parseWindowsPrintOutput,
  describeWindowsRawPrintFailure and the detail-length constants.
  thermal.ts imports the moved symbols (:57-62) and re-exports
  describeWindowsPrintProcessFailure + getPrinterStatus (:63). The moved block
  is byte-identical to the base except two one-word `export` additions
  (execFileAsync, printViaUSBWindows — see boundary decisions).
- Seam 3 (5218e73) — S14 network / USB transport ->
  main/printers/print-transport.ts (240 lines): NETWORK_PRINT_CHUNK_SIZE
  / NETWORK_PRINT_CHUNK_DELAY_MS (:11-12, moved with this seam from
  S13's range as the Part A map noted), printViaNetwork (:14),
  printViaUSB (:108), printViaLocalIpp (:128), describeCupsQueueProblem
  (:169, stays private), printViaCups (:203). thermal.ts imports the
  four transport functions (:64-71) and re-exports the two chunk
  constants + printViaNetwork + printViaUSB (:72). The moved block is
  byte-identical to the base except two one-word `export` additions
  (printViaLocalIpp, printViaCups — see boundary decisions).

Battery (Stage 3 battery, assignment 018; serial, `npm run clean` between
suites, proxy unset except `build:frontend`):
- Baseline on fa3958f before any move: 29/30 green plain; test:raster
  rc=1 plain (Missing X server / $DISPLAY — declared environment skip),
  green rc=0 under xvfb-run (30/30 effective). Oracle 12/12
  byte-identical; bills-print-api green; menu-printing 10/10; migration
  registry 371/371; lint rc=0; lint-engine verified; build +
  build:frontend rc=0; i18n:check rc=0.
- After seam 1, after seam 2, after seam 3: same 29/30 plain + raster
  green under xvfb (30/30 effective each time); oracle 12/12, bills-
  print-api green, registry 371/371 at every step. No new red vs
  baseline. Logs: ~/workspace/rest-cafe-docs/stage3-delivery2-2026-10-30/
  (baseline/, seam1/, seam2/, seam3/; raster-xvfb logs alongside).

Boundary decisions (for Ted to verify; no behavior change in any of them):
- Runtime import cycle thermal.ts <-> windows-print.ts: windows-print.ts
  imports classifyPrintFailure, extractPlatformErrorCode,
  getPrinterConfig, sanitizePowerShellStderr, windowsPowerShellCommandArgs
  and type DispatchResult from thermal.ts; thermal.ts imports
  describeWindowsPrintProcessFailure, execFileAsync, getPrinterStatus,
  capWindowsPrintDetail (and printViaUSBWindows until seam 3) from
  windows-print.ts. Every cross-module use is inside a function body
  (call time, after all modules load), so it resolves under the repo's
  CommonJS build; `npm run build` + the full battery (incl. all printer
  suites) are green at every step. The Part A map already prescribed
  "S15 imports classifyPrintFailure from thermal.ts"; the cycle is the
  consequence of thermal.ts also needing describeWindowsPrintProcessFailure
  (S3, thermal.ts:718) back.
- Three private thermal.ts helpers gained one-word `export` so
  windows-print.ts can import them (no call-site change):
  extractPlatformErrorCode (thermal.ts:311), windowsPowerShellCommandArgs
  (:639), getPrinterConfig (:1540). Two moved helpers gained `export` in
  windows-print.ts: execFileAsync (:188, shared by S3/S4 and the
  transports), capWindowsPrintDetail (:260, used by S3's
  mapWindowsPrinterStatus) and printViaUSBWindows (:288, used by
  printViaUSB). printViaLocalIpp / printViaCups gained `export` in
  print-transport.ts for thermal.ts's internal dispatch use. The last
  three were caught by `npm run build` (TS2304) before committing each
  seam — the build, not inspection, found them; no behavior was changed
  to satisfy the compiler.
- print-transport.ts imports ippGetPrinterAttributes / ippPrintRaw
  directly from ./ipp-client (leaf module, no cycle); thermal.ts keeps
  its own ipp-client import for S3.
- net / os / path imports left thermal.ts with seam 3 (used only by the
  transports now); fs stays (fs.readFileSync / readdirSync in S3).
- Formatter churn: the pre-commit hook collapsed the print-transport
  re-export block in thermal.ts from 6 lines to 1 at the seam 3 commit
  (formatting only, no semantic change). No other normalization.

What is next: Delivery 3 = seams 4-6 (printer-detection, document-z-report,
raster-documents) on branch assistant/stage3-delivery3-thermal-slim-2, then
Delivery 4 = seams 7-8, per decisions 019/021/023. No owner wait at any gate.
