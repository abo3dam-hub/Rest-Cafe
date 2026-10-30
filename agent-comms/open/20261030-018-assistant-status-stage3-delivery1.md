From: assistant
To: ted
Kind: status
Thread: 20261030-018
Subject: Stage 3 Delivery 1 — Part A classification report (STOP: pre-existing menu-printing red, Part B not started)

## Verdict up front

Part A (classify) is complete and reported below. Part B (formatAmount
unification) is NOT STARTED: the baseline battery has one real red that is
not in the documented environment family, and the assignment's stop rule
says stop-and-report before any move. No production code was changed in
this delivery — the branch carries only the announce file and this report.
Ted's decision is needed on the red (see "Stop: the menu-printing red")
before Part B or any Stage C seam can start.

Base head: upstream main 542ec9937207b8aed5db1dc5bc46065bdef104a6
Branch: assistant/stage3-delivery1-classify-format
PR: one PR per delivery (this report is the Delivery 1 hand-back).

Physical-printer verification on the owner's machine remains outstanding
for every printing stage — nothing in this report claims it.

## 1. Stage 3 battery baseline (clean upstream main, 542ec99)

Run 2026-10-30 ~11:45–11:50 Asia/Damascus, serially, `npm run clean`
between suites, proxy unset except `build:frontend` (proxy on). Per-suite
logs are kept with the delivery record. Result: **28/30 green**.

| Suite | Result |
|---|---|
| lint | GREEN — backend 964 warnings / budget 1000, 0 errors; frontend 0/0 |
| test:lint-engine | GREEN |
| i18n:check | GREEN |
| build | GREEN |
| build:frontend | GREEN (proxy on) |
| test:receipt-column-oracle | GREEN — 12/12, golden byte-identical |
| test:bills-print-api | GREEN — 34/34 |
| test:printer | GREEN |
| test:printing-settings | GREEN |
| test:printer-api | GREEN |
| test:print-menu-printer-selection | GREEN — declared skip notice: raster-dependent assertions skipped off-Windows ("Raster surface readiness timed out") |
| test:printer-ipc | GREEN |
| test:receipt-printing | GREEN |
| test:receipt-settings-hydration | GREEN |
| test:print-parity | GREEN |
| test:merchant-print-templates | GREEN |
| test:print-document | GREEN |
| test:print-kernel | GREEN |
| test:thermal-capabilities | GREEN |
| test:raster | RED in plain run — ENVIRONMENTAL (see below) |
| test:receipt-column-width | GREEN |
| test:printer-width-refresh | GREEN |
| test:printer-migrations | GREEN |
| test:issue-printing-and-kds-resilience | GREEN |
| test:issue-266-currency-symbol-print | GREEN |
| test:menu-printing | RED — REAL, PRE-EXISTING AT BASE (see "Stop") |
| test:print-labels | GREEN |
| test:migration-registry | GREEN — 371/371 (122 migrations, v1..v122) |
| test:backup | GREEN |
| test:e2e-syria-default | GREEN |

### test:raster — environmental only

The plain run fails in the Electron half: "Missing X server or $DISPLAY",
"The platform failed to initialize." The Node half ("Raster encoder and
mixed-mode contract checks passed") passes. Re-run under `xvfb-run -a`
PASSES (rc 0; "Chromium raster surface rendered styled RTL output", "Warm
Chromium raster singleton lifecycle passed"). This is the documented raster
off-Windows environment family (printing guardrails rule 5): reported as an
environment condition, never as coverage.

## Stop: the menu-printing red (pre-existing at base, not caused by this delivery)

- `test:menu-printing`: 9/10 pass. Failing test: "menu route prints with
  Syria defaults while unconfigured, validates filters, and honors the
  default WebUSB printer" (tests/menu-printing.test.ts:320).
  `TypeError: Cannot set property getDatabase of #<Object> which has only
  a getter` at tests/menu-printing.test.ts:458. Reproduced in isolation on
  the clean tree (same failure, same line).
- Cause: the test does `const database = require('../main/db')` (line 391),
  saves `database.getDatabase` (line 395), then assigns a stub
  `database.getDatabase = () => ({ prepare: ... })` (line 458) and restores
  with `Object.assign` (line 631). Since Stage 2 Delivery 2 (upstream
  76a4a19), `main/db.ts` is a pure re-export barrel: `export { getDatabase }
  from './db/core'` compiles to a getter-only property on the exports
  object, so assignment throws in strict mode. Before Stage 2, `main/db.ts`
  defined `getDatabase` as a plain function property and the assignment
  worked.
- The Stage 2 baseline (32 suites) did not include test:menu-printing, so
  this was never run there — uncovered by the Stage 3 battery, not a
  regression against Stage 2's claimed green. My branch adds only
  agent-comms files; the red reproduces on the clean tree, so it is
  pre-existing at base 542ec99.
- Fixing it would mean changing either the test's stubbing technique or the
  barrel's export shape — both outside this stage's scope (Part B is
  formatAmount only; test changes are allowed only as new files in a
  separate first commit). I did not touch it. Question for Ted: how should
  this be handled — a fix to the test's stubbing, a change to the barrel,
  or a separate decision? Until it is green (or Ted rules otherwise),
  Delivery 1 stays stopped at Part A and no Part B move is made.

## 2. Section map of main/printers/thermal.ts (4,227 lines, 16 sections)

Method: read-only inspection (grep/sed over the base). Graphify data was
NOT available — no `graphify-out/` exists anywhere under the workspace —
so all caller claims below rest on direct grep evidence, not on the code
graph. Line numbers are from base 542ec99. Only 4 production files import
from thermal.ts at all: `main/index.ts` (`initPrinter`), `main/ipc.ts`
(the two `rasterize*ForWebUsb` functions), `main/routes/cash-closures.ts`
(`printZReport`), `main/routes/printers.ts` (transport, entry points,
detection, preparation, `escPosToText`, `printMenuDocument`). Nothing in
`frontend/src/` or `shared/` imports from thermal.ts. 26 test files import
from it.

- S0 Imports, 1–124. No exports. Already delegates most document rendering
  to the `document-*` family (classic, compact, kot, delivery-slip, menu,
  merchant).
- S1 Re-export block (formatting-helpers), 125–147. Re-exports 20 symbols
  defined in `main/printers/formatting-helpers.ts` (`PrintWarning`,
  `RasterLineUnit`, `itemNameWidth`, `itemAmountWidth`, `itemRows`,
  `addonRows`, `financialRows`, `formatCurrency`, `rightAlign`,
  `truncate`, `truncateShapedLine`, `normalizePrintLanguage`, `wrapText`,
  `pushWrapped`, `pushCenteredWrapped`, `appendPoweredByFooter`,
  `normalizeThermalText`, `resolveCurrencyPrefix`,
  `appendCashDrawerPulse`, `buildEscPos`). Key finding: almost no
  production code reaches these helpers through thermal.ts — the
  `document-*` modules import them directly from `./formatting-helpers`;
  the thermal.ts re-export is exercised mainly by
  `tests/helpers/legacy-thermal-oracle.ts` and a few tests.
- S2 Print warnings, result types, failure classification, 148–310.
  `hasFinancialPrintWarning` (148), `makeFinancialPrintRefusalMessage`
  (152), `PrintResult` (157), `DispatchResult` (172), `PrintFailureClass`
  (183), `sanitizePowerShellStderr` (205), `classifyPrintFailure` (247),
  `extractPlatformErrorCode` (300, private), `isMasBuild` (307),
  `PRINTER_DETECTION_TIMEOUT_MS` (309, private). Production use of
  `classifyPrintFailure` is heavy inside thermal.ts (the `*Detailed`
  wrappers and the Windows spooler path, e.g. :1326, :4213); the result
  types have no external callers.
- S3 Printer detection & platform probing, 311–926 (616 lines).
  `detectConnectedPrinters` (352; production caller
  `main/routes/printers.ts:240`), `PrinterInfo` (313), `PrinterColumnWidth`
  (311, no external callers), plus private PowerShell/CUPS/sysfs helpers.
  Cross-section dependency: `mapWindowsPrinterStatus` calls
  `describeWindowsPrintProcessFailure` (thermal.ts:707), which lives in
  S15 — S15 must move before S3.
- S4 Print entry points, 927–1455 (529 lines). `initPrinter` (927;
  `main/index.ts:1184`), `printReceipt` (941; tests only, called by
  `printReceiptDetailed` at :1381), `printKOT` (1066; no external callers,
  called by `printKOTDetailed` at :1421), `printDeliverySlip` (1188; no
  external callers, called by `printDeliverySlipDetailed` at :1317),
  `printDeliverySlipDetailed` (1312; `main/routes/printers.ts:1461`),
  `printReceiptDetailed` (1376; `main/routes/printers.ts:1118`),
  `printKOTDetailed` (1418; `main/routes/printers.ts:1284–1310`).
- S5 Columns / printer context / config, 1456–1540 (85 lines).
  `columnsForPaperWidth` (1471; no external callers via thermal),
  `dotsForPaperWidth` / `capabilitiesForPrinter` (1475, re-exported from
  `./profiles.ts`; `capabilitiesForPrinter` used by
  `main/routes/printers.ts:49,153,490`), `PrinterContext` (1477, no
  external callers), `resolvePrinterContext` (1484; tests only),
  `getPrinterConfig` (1529, private).
- S6 Menu document + receipt preparation, 1541–1651 (111 lines).
  `printMenuDocument` (1541; `main/routes/printers.ts:843`, delegates to
  `renderMenuViaDocument` at :1553), `prepareReceipt` (1606;
  `main/routes/printers.ts:1094`).
- S7 Raster document lines + WebUSB rasterization, 1652–2000 (349 lines).
  `receiptDocumentLines` (1659; tests only),
  `rasterizePrintDocumentForWebUsb` (1816; `main/ipc.ts:788`),
  `rasterizeKotDocumentForWebUsb` (1891; `main/ipc.ts:828`).
- S8 Receipt formatting entry + plugin template dispatch, 2001–2119
  (119 lines). `formatReceipt` (2001; tests only, 91 matches outside
  thermal.ts; dispatches to the merchant template renderer at :2056 and to
  `formatClassicReceipt`/`formatCompactReceipt` at :2076/:2091),
  `normalizeReceiptTemplate` (2112; no external callers).
- S9 Plugin ESC/POS line-template renderer, 2120–2655 (536 lines). No
  exported symbols; `renderPluginReceipt` (2120) + private helpers.
  Reachable only through `formatReceipt` (S8) and the template pipeline.
- S10 Compact/classic receipt wrappers + plugin column helpers + labels,
  2656–2977 (322 lines). `formatCompactReceipt` (2656) and
  `formatClassicReceipt` (2685; both no external callers, internal only at
  :2091/:2076, delegating to `document-compact`/`document-classic`),
  private `plugin*` column helpers (2713–2954), `resolvePaymentMethodLabel`
  (2962; internal only), `formatTableLabel` (2969; tests only via thermal).
- S11 KOT formatting + test page, 2978–3082 (105 lines). `formatKOT`
  (2978; tests only, 44 matches; delegates to `renderKotViaDocument` at
  :2993), `buildTestPage` (3007; `main/routes/printers.ts:494,614`).
- S12 Z-report, 3083–3577 (495 lines). `buildZReportBody` (3083; tests
  only), `printZReport` (3518; `main/routes/cash-closures.ts:1382,1385`),
  private `pushZReport*` layout helpers (3388–3517). Carries the
  thermal.ts-local `formatAmount` (V1) at line 3117.
- S13 ESC/POS-to-text preview + code pages, 3578–3673 (96 lines).
  `escPosToText` (3578; `main/routes/printers.ts:1110`, plus 14 test files
  — the most widely used export in the file), code-page tables (3645,
  3655), `NETWORK_PRINT_CHUNK_SIZE`/`NETWORK_PRINT_CHUNK_DELAY_MS`
  (3671–3672; tests only).
- S14 Network / USB transport, 3674–3903 (230 lines). `printViaNetwork`
  (3674; `main/routes/printers.ts:507,562,626`), `printViaUSB` (3768;
  `main/routes/printers.ts:515,570,634`).
- S15 Windows spooler + Windows print failure reporting, 3904–4227
  (324 lines). `WINSPOOL_HELPER_SOURCE` (3904, C# source string),
  `describeWindowsPrintProcessFailure` (4114; tests only externally, but
  called internally from S3 at :707 and from `describeWindowsRawPrintFailure`
  at :4165), `getPrinterStatus` (4224; no external callers and no internal
  use — effectively a dead export; moves as-is, deleting it is out of scope
  for a pure move).

Externally dead exports (no caller outside thermal.ts at all): `PrintResult`,
`DispatchResult`, `PrintFailureClass`, `PrinterColumnWidth`,
`PrinterContext`, `RasterLineUnit`, `getPrinterStatus`,
`normalizeReceiptTemplate`, `formatCompactReceipt`, `formatClassicReceipt`,
`printKOT`, `printDeliverySlip`, `columnsForPaperWidth` (via thermal).
`printReceipt`/`printKOT`/`printDeliverySlip` survive only as the internal
callees of their `*Detailed` wrappers. These stay as-is under pure-move
rules; whether to delete them is a Ted decision, not a seam.

## 3. The five formatAmount variants — inventoried from evidence

A repo-wide grep finds exactly five definitions named `formatAmount`
(excluding `node_modules`, `dist/`, `frontend/.next`). None is exported —
all five are module-local, so each variant's callers are all inside its own
file. Two similarly-named but distinct helpers are NOT variants:
`formatAmountForCsv` (`main/countries.ts:978`, CSV cells, no currency
fraction-digit rounding) and `formatAmountForDisplay`
(`frontend/src/lib/currency-input.ts:61`, input-side display string).

| Variant | File:line | Input | Fraction digits | Cents? | Toman? | Delegates to |
|---|---|---|---|---|---|---|
| V1 | thermal.ts:3117 | cents (int) | currency-derived (`getCurrencyFractionDigits`, thermal.ts:3110) | yes, ÷ 10^digits | no | `formatCurrency` (formatting-helpers.ts:255) |
| V2 | receipt-encoder.ts:1804 | major units | parameter (default 2; callers pass currency-derived, receipt-encoder.ts:534) | no | no | none (`toLocaleString` + prefix) |
| V3 | tax-bill-encoder.ts:719 | major units | currency-derived inside (tax-bill-encoder.ts:728) | no | no | none (`toLocaleString` + prefix) |
| V4 | web-print.ts:601 | major units | currency-derived (web-print.ts:604) | no | yes (web-print.ts:607–609; plus via `formatMoney`) | `formatCurrencyForTenant` → `formatMoney` (countries.ts:592, 472) |
| V5 | document-delivery-slip.ts:168 | major units | none of its own | no | via delegate | `formatMoney` (countries.ts:472) |

- V1 (thermal.ts:3117): local to `buildZReportBody` (thermal.ts:3083).
  Input is integer minor units; `centsToAmount = (cents) =>
  (Number(cents) || 0) / 10 ** fractionDigits` (thermal.ts:3116); delegates
  to `formatCurrency` with the resolved currency-symbol prefix, snapshot
  locale, `trimDecimals = false`, derived fraction digits. 11 call sites,
  all inside `buildZReportBody` (:3228, :3235, :3241, :3247, :3266, :3282,
  :3312, :3320, :3322, :3325, :3328), every argument a `.cents` field.
  Only cents-converting variant; only one in `main/`. Moves with the
  Z-report section in Stage C — it must move with its only use site, not
  be unified here.
- V2 (receipt-encoder.ts:1804): `function formatAmount(value, currency,
  locale, trimDecimals = false, fractionDigits = 2)`. Fraction digits come
  from the parameter; every production caller passes the currency-derived
  value (`buildClassicReceiptBytes` computes it at receipt-encoder.ts:534).
  No cents conversion; non-finite → 0 (:1810–1811); forces a `-u-nu-latn`
  locale via `getSafeLatnLocale` (:331); NBSP/narrow NBSP → plain space.
  Returns `` `${currency}${formattedNum}` `` (prefix-style, caller-resolved
  symbol). 34 call sites, all in receipt-encoder.ts (builders
  `buildClassicReceiptBytes` :522, `buildCompactReceiptBytes` :1047,
  `buildDetailedReceiptBytes` :1469). Reached from
  `frontend/src/hooks/usePrinter.ts:423,425` and the parity/oracle tests.
- V3 (tax-bill-encoder.ts:719): `function formatAmount(value, currency,
  locale, trimDecimals = false, rawEscPos: boolean = true)`. Fraction digits
  are derived inside from the currency (:728). The 5th parameter is
  `rawEscPos`, NOT fraction digits (NBSP replacement only when true, :739).
  Uses the locale as passed — unlike V2 it does NOT force `-u-nu-latn`.
  10 call sites, all inside `buildTaxBillBytes` (:463, :492, :533, :544,
  :551, :558, :565, :572, :584, :604). Reached from `usePrinter.ts:609`.
- V4 (web-print.ts:601): `function formatAmount(value, tenant,
  trimDecimals = false)`. Currency-derived fraction digits (:604). The only
  variant with its own Toman branch (:607–609: IRR / country IR with
  `currency_display` toman/toman_short). Otherwise delegates entirely to
  `formatCurrencyForTenant` (countries.ts:592 → `formatMoney`,
  countries.ts:472), so the Toman divide-by-10 happens inside `formatMoney`.
  1 direct call site: the alias `fmtAmount` (:338) inside `generateBillHtml`
  (:237), used at 13 sites (:402–:472). Reached from `usePrinter.ts:289,
  292, 572, 574` and the print-test page.
- V5 (document-delivery-slip.ts:168): pure delegate with no formatting logic
  of its own — `formatMoney(amount, String(options.currency ?? ''),
  options.locale ?? 'en-US', { currencyDisplay, digits })`. All semantics
  (including Toman divide-by-10 and the IRR 0-fraction-digits rule) come
  from `formatMoney`. 2 call sites (:176, :177). Feeds
  `renderDeliverySlipViaDocument`, called from thermal.ts:1247.

Adjacent helpers (not variants): `formatMoney` (countries.ts:472 — the
central money formatter; Toman ÷10 at :483–490; IRR → 0 fraction digits);
`formatCurrencyForTenant` (countries.ts:592, thin tenant-locale delegate to
`formatMoney`); `formatCurrency` (formatting-helpers.ts:255 — prefix-style,
explicit prefix, forces Latin-digit locale; note countries.ts:458 defines a
different, unrelated `formatCurrency`); `getCurrencyFractionDigits`
(countries.ts:528 — single source of fraction-digit truth; empty → 2,
COP → 0, IRR → 2, else Intl resolved digits).

Consequences for Part B (recorded, not decided here): V2 and V3 differ in
two proven ways — fraction-digit source (parameter vs derived) and locale
handling (V2 forces `-u-nu-latn`, V3 uses the locale as passed) — plus V3's
5th parameter is `rawEscPos`, not fraction digits, so the signatures are
not interchangeable. V1 is the only cents-converting variant and the only
one in `main/`. V4 is the only variant with its own Toman branch; V5 is a
pure delegate. Unification, if any, must be proven per variant under the
oracle; a variant that genuinely differs STAYS as-is, documented — that is
a successful outcome for that variant, not a failure. No golden was
regenerated (forbidden in this stage).

## 4. Ordered Stage C seam proposal (for Ted's approval on landing)

Rules applied: pure moves only; no logic edits, renamed exports, signature
changes, or call-site changes outside `main/printers/` + thermal.ts's own
re-exports; thermal.ts keeps re-exports/composition; one commit per seam;
every commit compiles and passes on its own; oracle byte-identical at every
step; no golden regeneration. Restructuring scope is `main/printers/` only.
Ordering: smallest and most dependency-free first; a seam moves before any
section that calls into it (S15 before S3 because S3 calls
`describeWindowsPrintProcessFailure` at thermal.ts:707; S8+S10 together
because `formatReceipt` calls into S10 at :2076/:2091; S15 imports
`classifyPrintFailure` from S2, which stays in the core).

| # | Source section (lines) | Target module under main/printers/ | Est. lines | Why it is cohesive | Protecting suites |
|---|---|---|---|---|---|
| 1 | S13 — ESC/POS preview + code pages (3578–3673) | `escpos-preview.ts` (new sibling) | ~96 | Pure byte→text decoding, no I/O, no intra-file deps; single most-used export (`escPosToText`) with the widest test pinning. | `test:receipt-column-oracle`, `test:print-parity`, `test:printer`, `test:print-labels`, `test:thermal-capabilities` |
| 2 | S15 — Windows spooler + failure reporting (3904–4227) | `windows-print.ts` (new sibling, same pattern as `ipp-client.ts`) | ~324 | One platform's transport + error taxonomy (C# spooler source/scripts, output parsing, `describe*Failure` family). `getPrinterStatus` (4224) moves as-is despite being dead. | `test:thermal-capabilities`, `test:printer`, `test:issue-printing-and-kds-resilience` |
| 3 | S14 — Network / USB transport (3674–3903) | `print-transport.ts` (new sibling) | ~230 | The two raw transports plus the chunk-size/delay constants (which live in S13's range at 3671–3672 and move with this seam). Single production caller (`main/routes/printers.ts:507,515,562,570,626,634`). | `test:thermal-capabilities`, `test:printer`, `test:issue-printing-and-kds-resilience`, `test:receipt-column-oracle` |
| 4 | S3 — Printer detection & platform probing (311–926) | `printer-detection.ts` (new sibling) | ~616 | One job: enumerate connected printers. Single exported entry (`detectConnectedPrinters`) plus the `PrinterInfo` type; all platform branches are private helpers of that entry. Only production caller `main/routes/printers.ts:240`. | `test:printer`, `test:printer-api`, `test:printing-settings`, `test:printer-width-refresh`, `test:printer-migrations` |
| 5 | S12 — Z-report (3083–3577) | `document-z-report.ts` (extends the `document-*` pattern) | ~495 | One document type end-to-end: `buildZReportBody` + `pushZReport*` layout helpers + `printZReport`. Carries V1 with it. Single production caller (`main/routes/cash-closures.ts:1382,1385`). | `test:cash-closures`, `test:receipt-column-oracle`, `test:bills-print-api`, `test:printer` |
| 6 | S7 — Raster document lines + WebUSB rasterization (1652–2000) | `raster-documents.ts` (new sibling) | ~349 | One job: `PrintDocument` → raster lines / WebUSB payloads. Both rasterizers called only from `main/ipc.ts:788,828`. | `test:raster`, `test:print-document`, `test:receipt-column-oracle`, `test:printer` |
| 7 | S9 — Plugin ESC/POS line-template renderer (2120–2655) | `document-plugin-receipt.ts` (extends the `document-*` pattern) | ~536 | One pipeline: merchant-installed bill templates → ESC/POS lines. No exported symbols — verified entirely through the template suites and the oracle. | `test:merchant-print-templates`, `test:merchant-template-transfer`, `test:print-parity`, `test:receipt-column-oracle`, `test:printer` |
| 8 | S8+S10 — Receipt entry dispatch + compact/classic wrappers + plugin column helpers (2001–2119, 2656–2977) | `receipt-entry.ts` (new sibling; the `document-*` modules it delegates to already exist) | ~441 | One job: the receipt formatting entry points. `formatReceipt` dispatches to S9 and to `formatClassicReceipt`/`formatCompactReceipt`; the plugin column helpers exist only to serve that dispatch. S8 and S10 must move together. | `test:print-parity`, `test:receipt-column-oracle`, `test:printer`, `test:merchant-print-templates`, `test:receipt-printing`, `test:charges-engine` |

Total moved ≈ 3,087 lines, leaving a ~1,140-line core: S0 imports, S1
re-export block, S2 warnings/types/failure classification, S4 print entry
points, S5 columns/context/config, S6 menu document + receipt preparation,
S11 KOT formatting + test page — the ESC/POS builder + orchestration core
the assignment anticipates.

Explicitly NOT proposed as seams (needs a Ted decision, not a pure move):
deleting the S1 re-export block (production already imports the helpers
directly, but `tests/helpers/legacy-thermal-oracle.ts` uses the thermal
path); deleting any externally-dead export; unifying any `formatAmount`
variant (Part B evidence above).

Delivery grouping (two seams per delivery, per the assignment):
Delivery 2 = seams 1–2; Delivery 3 = seams 3–4; seams 5–8 on a refreshed
assignment, in the order above. Every seam re-runs the full Stage 3
battery with the oracle byte-identical.

Two corrections to the working notes, verified against package.json: the
suite covering `tests/charges-engine-api.test.ts` is `test:charges-engine`
(not `test:charges-engine-api`); `tests/network-print-chunking.test.ts`
runs inside `test:thermal-capabilities` (there is no separate
`test:network-print-chunking` script). The seam table above uses the
correct script names.

## What is next

1. Ted's decision on the menu-printing red (fix the test's stubbing,
   change the barrel, or another route) — Delivery 1's Part B and any
   Stage C seam wait on a green baseline.
2. On landing, Ted reviews this seam proposal and issues the Stage C
   approval decision in this thread; Delivery 2 unlocks in the same landing
   series (seams 1–2: `escpos-preview.ts`, `windows-print.ts`).
3. Physical-printer verification on the owner's machine remains outstanding
   for every printing stage — not claimed here.
