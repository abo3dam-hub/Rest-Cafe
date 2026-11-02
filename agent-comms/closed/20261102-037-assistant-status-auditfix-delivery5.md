From: assistant
To: ted
Kind: status
Thread: 20261102-037
Subject: Audit-fix Delivery 5 done — print correctness (F-015, F-016, F-017, F-018, F-026, F-027)

Delivery 5 of assignment 037 is done, per decision 042.

Base head: be6c15025996e657f24755f676244971c2060984 (upstream main, Delivery 4 landed)
Branch: assistant/auditfix-d5-print
Head: 20ba0ed01bb685bc9adcfb9a3a21c26af4535f1c
Commits: 7 (announce + one per finding group; F-017 and F-026 share one
commit because they interlock through the same confirmation service)

## What was done, per finding

### F-015 — Unify 80 mm width on the backend profile (48 columns, Font A)
- `shared/print/width.ts`: `columnsForReceiptPaperSize(80)` 42 → 48. The
  512-dot heads keep their explicit `80mm-42` / `cols-42` on both paths.
- `main/printers/profiles.ts`: `generic-escpos-80` `fontAColumns` 42 → 48,
  `defaultPaperWidth` `cols-42` → `cols-48`. Its raster `widthDots` was
  already 576, which implies 48 Font A columns.
- `main/printers/printer-detection.ts`: unmatched-80 mm fallback
  `cols-42` → `cols-48`. `main/routes/printers.ts`: create-printer fallback
  and print-menu override now fall back to `cols-48`.
- `frontend/src/components/settings/PrintersSettingsTab.tsx`: new-printer
  default and `normalizePrinterWidthValue` fallback → `cols-48` (the
  explicit `cols-42` option is kept for 512-dot heads).
- Encoder doc comments updated 42 → 48 cols for 80 mm
  (`receipt-encoder.ts`, `kot-encoder.ts`, `delivery-slip-encoder.ts`,
  `tax-bill-encoder.ts`).
- `tests/print-parity.test.ts`: `FRONTEND_PAPER_BY_COLUMNS`
  `[[32,58],[42,80]]` → `[[32,58],[48,80]]`.
- `tests/receipt-column-oracle.test.ts`: `PROFILE_COLUMNS`
  `generic-escpos-80` 42 → 48; the cross-path test now asserts agreement
  for BOTH paper sizes, not just 58 mm.
- Deliberately NOT changed: `buildBillPrintContext` default `columns ?? 42`
  in `frontend/src/lib/printer/print-document.ts` — all callers pass
  columns explicitly, so the fallback is unreachable from those paths.
- Golden regeneration (commit `f1df79b`, flagged for review): ONLY the two
  frontend 80 mm blocks changed — classic `rule=42 maxFontA=42 max=42` →
  `rule=48 maxFontA=48 max=56`; compact `rule=42 maxFontA=42 max=56` →
  `rule=48 maxFontA=48 max=64`. No backend or 58 mm block changed.

### F-016 — KOT lines wrap instead of truncating
- Backend `main/printers/document-kot.ts`: `kotItemLines` now wraps item
  names, addons, and special instructions (`pushWrapped`, same raster
  passthrough as the receipt path) instead of truncating them. Name wraps
  to `cols - prefix`; addons wrap with the quantity suffix on the last
  line; instructions wrap to `cols - 5` (the true ` >> ` prefix width).
  `rowLineOffset` now advances by the wrapped line counts, and the raster
  groups keep one source line per item part. Note: `truncateShapedLine`
  only truncated under arabicShaping + Arabic script, so long Latin names
  could previously overflow — wrapping fixes both.
- Frontend `frontend/src/lib/printer/kot-encoder.ts`: same wrapping via
  new `wrapKotText`; the unused local `truncate` helper is removed.
  Order-level notes already wrapped — no change there.
- New suite `tests/kot-line-wrap.test.ts` (22 checks, both paths, 32/48
  columns and 58/80 mm): two products sharing a long prefix stay
  distinguishable, full addon name and full instruction tail are kept, no
  rendered line exceeds the column budget, no `…` marker survives, short
  names still render on one line.

### F-017 — A non-representable non-financial line must not vanish with only a toast
- Merchant templates now rasterize: `receiptDocumentLines`
  (`main/printers/raster-documents.ts`) renders merchant selections via
  `renderMerchantReceiptViaDocument` with full capabilities and returns
  their document lines with financial-line groups, so fail-closed still
  holds. `formatReceipt` (`main/printers/receipt-entry.ts`) forces raster
  off for pack templates only now, not merchant.
- Pack templates stay raster-off: they render via `renderPluginReceipt`
  (Buffer only, no lines or financial-line groups), so rasterizing them
  would weaken fail-closed. They rely on the recording half below.
- Recording: new migration v124 `bill_print_warnings` (id, bill_id,
  print_log_id nullable, field, text, message, kind, source, created_at;
  index by bill_id). `main/services/receipt.ts` sanitizes and stores
  warnings (max 50 per confirmation, fields length-capped).
- `POST /bills/:id/print` accepts optional `warnings` and stores them with
  the confirmation; `GET /bills/:id/print-history` returns each print
  row's warnings. The three frontend confirmation call sites pass their
  dispatch warnings (`usePosTableWorkspace.ts`,
  `orders/page.tsx` ×2, `tables/page.tsx`). The orders-page print
  confirmation modal shows warnings recorded on earlier prints of the
  bill, reusing the existing `printWarnings.title` / `moreLines` keys
  (no new strings).
- New suite `tests/bill-print-warnings.test.ts` (17 checks): warnings
  travel with the confirmation and come back in history, a clean
  confirmation records none, a merchant template returns a raster
  document keeping the full Arabic product name with financial-line
  groups, a pack template still returns no document.
- Known gap, out of scope: the frontend WebUSB raster path
  (`rasterizePrintDocumentForWebUsb`) handles only classic/compact;
  merchant templates have no frontend raster rendering (pre-existing).

### F-018 — Pin compact 80 mm content to the paper width in the oracle
- Correction to the audit's label: the compact 80 mm widest line is NOT
  double-width. A probe showed it starts with `ESC M 1` (Font B) — 56
  Font B cells × 9 dots = 504 ≤ 576-dot paper width. After F-015 it is
  64 Font B cells = 576 dots = exactly the paper width. No content fix
  was needed.
- `tests/helpers/receipt-column-measure.ts`: `MeasuredLine` gained `dots`
  (each printable byte adds `sizeWidth * (Font B ? 9 : 12)` dots; raster
  bands are skipped by the walk, not counted). `formatGoldenBlock`
  untouched, so no golden change.
- New oracle test "every line fits the paper width in dots (F-018)":
  every measured line's dots ≤ rule width × 12. Oracle is 13/13 green.

### F-026 — bills.printed_at is set only on confirmed dispatch
- `main/services/receipt.ts` is rewritten as the confirmation recorder:
  `recordPrintConfirmation` (print_logs row + printed_at + warnings),
  `markBillPrintedOnDispatch` (printed_at + warnings, no print_logs row —
  the queue has no user), `recordBillPrintWarnings` /
  `getBillPrintWarnings` / `sanitizePrintWarnings`. The old
  `printReceipt` name is gone; `tests/receipt-printing.test.ts` updated
  to the new name (same assertions).
- The durable print queue (`main/services/print-queue.ts`):
  `executePrintJob` now returns the dispatch warnings, and
  `processDuePrintJobs` marks printed_at only after a receipt retry
  dispatch succeeds, recording the dispatch warnings with source
  `queue`. A failed dispatch leaves printed_at unset.
- `POST /bills/:id/print` is now explicitly a confirmation endpoint
  (documented in the route): the frontend calls it only after dispatch.
  Design decision for review: the print-bill route
  (`main/routes/printers.ts`) does NOT record — the frontend confirmer
  covers frontend-initiated prints, and recording there too would double
  `print_logs` rows. Direct API callers must confirm via
  `POST /bills/:id/print` after dispatching the bytes themselves.
- `POST /bills/:id/markPrinted` is operator attestation (human confirms
  paper output, e.g. after a browser-print dialog) and now requires
  `{ confirmed: true }` in the body — a bare request is a 400. It accepts
  optional warnings (source `operator`).
- New suite `tests/bill-printed-at.test.ts` (16 checks): queue success
  marks printed_at + records the warning (no print_logs row); queue
  failure leaves printed_at unset; markPrinted without `confirmed` → 400
  and unset, with it → 200 and set; POST /print still sets printed_at.
- Limit, recorded: browser-print confirmation is inherently weak —
  `window.print()` reports no paper-output confirmation, so for browser
  prints printed_at means "dialog invoked", not "paper out".

### F-027 — Deterministic WebUSB printer selection, and the selection is named
- New pure module `frontend/src/lib/printer/webusb-selection.ts`
  (generic over the caller's printer/device type, no USB or DOM access):
  `selectWebUsbPrinter` — the configured default WebUSB printer, else
  the first in stable order (name, then id); never null while at least
  one WebUSB printer is configured. `selectUsbDevice` — reconnect
  prefers the selected printer by name, else the first in stable order.
- `frontend/src/hooks/usePrinter.ts`: `refreshHardwarePrinter` uses
  `selectWebUsbPrinter` (the old exactly-one rule is gone) and now
  returns the selected printer; `usePrinterStatusSync` passes its name
  to `printerService.tryReconnect(name)`.
- `frontend/src/lib/printer/PrinterService.ts`: `tryReconnect` takes an
  optional preferred product name and uses `selectUsbDevice` instead of
  an arbitrary `devices[0]`.
- `frontend/src/components/layout/StatusBar.tsx`: `displayPrinter =
  defaultPrinter ?? webusbPrinter` is used for readiness, title, and the
  ready-state name, so the selected WebUSB printer is always named even
  when no printer is marked default.
- Deliberately unchanged: the ambiguous-device refusal in
  `findUniqueConfiguredDevice` — two granted devices sharing a product
  name still refuse with a loud error, because the configured record
  carries no serial and picking one could send bytes to the wrong
  physical printer. That refusal is not the silent empty selection F-027
  fixes. It is pinned by `tests/printer-api.test.ts` (see the correction
  below).
- New suite `tests/webusb-printer-selection.test.ts` (15 checks): default
  wins, stable order without a default, same-name tie-break by id,
  reconnect preference and fallback, order-independence.

## Corrections made during this delivery (both caught by the battery)
- `i18n:check` failed first run (exit 2): the F-027 selection helpers
  returned the wide candidate types instead of the concrete
  `HardwarePrinter` / `USBDevice`, a TypeScript error. Fixed by making
  the helpers generic; amended into the F-027 commit. Re-ran green.
- `test:printer` failed first run (92/94): my first F-027 draft changed
  `findUniqueConfiguredDevice` to pick the first match among identical
  models, which broke the pinned ambiguous-refusal tests. Reverted that
  part (see F-027 "deliberately unchanged"); the refusal is preserved.
  Re-ran green (94/94).

## Battery (2026-11-02, this VM, serial, `npm run clean` between suites)
Logs: `~/workspace/rest-cafe-docs/auditfix-d5-2026-11-02/10-battery-*.log`
(plus `00`-`09` per-suite logs from during the work).
- Standard, all green: `lint` (966 warnings / 0 errors, budget 1000),
  `test:lint-engine`, `i18n:check`, `build`, `build:frontend` (proxy on),
  `test:script-coverage`, `docs:check`, `git diff --check`.
- Printing area, all green: `test:printer` (94/94), `test:printer-api`,
  `test:bills-print-api`, `test:menu-printing`, `test:print-kernel`,
  `test:print-parity`, `test:delivery-slip`, `test:thermal-capabilities`,
  `test:merchant-print-templates`, `test:merchant-template-transfer`,
  `test:print-document`, `test:receipt-column-oracle` (13/13, pass 13 fail
  0), `test:receipt-column-width`, `test:receipt-printing`,
  `test:kot-print-queue`, `test:kot-order-notes`, `test:kot-line-wrap`
  (22/22), `test:bill-print-warnings` (17/17), `test:bill-printed-at`
  (16/16), `test:webusb-printer-selection` (15/15),
  `test:printing-settings`, `test:printer-width-refresh`,
  `test:printer-migrations`, `test:print-labels`,
  `test:issue-133-kds-kot-toggles`, `test:kitchen-addons`,
  `test:print-menu-printer-selection`.
- Money guards, all green: `test:full-house` (0 findings; pinned totals
  unchanged — R1 gross 2,928,000, R2 gross 3,220,800 / net 3,061,300),
  `test:restaurant-day-cycle` (116/116), `test:migration-registry`
  (377/377 checks, 124 migrations v1..v124), `test:upgrade-path`,
  `test:cash-closures` (370/370 — the Z-print §15 case passed on this
  run; the failure seen in the 035 audit did not reproduce here).
- ONE red, pre-existing and environmental, not a code signal:
  `test:raster` — its pure half passes ("Raster encoder and mixed-mode
  contract checks passed"); the Electron half exits before any test code
  runs because this headless Linux VM has no X server (`Missing X server
  or $DISPLAY`, `The platform failed to initialize`). Reproduced
  identically on the pristine base commit be6c150 in a separate worktree
  (log `12-raster-base-commit.log`). End-to-end raster bytes still need
  the Windows raster surface, as before.
- The EPERM write fault did NOT return during this delivery.
- Money math, tax behaviour, and settlement semantics unchanged;
  `refund.ts` untouched. No golden regeneration except the flagged F-015
  80 mm one.

## Disclosures
- Formatter churn: the pre-commit hook reformatted never-formatted files
  inside commit `1e5ecba` (F-015) — `shared/print/width.ts` (116 lines
  vs my 11), `main/printers/profiles.ts` (47 vs 6),
  `tests/print-parity.test.ts` (1036 lines vs my 2). Pure formatting
  (import collapsing, line wrapping); suites pass. The golden commit
  `f1df79b` was clean.
- Published via the GitHub API helper because local git push cannot
  authenticate in this environment (same as Deliveries 1–4).

## Not done / open for Ted
- F-015 golden regeneration scope (commit `f1df79b`) — for your review.
- F-018 audit-label correction (Font B, not double-width) — for the
  record; no content change was needed.
- The print-bill route not recording confirmation (frontend confirmer
  covers it; direct API callers must confirm via POST /bills/:id/print)
  — a design decision, flagged here.
- Browser-print confirmation stays weak by nature (dialog invoked ≠
  paper out) — recorded as a limit under F-026.
- Frontend merchant-template raster rendering (WebUSB path) is a
  pre-existing gap, out of scope — noted under F-017.
- Physical-printer verification on Ali's machine is still outstanding,
  as is the real Windows-login autostart test from Delivery 4. No
  installer for this delivery — the single installer comes after the
  last production delivery.
