# Rest&Cafe — Printing System Finalization, Phase A Audit Report

- **Audited baseline:** upstream `main` at `b05322e7a2f2ab3aa4b8d67147b1beb12fd323c6`
  (follow-up 49, "stored currency symbol wins in on-screen money formatting").
  Verified by `git ls-remote` and the GitHub API at the start of the phase;
  upstream did not move during the phase.
- **Phase:** A — audit and evidence only (assignment thread `20261110-050`).
- **Date:** 2026-11-10. **Author:** Flint (implementation agent). **Reviewer:** Ted.
- **Method:** ran the assignment §2 list at the baseline on a clean tree;
  read the current implementation, tests, and documentation; traced the
  raster, queue, and refusal paths by hand; ran a scratch evidence probe
  (not a test, not shipped) against the real generic profiles.
- **What Phase A changed:** nothing except this file and the
  start-announcement status file on the branch. No production code, no test,
  and no golden file was modified. The receipt column oracle passed with no
  golden regeneration.

## 1. Executive summary

The printing subsystem is in substantially better shape than the
2026-11-01 audit left it: the durable print queue, the KOT printed marker,
the retry/backoff worker, the financial refusal, and the deterministic
WebUSB selection all exist, are wired in, and are green under test. The
queue/retry/duplicate behaviour the old test matrix says does not exist
does exist, and the matrix rows that say so are stale (§7).

One real software finding stands out, and it is the one Ted already
verified in code. Everything else is a second-order gap or a documentation
drift.

| ID | Severity | Finding |
| --- | --- | --- |
| PF-01 | High | Generic profiles declare raster enabled, contradicting the conservative baseline: an unidentified printer is silently assumed to support GS v 0 raster. Financial Arabic rows are rasterized instead of refused on generic profiles. If the physical printer does not implement GS v 0, those rows (including the grand-total row) vanish from the paper while the print is recorded successful. |
| PF-02 | Medium | Receipt-logo raster bypasses the `raster.enabled` gate: the native-fallback render (raster disabled, width kept) still emits a GS v 0 logo line. Cosmetic only (logo, non-financial), but it contradicts the profile-owned raster contract. |
| PF-03 | Medium | The `whole-receipt` raster mode is declared on all four profiles but has no production caller; only a test exercises it. |
| PF-04 | Medium | A queued receipt retry can duplicate a manually reprinted receipt: nothing cancels a pending receipt job when a manual reprint succeeds, and the worker does not check `printed_at` before executing a receipt job. KOT is protected by the F-004 marker; receipts have no equivalent gate. |
| PF-05 | Low | Crash-window duplicate on KOT marking: if the process dies (backend) or the marker POST fails (WebUSB) after a successful dispatch but before the marker is stamped, the next retry re-sends the same items. Narrow window, not a normal-path defect. |
| PF-06 | Docs | `docs/architecture/printing.md`, `docs/printers.md`, and `docs/guides/testing-printers.md` describe the PF-01 inconsistency as intended, and `printers.md`'s financial-refusal guidance is wrong on the raster path. The `printing.md` profile table also still lists the generic 80 mm profile at 42 columns; the code pins 48 (post-D5 F-015). |
| PF-07 | Docs / test | The test suite pins both sides of the PF-01 contradiction without asserting the relation between them; no test asserts that an unidentified printer must not receive raster. The raster diagnostic probe has no UI caller and no test. |
| PF-08 | Docs | Test-matrix rows C07, C08, F08, F09, F10, F11 are stale (plus C06, F06, P07 and the E04 migration counts). |

No finding in this phase blocks a software verdict by itself except PF-01,
which needs a decision (see §3.5): the conservative resolution changes
what an Arabic receipt does on an unidentified printer, so it is Ted's
call, not a silent fix.

## 2. Test execution — exactly what ran

Every command below was run at the baseline commit on a clean tree
(`git status` clean apart from the announce commit), in the order listed,
with the environment's Node 24.22.1 / npm 10.9.4. Counts are quoted from
each command's own log; the full logs are retained outside the repo
(`~/workspace/rest-cafe-docs/printing-finalization-a-2026-11-10/logs/`).

| # | Command | Exit | Result as logged |
| --- | --- | --- | --- |
| 1 | `npm run test:printer` | 0 | `printer.test.ts` 460 passed, 0 failed; `printer-api` 94/94 passed; print-menu printer selection passed; printer IPC surface matches live schema |
| 2 | `npm run test:printing-settings` | 0 | 27/27 passed |
| 3 | `npm run test:print-parity` | 0 | Parity contract: 613 assertions passed, 0 failed |
| 4 | `npm run test:receipt-column-oracle` | 0 | node:test 13 pass, 0 fail — golden receipt byte-identical, no regeneration |
| 5 | `npm run test:receipt-column-width` | 0 | node:test 4 pass, 0 fail |
| 6 | `npm run test:raster` | **1** | First half passed ("Raster encoder and mixed-mode contract checks passed"); second half (`test:raster-electron`) NOT RUN — see §2.1 |
| 7 | `npm run test:thermal-capabilities` | 0 | All 5 bundled suites passed: thermal-capabilities ("Thermal capability parity: backend and WebUSB fixtures passed"), windows-print-stderr, windows-print-error-detail (issue #789), printer-error-toast-clarity, network-print-chunking |
| 8 | `npm run test:kot-print-queue` | 0 | Results: 119/119 passed, 0 failed |
| 9 | `npm run test:kot-line-wrap` | 0 | Results: 22/22 passed, 0 failed |
| 10 | `npm run test:kot-order-notes` | 0 | "kot-order-notes tests passed" |
| 11 | `npm run test:bill-print-warnings` | 0 | Results: 17/17 passed, 0 failed |
| 12 | `npm run test:bill-printed-at` | 0 | Results: 16/16 passed, 0 failed |
| 13 | `npm run test:menu-printing` | 0 | node:test 10 pass, 0 fail |
| 14 | `npm run test:print-kernel` | 0 | "All print kernel tests passed"; "All print-language settings tests passed" (bundles `print-kernel`, `kernel-purity`, `print-language-settings`) |
| 15 | `npm run test:print-document` | 0 | "PrintDocument unit tests: 46 checks passed"; "All receipt logo printing tests passed successfully!" (bundles `print-document`, `receipt-logo-printing`) |
| 16 | `npm run test:merchant-print-templates` | 0 | "Merchant print template tests: 38 checks passed" |
| 17 | `npm run test:delivery-slip` | 0 | node:test 50 pass, 0 fail |
| 18 | `npm run test:printer-width-refresh` | 0 | 3/3 passed |
| 19 | `npm run test:printer-migrations` | 0 | 8/8 passed |
| 20 | `npm run test:webusb-printer-selection` | 0 | Results: 15/15 passed, 0 failed |
| 21 | `npm run test:receipt-printing` | 0 | 8/8 passed; "All Receipt Settings Hydration tests passed successfully!" (bundles `receipt-printing`, `receipt-settings-hydration`) |
| 22 | `npm run test:bills-print-api` | 0 | 34/34 passed, 0 failed |
| 23 | `npm run test:issue-printing-and-kds-resilience` | 0 | 19/19 passed, 0 failed |
| 24 | `npm run test:issue-266-currency-symbol-print` | 0 | 8/8 passed, 0 failed |
| 25 | `npm run test:print-labels` | 0 | "Print label tests: 151 passed, 0 failed" (bundles `print-labels`, `phase3-print-regressions`, `generate-print-labels --check`) |
| 26 | `npm run lint` | 0 | Backend 827 warnings / 0 errors; frontend 1 warning / 0 errors |
| 27 | `npm run build` | 0 | `tsc` + runtime assets copied |
| 28 | `npm run build:frontend` | 0 | Next.js 16.4.2 production build, static export |
| 29 | `npm run docs:check` | 0 | Structure + policy pass; 1 pre-existing non-gating policy warning (see §2.2) |

29 commands, 28 exit 0, 1 exit 1 (`test:raster`, Electron half only).
Nothing was modified to make a suite pass. No suite was skipped silently.

### 2.1 `test:raster` — the one non-green command

`npm run test:raster` runs two halves:

- Half 1, `tests/raster-printing.test.ts` (ts-node): **passed** —
  "Raster encoder and mixed-mode contract checks passed."
- Half 2, `npm run test:raster-electron` (`npm run build && electron
  --no-sandbox tests/raster-renderer-electron.test.cjs`): the build half
  passed, then Electron itself exited before running any test:

  ```text
  [4630:1110/145934.596711:ERROR:ui/ozone/platform/x11/ozone_platform_x11.cc:257] Missing X server or $DISPLAY
  [4630:1110/145934.596775:ERROR:ui/aura/env.cc:246] The platform failed to initialize.  Exiting.
  ```

  The (dbus "Failed to connect to the bus" lines are environment noise and
  appear in passing runs too.) This is an environment limitation, not a
  code failure: this Linux VM has no X server and `$DISPLAY` is unset.
  Per the assignment it is reported as **NOT RUN with the exact error,
  never as passed**. It reproduces identically on a pristine checkout of
  the baseline: the same failure, byte for byte, is in the Delivery 5
  battery log (`auditfix-d5-2026-11-02/10-battery-test:raster.log`,
  2026-11-02), which ran against the D5 base commit. The failure is
  pre-existing and environmental.

  Supplementary evidence (not a substitute for the prescribed command):
  the Electron half **does run and pass on this host under a virtual
  display**. After the battery, `xvfb-run -a electron --no-sandbox
  tests/raster-renderer-electron.test.cjs` exited 0 against the same
  `dist/` the battery built, printing:

  ```text
  Chromium raster surface rendered styled RTL output.
  Warm Chromium raster singleton lifecycle passed.
  ```

  So the renderer test itself is green; only the plain (no-display)
  invocation cannot start Electron here. Ted's battery on his host is
  still the independent check.

### 2.2 `docs:check` — one pre-existing, non-gating warning

`docs:check` exits 0. It reports one policy finding, a warning, not a
gate:

```text
Docs process-material policy FAILED (1):
  docs/IMPLEMENTATION_REPORT_AR.md:115 phase-numbering: سبع ملاحظات من تشغيل فعلي على Windows، ...
Policy findings above are warnings: they are reported, not gated.
```

This is the same phase-numbering warning Ted recorded after landing the
035 audit; it predates this phase and nothing in this phase touches that
file.

**Note on this report file itself (landings step, not a battery item):**
after this file was added, `npm run docs:check` exits 1 on exactly one
item — index completeness: `production-readiness/PRINTING_FINALIZATION_AUDIT.md
is not linked from docs/README.md`. Markdownlint reports 0 issues and
all 328 relative links check OK. The file is intentionally left
unindexed in this PR: the assignment's deliverable is the report file
only, and per the 035 precedent Ted indexes audit pages in
`docs/README.md` on landing (035: `0a44a9c`).

### 2.3 Lint warning count

Backend lint: 827 warnings, 0 errors; frontend lint: 1 warning, 0
errors. The backend count was 822 at the Delivery 6 landing; the +5
comes from upstream follow-ups 40–49 (landed directly by Ted), not from
this phase, which changed no code.

## 3. PF-01 — Generic profiles claim raster capability the baseline denies

**Severity: High. Status: confirmed by code, tests, and probe.**

### 3.1 The contradiction, in the code

`shared/print/thermal-capabilities.ts` defines the conservative baseline
`GENERIC_THERMAL_CAPABILITIES` (line 55):

```ts
raster: { enabled: false, widthDots: 0, maxBandHeight: 0, modes: [] },
```

with the comment: "False unless this exact profile has been validated on
real hardware", and line 45: "Additive raster contract; disabled for all
unverified shipped profiles."

`main/printers/profiles.ts` then overrides both generic profiles with
raster enabled, to the exact same values as the branded profiles:

| Profile | `raster.enabled` | `widthDots` | `maxBandHeight` | `modes` |
| --- | --- | --- | --- | --- |
| Xprinter XP-80C | true | 576 | 200 | `['mixed', 'whole-receipt']` |
| Epson TM-T20III | true | 576 | 200 | `['mixed', 'whole-receipt']` |
| `generic-escpos-80` | **true** | 576 | 200 | `['mixed', 'whole-receipt']` |
| `generic-escpos-58` | **true** | 384 | 200 | `['mixed', 'whole-receipt']` |

`getSupportedPrinterProfiles()` returns the four profiles, and
`resolvePrinterProfile()` falls back to `generic-58` (paper width
starting `58mm`) or `generic-80` for **any** unrecognized printer. So an
unidentified printer silently receives a raster-enabled profile, and
nothing in the system distinguishes the branded 576 dots from the
generic 576 dots.

The gate that reads this capability is `rasterCapabilityEnabled()` in
`shared/print/raster.ts`: enabled, width in range, band height in range,
mode declared. A scratch probe (not a test, not shipped) confirmed the
gate passes for both generic profiles in both modes, and fails for the
`GENERIC_THERMAL_CAPABILITIES` baseline.

### 3.2 What the capability does — traced path

When `raster.enabled` is on and a line is not thermal-representable
(Arabic text), the document builders keep the line raw — untruncated,
unwrapped — for rasterization instead of transliterating, skipping, or
wrapping it. Those branches are the `raster.enabled &&` paths in
`main/printers/formatting-helpers.ts` (`financialRows` ~line 224,
`truncate` ~320, `pushWrapped` ~361, `pushCenteredWrapped` ~380,
`normalizeThermalText` ~400) and in the document builders
(`document-classic.ts:335,359`, `document-compact.ts:126,150`,
`document-kot.ts:166`, `document-delivery-slip.ts:282`).

Every print path then renders each document twice: once with the
(profile) raster capabilities and once with `nativeFallbackCapabilities()`
(a raster-disabled copy), and picks the result in
`main/printers/raster-documents.ts:123` (`rasterizeDocumentLines`):
`data = rasterized.rasterSelected && !rasterized.rasterFailed ?
rasterized.data : nativeResult.data`. Rasterization of unsupported lines
happens in the Chromium renderer (`rasterizeReceiptIfEnabled`, called in
`main/printers/thermal.ts:326`), which renders the lines into GS v 0
bit-image bands.

The fail-closed property survives at this stage:

- If the Chromium renderer **fails** on a financial line, the line
  produces a `financial` warning, `hasFinancialPrintWarning()`
  (`thermal.ts:112`) refuses the whole print with
  `makeFinancialPrintRefusalMessage` ("Receipt not printed: a financial
  row contains unsupported printer text… Use a supported printer profile
  or system/browser printing"), and nothing is sent.
- `printMenuDocument` refuses outright on `rasterFailed`.
- If the renderer **succeeds**, the GS v 0 bytes are sent to the printer.

The failure mode is the third case: the renderer succeeds, the bytes are
sent, and the **physical printer does not implement GS v 0**. There is no
post-dispatch verification anywhere in the system (§5): transport success
means the socket write completed, the spooler accepted the job, or CUPS
exited 0. The raster bands are then dropped by the firmware — silently,
including rasterized **financial** rows — while the system records the
print as successful and, for bills, stamps `printed_at`
(`markBillPrintedOnDispatch`, one transaction in `receipt.ts:129`), so no
retry is ever queued (§4, PF-04).

### 3.3 Probe evidence — the same document, two paths

A scratch probe against the real generic-80 capabilities produced a
classic Arabic bill (renderer stubbed; the probe measures only what the
system asks the renderer to do and what the native path does — it does
not claim to render Arabic correctly, and it was not a test):

| | Raster path (generic-80, raster enabled) | Native path (raster disabled) |
| --- | --- | --- |
| Raster requests | 4 units, **1 of them financial**: `المجموع الفرعي SYP10,000.00` (financial-summary layout), `pos.tax SYP1,000.00` (financial), `المجموع SYP11,000.00` (financial), plus non-financial Arabic lines (store name مطعم, time, item شاي) | — |
| Emitted bytes | GS v 0 bands dispatched to the printer | **0 bytes emitted — receipt refused** (warnings `[line, line, line, financial, line]`) |
| On a printer without GS v 0 | Financial rows vanish from the paper; print recorded successful | — |
| On a printer with GS v 0 | Correct output | — |

For contrast, the same document against the `GENERIC_THERMAL_CAPABILITIES`
baseline behaves exactly like the native column above: the receipt is
refused instead of sent. `tests/raster-printing.test.ts:330-369`
independently pins the financial decision in the other direction: it
asserts that an Arabic grand-total line **is** rasterized — with
synthetic capabilities, never with a generic profile.

`tests/raster-printing.test.ts:107-108` pins **both sides** of the
contradiction and therefore catches neither:

```ts
expect(rasterCapabilityEnabled(GENERIC_THERMAL_CAPABILITIES)).toBe(false);
expect(getSupportedPrinterProfiles().every(
  (profile) => profile.capabilities.raster.enabled)).toBe(true);
```

`tests/thermal-capabilities.test.ts` asserts only that
`generic.capabilities.raster.font` is `undefined`; it never asserts
`raster.enabled`. Which profile the "every profile enables raster"
assertion covers is the entire question, and no test asks it (§9, PF-07).

The matrix row F04 says the same thing in plain language — "Lines
rasterized (all shipped profiles rasterize) or refused closed on
financial lines" — and it is accurate as a description of the current
code. It is the **assumption** in that row that is unverified: whether a
real, unidentified generic printer implements GS v 0 is UNVERIFIED
(no physical printer exists to anyone), and the system treats the
assumption as true by default instead of failing closed.

### 3.4 What is NOT found here

- The fail-closed refusal itself works: on the disabled path the receipt
  is refused with 0 bytes and a clear message. The defect is the
  profile, not the refusal logic.
- The renderer-failure path is guarded: a failed financial raster line
  refuses, it does not degrade to native (see §3.2). A financial row is
  never silently replaced by native text.
- Pack (plugin) templates stay raster-off: `receiptDocumentLines`
  returns `null` for `selection.source === 'pack'` (citing F-017);
  rasterizing them would weaken the fail-closed rule. Merchant templates
  render through the classic pipeline with financial-line groups and can
  be rasterized.
- The inconsistency is confined to the generic profiles. The branded
  profiles (Xprinter, Epson TM) declare the same values, but those are
  named models whose capability the project chose to assert; the generic
  profiles are the fallback for unknown hardware.
- No physical printer was available, so whether any real generic ESC/POS
  printer implements GS v 0 remains UNVERIFIED, and nothing in this phase
  concludes it either way.

### 3.5 Conservative resolution options (no fix applied in Phase A)

The choice changes what an Arabic receipt does on an unidentified
printer, so it is Ted's decision, not a silent fix:

1. **Default to the baseline for generics** — set both generic profiles'
   `raster` to `{ enabled: false, widthDots: 0, maxBandHeight: 0,
   modes: [] }`. Unknown printers fail closed (Arabic financial → refusal
   with the existing message; non-financial → skip + warning) until a
   profile is validated on real hardware. Consequence: Arabic receipts on
   generic printers would refuse instead of printing until a validated
   profile is used. This matches the baseline's own comment.
2. **Keep raster for generics behind an explicit opt-in** — a per-printer
   opt-in (validated flag in settings) that the owner enables after a
   successful test print or a paper-verified receipt. Printing on an
   unidentified printer stays fail-closed by default.
3. **Keep the profiles, change only docs and tests** — describe raster-on-
   generic as an intended, supported-configuration requirement (generic =
   GS v 0 required), and keep the behaviour. Weakest: it writes the
   assumption into the documentation instead of resolving it, and it
   contradicts the baseline's own "validated on real hardware" comment.

Whichever option is chosen, the test that pins both sides
(`raster-printing.test.ts:107-108`) must be updated to assert the
_decision_ — that an unidentified printer does or does not receive raster —
and the `docs/architecture/printing.md` / `docs/printers.md` descriptions
(§8) must be rewritten to match.

## 4. PF-02 — Receipt logo bypasses the `raster.enabled` gate

**Severity: Medium. Status: confirmed by probe. Impact: cosmetic
(non-financial logo only).**

`shared/print/document.ts:637` attaches `logoRaster` whenever
`business.showLogo && business.receiptLogoRaster`, with no capability
check. `document-classic.ts:632-640` then builds logo bands with
`widthDots = capabilities?.raster?.widthDots ?? (cols <= 32 ? 384 : 576)`
(note: `??` does not catch `0`) and pushes them as `{ RAW_BYTES: … }`
(converted to raw bytes by `buildEscPos`, `formatting-helpers.ts:567`);
the same pattern exists in the frontend encoder
(`receipt-encoder.ts:621, 1151`).

Probe (two widths, same document):

| Capabilities | Logo emitted |
| --- | --- |
| Strict GENERIC baseline (`enabled: false, widthDots: 0`) | **0** RAW_BYTES lines — `getLogoRasterBands` returns `[]` for `widthDots <= 0`; logo silently suppressed |
| Native-fallback capabilities (`enabled: false, widthDots: 576`) | **1** RAW_BYTES line — the logo **is** emitted as GS v 0 even with raster disabled |

The real native receipt path uses exactly the second set of caps:
`prepareReceipt` with the native capabilities (`thermal.ts` ~980), and
the frontend `builderOpts` with `nativeFallbackCapabilities(...)`
(`usePrinter.ts:489`). So every native-fallback receipt can carry a
GS v 0 logo the raster gate says is off. Only the logo is affected — it
is non-financial, so the financial fail-closed property is untouched; a
printer without GS v 0 simply drops the logo silently.

An earlier hypothesis — that the logo is emitted even against the strict
baseline — was **disproven** by the probe (0 lines) and is not carried
here. The fix candidate is small: gate logo emission on
`raster.enabled` (or on `widthDots > 0 AND enabled`), and make the
suppression explicit (warning) rather than silent when a logo is
configured but not emitted.

## 5. PF-03 — `whole-receipt` mode is declared but unreachable in production

**Severity: Medium (dead capability claim). Status: confirmed by code
search.**

`encodeWholeReceiptRaster` (`shared/print/raster.ts:209`) has no
production caller — the only caller in the repo is
`tests/raster-printing.test.ts:434`. Every production path uses `mixed`:
`encodeMixedPrintParts` (the default mode), the backend adapter
`main/printers/raster-output.ts` (`buildBackendMixedRasterBytes`), and
the frontend encoder (`frontend/src/lib/printer/raster-encoder.ts`).
All four profiles claim a mode no printer ever exercises in production.

`docs/architecture/printing.md` says `whole-receipt` "must be opted into
explicitly by the caller", and no caller opts into it. Either the mode
should be wired to a real opt-in (the raster-probe diagnostic,
§9, would be the natural place to exercise it first), or it should be
removed from the shipped profiles until a caller exists. A declared
capability that nothing can exercise is not a verified capability.

## 6. PF-04 — Queued receipt retry can duplicate a manual reprint

**Severity: Medium. Status: confirmed by code trace. Not covered by any
test.**

### 6.1 What exists and works (the good news)

The durable queue is real and works as designed (migration v123
`kot_printed_marker_and_print_jobs`, `main/db/migrations.ts:3578`: adds
`order_items.kot_printed_at`, creates `print_jobs`, adds the due index;
v124 adds `bill_print_warnings`):

- `main/services/print-queue.ts`: `enqueuePrintJob` dedups an identical
  (kind, order_id, bill_id, payload) job already pending or processing;
  `claimDuePrintJobs` claims transactionally (`status = processing`), so
  two workers never execute the same job; backoff 30s → 2m → 5m → 10m →
  15m; `PRINT_JOB_MAX_ATTEMPTS = 10`, then `failed` (row kept as the
  record). The worker (`PrintQueueService`) ticks every 30s plus one pass
  10s after startup (`printQueue.start()` in `main/index.ts:1211`),
  single-flight.
- On success, `completePrintJob`; for receipt jobs
  `markBillPrintedOnDispatch` (`main/services/receipt.ts:129`) stamps
  `printed_at` plus the recorded warnings in one transaction — so
  `printed_at` is written only after dispatch success (F-026 holds).
- KOT marker (F-004): `dispatchKotForOrder` (`main/services/kot-print.ts:206`)
  re-reads candidates from the DB — only items still pending AND
  `kot_printed_at IS NULL` (`getUnprintedKotItems`); each station group
  is marked printed (`markKotItemsPrinted`, `WHERE kot_printed_at IS
  NULL`) only after that group's dispatch reports ok; zero candidates →
  `{ ok: true, nothingToPrint: true }`. Every backend KOT path goes
  through it (route `/print-kot`, `main/routes/printers.ts:1146`; queue
  worker). On dispatch failure the route enqueues **only** the failed
  item ids; on the no-printer 400 it also enqueues (for a real order).
- Print-bill route (`printers.ts:1036`): a failed stored bill (id > 0) is
  enqueued as a receipt job; a synthetic bill (id 0) is not queued; the
  no-printer 400 is **not** queued (the POS falls back to browser print
  there, and a queued thermal print would duplicate it). One queue,
  one dispatcher, on both sides.
- WebUSB KOT: after a successful `printerService.print`, the frontend
  calls `reportKotPrinted(order.id, ids)` → POST `/printers/kot-printed`
  (`main/routes/printers.ts:1195`) stamps the marker. Frontend KOT
  encoders all filter `!item.kot_printed_at` (`kot-encoder.ts:294`,
  `kot-web-print.ts:170`, `print-document.ts:393`,
  `document-kot.ts:46`).
- Frontend queue (`frontend/src/lib/printer/print-queue.ts`,
  localStorage key `flocafe:pending-print-jobs`): dedup by key (kind,
  orderId, billId, sorted itemIds); same backoff ladder;
  `PENDING_PRINT_JOB_MAX_ATTEMPTS = 5`, then `exhausted`; it queues
  **only** failures the backend never answered (no-response / network
  drop) or WebUSB dispatch failures — a backend-answered 502 is already
  server-queued, so the renderer does not double-queue
  (`usePrinter.ts` ~404, ~802). Browser-print failures are deliberately
  **not** queued (dialog outcome unknowable). Drain hook:
  `frontend/src/hooks/usePrintQueueDrain.ts`.
- `tests/kot-print-queue.test.ts` (119/119 in this battery) pins: marker
  semantics, enqueue dedup, transactional claim, backoff ladder, attempt
  cap, worker execution with injectable dispatchers, missing-bill receipt
  job fails without touching the printer, frontend queue dedup / backoff /
  exhaustion / removal.

### 6.2 The duplicate window (PF-04)

`executePrintJob`'s receipt path dispatches **without checking
`bills.printed_at`**, and nothing cancels a pending receipt job when a
manual reprint succeeds. A repo-wide grep confirms only
`print-queue.ts` touches `print_jobs` (besides the migration and two
`usePrinter` comments). The sequence:

1. Receipt print fails (printer offline, say) → the bill is enqueued as
   a receipt job, first retry in 30s.
2. The operator sees the failure, and within those 30s reprints manually
   from the POS. The reprint succeeds; `printed_at` is stamped.
3. The worker later executes the queued job and prints the receipt
   **again** — the same bill, a second time, with no reprint banner
   (the queued job carries the original attempt's flags; if the original
   was not a reprint, the duplicate prints as an ordinary receipt).

KOT is closed against this by the marker (the worker re-reads
unprinted items at execution time). Receipts have no execution-time
equivalent. The frontend queue has the same window from its side: it
queues on no-response, and a later manual success does not remove the
queued job. Impact is paper and confusion, not money (printing never
moves money), and the window is 30s wide by default — but in a busy
service, "print failed, reprint now" is the normal operator reflex, so
the window is hit in normal operation, not only in edge cases.

Fix candidates (Phase B): check `printed_at` before executing a receipt
job (skip if the bill was printed after the job was queued — or at all,
since a reprint after queueing is a deliberate operator action), or
cancel pending receipt jobs for a bill when a manual print of that bill
succeeds. Either must be covered by a test that reproduces the exact
sequence (fail → enqueue → manual success → worker pass → no second
print).

### 6.3 PF-05 — Crash-window KOT duplicates (narrow)

Two windows, both crash-only, neither a normal-path defect:

- **Backend:** the process crashes between transport success and the
  synchronous `markKotItemsPrinted` immediately after it (same
  function, same statement block). The items stay unmarked; the next
  dispatch re-sends them.
- **WebUSB:** the ticket prints, then the awaited `reportKotPrinted`
  POST fails (Wi-Fi drop in that instant) → the outer catch treats the
  print as failed → a retry can re-send the same items.

Both are single-step windows with no surviving state that lets the
system distinguish "printed but unmarked" from "never printed". Noted
for completeness; the queue's transactional claim and the marker remain
the correct protections, and no change is proposed in this phase.

## 7. PF-08 — Stale test-matrix rows

`docs/production-readiness/RESTAURANT_TEST_MATRIX.md` (as audited at the
035 HEAD 4743bfd, 2026-11-01) describes a printing subsystem that no
longer exists. The corrections below are for Phase C to apply to the
matrix; this section states the current truth with the evidence.

| Row | Matrix says (stale) | Current state |
| --- | --- | --- |
| C07 | "currently re-sends all pending items (defect)" / FAIL / "no printed marker exists" | **Stale.** The F-004 marker exists (`order_items.kot_printed_at`, migration v123); a retry sends only unprinted pending items. `test:kot-print-queue` 119/119. |
| C08 | "no automatic retry (audit F-009)" | **Stale.** The durable backend queue retries automatically (backoff ladder, 10 attempts, worker every 30s + 10s after startup), and the frontend queue retries WebUSB / no-response failures. |
| F08 | "KOT reprint duplicates pending items (audit F-004)" / FAIL | **Stale for KOT** (marker prevents it). The receipt-reprint half is intentional behaviour — reprints are a feature, and a reprinted receipt carries a banner. |
| F09 | "no automatic retry (audit F-009)" | **Stale** (same as C08). |
| F10 | "there is no queue — see F-009" | **Stale.** `print_jobs` is durable in SQLite and survives an app restart; disconnect/reconnect is retried by the worker. |
| F11 | "No print queue exists, so nothing is pending; the operator reprints manually" | **Stale.** The queue exists, survives restart, and the worker runs a pass 10s after startup, so pending jobs are picked up without the operator doing anything. |
| C06 | "orders that arrived during the outage appear (without a chime — see F-029)" | **Stale.** The F-029 reconnect catch-up chime landed in 037 Delivery 3 (`kds-reconnect-chime` 25/25). |
| F06 | "KOT truncates (audit F-016 — known inconsistency)" | **Stale.** F-016 KOT line wrapping landed in 037 Delivery 5; `test:kot-line-wrap` 22/22. |
| P07 | Expected result: "failed KOT is flagged for manual reprint (audit F-009)" | **Stale.** A failed KOT is queued for automatic retry (PF-04 / §6.1); flagging for manual reprint is no longer the path. |
| E04 | Counts "v122 / registry 371/371" | **Stale counts.** The registry is now 124 migrations, 377/377 (v123 print jobs + marker, v124 bill print warnings). |
| F04 | "Lines rasterized (all shipped profiles rasterize) or refused closed on financial lines" | **Accurate as a description of current code, but the assumption is unverified** — it is the PF-01 finding. Needs the Phase A qualification in Phase C, not a wording tweak alone. |
| F14 | Z-report print FAIL (cash-closures §15) | Unchanged: pre-existing failure. `test:cash-closures` is not in the §2 list; recorded here as-is, not re-verified. |
| — | C08/F09 evidence pointer: `frontend/src/hooks/usePosPrinting.ts:37-104` | **Stale pointer.** That file's only queue reference now is the error code `printer.queue_failed`; the retry behaviour lives in `main/services/print-queue.ts` + `usePrinter.ts`. |

Out of printing scope but observed while reading the same file: **A02 /
H04** ("no autostart exists — see audit F-005") is stale — autostart
landed in 037 Delivery 4. Phase C should not need to touch those rows;
they are flagged here so the matrix owner can route them.

## 8. PF-06 — Documentation inconsistencies

### 8.1 The inconsistency described as intended

`docs/architecture/printing.md` (~line 239): "All four declare
`raster.enabled: true` with modes `mixed` and `whole-receipt`, at 576 dots
of width except the 58 mm profile, which declares 384." It states the
PF-01 state as a fact of the system with no qualification, and no page
says the generic profiles are unverified.

`docs/guides/testing-printers.md:38`: "Every profile declares raster
capability. The 58 mm profile declares 384 dots of width…" — same
framing.

`docs/printers.md` (~lines 67–75) is internally inverted against the
code:

> "The generic profiles are the conservative ones. They are ASCII-only,
> with no text shaping, and they skip unsupported non-financial text with
> a warning but **refuse** a receipt whose financial rows contain
> unsupported text… All four shipped profiles enable the capability-gated
> raster path; what differs is encoding and script coverage."

With raster enabled on the generics, an unsupported financial row is
**rasterized**, not refused — a refusal happens only if raster rendering
fails. The troubleshooting advice in the same section ("A printer set to
the generic profile when it should be an Xprinter or Epson is the usual
cause" of a refusal) is likewise inverted: on the raster path, a generic
profile is the one that _avoids_ the refusal, by converting it into a
GS v 0 dispatch.

`docs/printers.md` (~line 86): "A validated printer profile may also
enable the capability-gated raster path… Profile capability is what
enables it; a locale never does." — the first half is right; the second
half is incomplete for the generic case, where capability is enabled by
the profile _by default_, not by validation.

### 8.2 Profile table staleness

`docs/architecture/printing.md`'s profile table lists
`generic-escpos-80` as `cols-42` / 42 Font A columns. `profiles.ts`
pins `defaultPaperWidth: 'cols-48'` and `fontAColumns: 48`. The doc is
stale since 037 Delivery 5 (F-015 unified 80 mm on 48 columns; the
receipt column oracle pins the 48-column layout).

### 8.3 What the docs get right

- The raster-probe note in `docs/architecture/printing.md` is accurate:
  `buildRasterDiagnosticBands()` is referenced from exactly one place,
  the `rasterProbe` request-body flag on the test-print route
  (`main/routes/printers.ts:475`); a repo-wide grep confirms no UI caller
  and no test sends it (§9).
- Arabic shaping: `shaping.arabic` is false in GENERIC and in LATIN
  (which spreads GENERIC); it is enabled only via the
  `arabicShapingOverride` (Settings "Printer supports Arabic/Persian
  shaping", off by default, described in `docs/printers.md` as correct
  for generic ESC/POS hardware) or an explicit request-body boolean
  (`main/routes/printers.ts:873, 1083`); the print-bill preview defaults
  the override to true when no printer is configured
  (`printers.ts:985`).
- `tests/print-parity.test.ts` (613 assertions green): the
  "skip unsupported scripts + emit warning" assertions are explicitly
  marked LEGACY — the multilingual print epic will deliberately replace
  silent skipping with an explicit capability model, and those assertions
  must be updated intentionally when that happens. That is the correct
  way to carry a known temporary contract; the raster assertions (§9)
  are the ones that hide a decision.

## 9. PF-07 — Test-suite observations

- **The suite enshrines the contradiction.** `tests/raster-printing.test.ts:107-108`
  asserts the baseline is raster-off AND every shipped profile is
  raster-on, in adjacent lines, without asserting the relation between
  them. `tests/thermal-capabilities.test.ts` asserts only that
  `generic.capabilities.raster.font` is `undefined`, never
  `raster.enabled`. There is no test that an unidentified printer must
  not receive raster, and no test that a known model does. Any Phase B
  decision on PF-01 must land with a test that asserts the chosen rule
  directly.
- **The raster diagnostic is untested and unreachable.**
  `buildRasterDiagnosticBands()` exists and the `rasterProbe` flag
  exists on the test-print route (`main/routes/printers.ts:475`), but a
  repo-wide grep finds no UI caller and no test sends it. It is the one
  in-tree mechanism that could verify, on real hardware, whether a
  printer implements GS v 0 — and it is not wired to anything an operator
  can reach. This is the natural first probe for the PF-01 decision.
- **Parity contracts are the strongest evidence in the phase.**
  `test:print-parity` (613 assertions) cross-checks the three render
  paths (backend ESC/POS, frontend WebUSB ESC/POS, browser HTML) for
  semantic equivalence, and the receipt column oracle (13/13) pins the
  emitted bytes. These two suites are what make the rest of this report
  trustworthy: the raster findings are about what the encoders choose to
  emit, not about a drift between renderers.
- **No test covers the PF-04 sequence** (fail → enqueue → manual
  success → worker pass). The queue suite's worker tests inject
  dispatchers and never interleave a manual print between enqueue and
  execution.

## 10. Classification

Per the assignment, every audited item is exactly one of PASS
(verified by a named test actually run), CONDITIONAL (supported only
under a stated condition), or UNVERIFIED (requires physical printer
validation). Every hardware-dependent item is UNVERIFIED.

| Area | Classification | Basis |
| --- | --- | --- |
| Receipt layout v3 (column oracle, byte-identical) | **PASS** | `test:receipt-column-oracle` 13/13, golden unchanged |
| Receipt column width | **PASS** | `test:receipt-column-width` 4/4 |
| Print parity across renderers | **PASS** | `test:print-parity` 613 assertions |
| Currency symbol on printed receipts (stored symbol wins) | **PASS** | `test:issue-266-currency-symbol-print` 8/8 |
| KOT printed marker (F-004) | **PASS** | `test:kot-print-queue` 119/119 + code trace §6.1 |
| KOT line wrapping (F-016) | **PASS** | `test:kot-line-wrap` 22/22 |
| KOT order notes | **PASS** | `test:kot-order-notes` passed |
| Queue / retry / backoff (KOT) | **PASS** | `test:kot-print-queue` 119/119 + worker code |
| Queue / retry (receipts) | **CONDITIONAL** | Queue works, but the PF-04 duplicate window is open |
| `printed_at` only on confirmed dispatch (F-026) | **PASS** | `test:bill-printed-at` 16/16 + `receipt.ts:129` |
| Bill print warnings (F-017 lineage) | **PASS** | `test:bill-print-warnings` 17/17 |
| WebUSB deterministic printer selection (F-027) | **PASS** | `test:webusb-printer-selection` 15/15 |
| Windows print failure detail / stderr (issue #789) | **PASS** | `test:thermal-capabilities` bundle green |
| Network print chunking | **PASS** | `test:thermal-capabilities` bundle green |
| Printer error toast clarity | **PASS** | `test:thermal-capabilities` bundle green |
| Menu printing / print-menu selection | **PASS** | `test:menu-printing` 10/10; `test:printer` menu suite passed |
| Print kernel / language settings | **PASS** | `test:print-kernel` bundle green |
| Print document / receipt logo (structure) | **PASS** | `test:print-document` 46 checks + logo suite passed |
| Merchant print templates | **PASS** | `test:merchant-print-templates` 38 checks |
| Delivery slip | **PASS** | `test:delivery-slip` 50/50 |
| Printer settings / width refresh / migrations | **PASS** | `test:printing-settings` 27/27; `test:printer-width-refresh` 3/3; `test:printer-migrations` 8/8 |
| Bills print API | **PASS** | `test:bills-print-api` 34/34 |
| Print labels | **PASS** | `test:print-labels` 151 passed |
| Printing + KDS resilience (issue suites) | **PASS** | `test:issue-printing-and-kds-resilience` 19/19 |
| Printer API / IPC surface | **PASS** | `test:printer` (460 + 94/94 + IPC schema match) |
| Financial rows never silently omitted — native path | **PASS** | Refusal pinned; 0 bytes emitted, verified by probe |
| Financial rows never silently omitted — raster path | **CONDITIONAL** | Holds only if the printer implements GS v 0 (PF-01) |
| Receipt logo raster | **CONDITIONAL** | Emitted even with raster disabled on the native-fallback caps (PF-02) |
| `whole-receipt` raster mode | **UNVERIFIED** (in production) | No production caller (PF-03) |
| Raster diagnostic probe | **UNVERIFIED** | No UI caller, no test |
| Arabic output on real generic hardware | **UNVERIFIED** | Requires a physical printer |
| Real Raster (GS v 0) compatibility | **UNVERIFIED** | Requires a physical printer |
| Paper cutting (`cutMode`) | **UNVERIFIED** | Declared in profiles; no hardware to cut |
| Cash drawer pulse (ESC p) | **UNVERIFIED** | Kick path exists in code; no drawer to pulse |
| USB device behaviour (WebUSB) | **UNVERIFIED** | Requires a physical USB printer |
| Network printer behaviour on a real LAN | **UNVERIFIED** | Requires a physical network printer |
| Z-report print (cash-closures §15) | **UNVERIFIED** here | Pre-existing failure, out of the §2 list; recorded as-is |

## 11. Locked behaviour — verified unchanged

These are the assignment's red lines, checked at the baseline; none moved
in this phase (Phase A changed no code at all).

- **Receipt layout v3** (follow-ups 43/48): header fields two per line
  in fixed slots; items table order الصنف – إفرادي – العدد – المبلغ;
  totals order subtotal → fees → post-fee total only when a discount
  exists → discount → grand total; fee lines like «(5%)»; stored
  `currency_symbol` wins everywhere (SYP prints as `SYP` after the
  amount, never as £); no payment block on the built-in customer bill;
  footer «Rest&Cafe System Powered by Ali.J» on every surface. The
  oracle passing 13/13 with an unchanged golden is the evidence.
- **Syria fee model** (locked): consumption fee document-level with
  ceiling rounding; local administration is a percentage OF the
  consumption fee; discount deducted AFTER fees. Untouched.
- **F-R2-2** (an item refund includes that item's consumption-fee
  share): correct by owner decision, untouched.
- **`printed_at` only on confirmed dispatch** (037 D5): verified in
  §6.1, `test:bill-printed-at` 16/16.
- **Windows-only, local-only, Arabic-first receipts, SYP/USD only,
  Latin digits.** No cloud, no paid service, no telemetry introduced.

## 12. What Phase A did not do, and what Phase B needs

Phase A stops here. The hand-back is this file only (plus the
start-announcement status file, per the standing announce rule). No
Phase B work starts until Ted's decision file names the approved fix
list.

Candidate inputs for Ted's Phase B decision, in the order this audit
would prioritize them:

1. **PF-01** — decide the generic-raster rule (one of the three options
   in §3.5). Any option must land with a test asserting the chosen rule
   directly (`raster-printing.test.ts:107-108` must stop pinning both
   sides) and with the `docs/architecture/printing.md` /
   `docs/printers.md` text rewritten to match.
2. **PF-04** — receipt duplicate window: `printed_at` check before
   executing a queued receipt job, or cancellation of pending receipt
   jobs on manual print success, with a test reproducing the exact
   fail → enqueue → manual success → worker pass sequence.
3. **PF-02** — gate logo emission on `raster.enabled` (or
   `widthDots > 0 AND enabled`), and make the suppression explicit.
4. **PF-03** — either wire `whole-receipt` to a real opt-in (the raster
   probe would be the natural place to exercise it) or remove the mode
   from the shipped profiles.
5. **PF-05** — decide whether the crash windows need any mitigation; no
   change is proposed by this audit.
6. **PF-06 / PF-07 / PF-08** — docs and matrix corrections belong in
   Phase C, but the PF-01 doc rewrite must travel with the PF-01 fix,
   not wait for Phase C, or the docs will describe a behaviour the code
   no longer has.

No recommendation is made here about SOFTWARE-CLOSED / NOT CLOSED —
that is Phase C, and Ted decides.

## Appendix — evidence locations

- **Battery logs:** `~/workspace/rest-cafe-docs/printing-finalization-a-2026-11-10/logs/`
  (per-command logs named after the npm script, plus `summary.tsv`).
- **Scratch probe** (not a test, not shipped):
  `~/workspace/rest-cafe-docs/printing-finalization-a-2026-11-10/probe-generic-raster.ts`
  and `probe-generic-raster.log`. It stands in for the Chromium renderer
  with a stub and measures only what the system asks the renderer to do
  and what the native path does.
- **Supplementary xvfb run:** `logs/test-raster-electron-xvfb.log`
  (exit 0, 2026-11-10 15:03 +03).
- **Environment notes:** no EPERM or write fault occurred in this
  phase; all local git and test writes succeeded (the D2 EPERM fault did
  not recur). `xvfb-run` and `Xvfb` are present at `/usr/bin` on this
  host.
- **D5 pre-existing evidence for the Electron failure:**
  `~/workspace/rest-cafe-docs/auditfix-d5-2026-11-02/10-battery-test:raster.log`
  and `12-raster-base-commit.log` (2026-11-02).
