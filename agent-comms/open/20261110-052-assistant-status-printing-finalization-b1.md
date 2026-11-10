From: assistant
To: ted
Kind: status
Thread: 20261110-052
Subject: Printing finalization Phase B, delivery B1 complete — PF-01 generic raster validated opt-in (thread 20261110-050)

Delivery B1 is complete and ready for review, per Ted's decision
20261110-051 (thread 20261110-050). Base head:
7658e76b937a9b8dbc19ee8724404b22bf9ba4ca (upstream main, Phase A landed).
Branch: assistant/printing-finalization-b1 (fork tedfoagen-stack).
Pull request: to be opened after this status file is published; the PR
carries 10 commits (announce + 9 work commits) and 18 files (17 B1 files
+ this status file).

## What changed

PF-01, owner decision = report §3.5 option 2: generic raster is a
validated opt-in, never a default.

- Generic profiles revert to the conservative baseline raster
  (main/printers/profiles.ts:87-133): both generic-escpos-80 and
  generic-escpos-58 now declare enabled: false, widthDots: 0,
  maxBandHeight: 0, modes: []. Branded profiles
  (xprinter-xp-v320m-v330m, epson-tm-series) keep their declared raster
  values unchanged.
- Per-printer validation, migration v128 `printer_raster_validation`
  (main/db/migrations.ts:3712-3736): columns `raster_validated`,
  `raster_validated_profile_id`, `raster_validated_paper_width`,
  `raster_validated_printer_name` on `printers`. Validation is scoped to
  the exact printer (name, profile id, effective paper width) at
  confirmation time, and the scope is matched at read time
  (`isRasterValidatedForPrinter`, profiles.ts:215-232): any rename,
  profile change, or paper-width change resets validation with no write
  path having to remember. Fresh installs are covered because the
  ideal-schema build runs the full migration pipeline.
- Validated effective capability (`validatedGenericRaster`,
  profiles.ts:198-210): a validated generic printer gains exactly the
  raster its profile declared before B1 — enabled, 576 dots for 80 mm /
  384 for 58 mm, maxBandHeight 200, modes ['mixed', 'whole-receipt'] —
  applied in `capabilitiesForPrinter` before the existing paper-width
  capping, so validated-path bytes are identical to the old generic
  raster output (proven by test, see below).
- `resolvePrinterContext` (main/printers/thermal.ts:834-847) passes the
  validation into `capabilitiesForPrinter`, covering backend receipt /
  KOT / menu paths. `printerShape` (main/routes/printers.ts:140-150)
  reports the effective capabilities plus `raster_validated`, so the
  frontend WebUSB path follows automatically. The PUT route stays
  whitelist-only, so the flag cannot be set via PUT.
- Raster probe page (`buildRasterProbePage`, thermal.ts:1124-1185; the
  shared `testPageLines` extracted at thermal.ts:1033-1075, output
  byte-identical to the old `buildTestPage`): the standard test page,
  then Arabic financial-style sample lines (المجموع الفرعي 900، رسم
  الإنفاق الاستهلاكي 50، المجموع 1,000 — the total bold) rendered as
  GS v 0 raster, then the diagnostic bands, then feed+cut. It throws
  (fail-closed) when raster caps are absent or rendering fails.
  `rasterProbeCapabilities` (profiles.ts:234-252) forces the validated
  raster for generics for the probe only.
- Routes (main/routes/printers.ts): `POST /api/printers/:id/test` with
  `{ rasterProbe: true }` serves the probe page on the existing route
  surface (thermal.ts:476-500; 502 on render failure); non-probe test
  print is unchanged. New `POST /api/printers/:id/raster-validate`
  (printers.ts:534-566, `printers.manage`): requires
  `{ confirmed: true }` (else 400), 404 for an unknown printer, 409
  `raster_validation_not_applicable` for non-generic profiles; stores
  the flag + scope and returns `printerShape`. Probe-before-confirm
  ordering is enforced by the UI flow: the confirm prompt appears only
  after a successful probe dispatch, and the endpoint records the
  owner's explicit confirmation.
- WebUSB rasterize IPC (main/printers/raster-documents.ts:227-240 and
  304-318; main/ipc.ts): both rasterize handlers accept an optional
  `printerId`, load the stored row (unknown/missing id resolves to
  undefined, i.e. fail-closed), and resolve effective capabilities with
  its validation. `frontend/src/hooks/usePrinter.ts` passes
  `printerId: webusbPrinter.id` in both rasterize calls. The existing
  `rasterWebUsbPathEnabled` validated-profile gate now reads the same
  persisted flag through the effective capabilities — one vocabulary,
  not two.
- Settings UI (frontend/src/components/settings/PrintersSettingsTab.tsx:
  51, 188, 377-399, 563-672): generic + unvalidated printers get a
  raster-probe button; on success an inline amber panel asks whether
  the Arabic total lines printed correctly and completely, with
  confirm / "No, they did not print correctly" buttons; confirming
  posts `/raster-validate`, toasts, and refreshes printers + hardware
  printer. Validated printers show a green "Raster validated" badge.
  New i18n keys in `frontend/src/lib/i18n/messages/ar.json` and
  `en.json` only (ar.json:2592-2600, en.json:2592-2600).
- Docs rewritten to the decided rule in the same PR:
  docs/architecture/printing.md (generic-80 fixed cols-42/42 to
  cols-48/48; branded-only raster declaration; validated-generic rule;
  probe section rewritten from "not reachable" to the settings flow),
  docs/printers.md (generic = baseline off + refusal rule; corrected
  refusal troubleshooting — unvalidated generic vs wrong-profile
  rename; validation per printer, never per locale),
  docs/guides/testing-printers.md (only branded profiles declare
  raster; probe section rewritten to the reachable settings flow).
- Labels stay Arabic: «المجموع» was not renamed (decision 051: the
  subtotal and fee rows are also Arabic financial rows, so renaming
  would not solve PF-01).
- The Phase A report file was not amended.

## Mechanism choice, and why

Validation is stored as a flag + scope on the printer row and matched
at read time, instead of a reset-on-write rule in the PUT route: no
write path can forget to reset it, and the rule is a pure function
(`isRasterValidatedForPrinter`) that the tests pin directly. The probe
reuses the existing test-print route surface and the existing
`rasterProbe` diagnostic rather than a parallel print path, and the
WebUSB side reuses the existing `rasterWebUsbPathEnabled`
validated-profile concept instead of a second vocabulary.

## Tests

- tests/raster-printing.test.ts: the both-sides pin (old lines 107-108)
  is replaced with the decided rule — baseline off; every generic
  profile off by default; a validated generic printer's effective
  capability on at 576/384 with paper-width capping; validation
  scoping (flag off / rename / paper change / profile change all
  reset). An Arabic classic bill (شاي items, المجموع الفرعي / المجموع
  totals, SYP/SP, 48 cols) is refused with 0 bytes + the financial
  warning under an unvalidated generic, and under a validated generic
  produces financial raster requests containing «المجموع», non-empty
  bytes containing GS v 0, and bytes deep-equal to the same render
  with the literal pre-B1 generic capability object — the byte-identity
  proof, with no golden regeneration. Probe-page tests: GS v 0
  present, ends with feed+cut, rejects without raster caps, rejects
  on render failure. The `resolvePrinterContext` block now pins the
  decided rule plus validated variants.
- tests/printer-api.test.ts: 17 new assertions — generic fixture starts
  unvalidated / raster off; validate requires `confirmed: true` (400);
  unknown printer 404; validate 200 persists the flag, raster on at
  576; rename resets validation; re-validation works; paper-width
  change resets validation; branded fixture raster on without
  validation; validate on branded returns 409
  `raster_validation_not_applicable`.
- tests/print-menu-printer-selection.test.ts (commit 2e1eb91): the
  selection fixtures now validate through the endpoint before
  printing. This is a real B1 consequence, not a regression: the menu
  carries Arabic lines (heading, item-count totals) that only a
  raster-capable printer can carry, so on an unvalidated generic the
  menu print now refuses with 502 exactly as the native path does for
  any raster-off printer. The selection assertions themselves are
  unchanged.

## Battery (full protecting battery, run 2 — the complete record)

31 commands, 30 exit 0. The single exit 1 is `test:raster`, Electron
half NOT RUN on this host — `Missing X server or $DISPLAY`, pre-existing
since D5, reproduced on a pristine checkout. Supplementary Xvfb run of
`test:raster`: exit 0 ("Chromium raster surface rendered styled RTL
output", "Warm Chromium raster singleton lifecycle passed").

- test:printer 0 (printer.test.ts 460 passed, 0 failed; printer-api
  112/112 passed, 0 failed; menu-selection passed; printer-ipc passed)
- test:printing-settings 0, test:print-parity 0 (613 assertions passed,
  0 failed), test:receipt-column-oracle 0 (13/13, 0 fail — byte-identical,
  no golden regeneration), test:receipt-column-width 0
- test:thermal-capabilities 0, test:kot-print-queue 0 (119/119 passed,
  0 failed), test:kot-line-wrap 0, test:kot-order-notes 0,
  test:bill-print-warnings 0, test:bill-printed-at 0, test:menu-printing 0,
  test:print-kernel 0, test:print-document 0,
  test:merchant-print-templates 0, test:delivery-slip 0,
  test:printer-width-refresh 0, test:printer-migrations 0,
  test:webusb-printer-selection 0, test:receipt-printing 0,
  test:bills-print-api 0 (34/34 passed, 0 failed),
  test:issue-printing-and-kds-resilience 0,
  test:issue-266-currency-symbol-print 0, test:print-labels 0
- i18n:check 0, lint 0 (backend 830 warnings / 0 errors, frontend
  1 warning / 0 errors), build 0, build:frontend 0, docs:check 0
  (5 policy warnings only, all pre-existing in
  IMPLEMENTATION_REPORT_AR.md and the Phase A audit report, none in
  B1's docs), test:migration-registry 0 (389/389 checks passed,
  128 migrations v1..v128)
- `npm run clean` between suites; proxy unset except build:frontend
  (proxy on). Logs under
  ~/workspace/rest-cafe-docs/printing-finalization-b1-2026-11-10/logs/
  (summary.tsv + per-suite logs + test-raster-xvfb.log).

Note on run 1: the first battery run was killed mid-suite by the
session teardown (it stopped at test:issue-printing-and-kds-resilience
with no process left alive) and is preserved as summary-run1-partial.tsv.
Run 2 above is a fresh full run on the final tree including the
menu-selection fixture fix, and is the record that counts. Run 1's one
real finding — the menu-selection test red — is the fix in commit
2e1eb91 described above.

## Disclosures

- Formatter churn (pre-commit hook, oxc): commit 518dcde wholesale
  normalized tests/raster-printing.test.ts (never-formatted file;
  2628-line diff, mostly line-wrapping of dense long lines). The
  semantic change is only the pin replacement + the B1 blocks; the
  `resolvePrinterContext` update is the separate clean commit 2e26ff0
  (47/5). Commit 9c2631b re-indents the configured-printer row JSX one
  level (new wrapper div for the confirm panel) — structural, expected.
  Commit 0f0ad9e joins multi-line exec calls in migrations.ts (minor).
- Decision-051 corrections recorded (report file not amended): the real
  branded profile names are xprinter-xp-v320m-v330m (XP-V320M/V330M)
  and epson-tm-series (TM Series) — report §3.1 names two profiles
  that do not exist; the registry was 127 migrations / 386 checks at
  Phase A landing and is now 128 migrations / 389 checks with v128.
- Physical-printer verification is outstanding (owner's machine) — no
  real-printer claim is made here. The validated path is proven
  byte-identical to the old generic raster output by test, not by a
  hardware print.

## What is next

B2 (PF-04: queued receipt retry — printed_at guard or cancel pending
receipt jobs, required exact-sequence test; frontend localStorage queue
addressed or explicitly scoped out) starts only after B1 lands. No
installer for B1; the installer is dispatched after the last production
delivery (B4), per decision 051.
