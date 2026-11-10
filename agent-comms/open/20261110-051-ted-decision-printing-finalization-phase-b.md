# Decision — Printing finalization Phase B: approved fix list (thread 20261110-050)

From: Ted (reviewer/gatekeeper). Date: 2026-11-10.
Phase A (PR #30) is ACCEPTED and landed: announce `b9d4e12`, report `6f69757`,
landing/index commit `2dde2cd` (follow-up 50 in
`docs/IMPLEMENTATION_REPORT_AR.md`). Ted's independent spot battery on clean
main matched the report: receipt-column-oracle 13/13 byte-identical,
bills-print-api 34/34, migration-registry 386/386 (127 migrations); PF-01 to
PF-04 mechanisms re-verified in code by Ted. The `test:raster` Electron half
stands as NOT RUN (environment), with your xvfb run recorded as supplementary
evidence only.

Phase B is now open. Rules: one PR per delivery, in the order below; Ted
verifies and lands each before the next starts; heartbeat at least every
30 minutes while a delivery is in progress; blocked >30 min or the same step
failing twice → blocked note in `agent-comms/open/`, no silent retries. No
golden regeneration. The receipt oracle must pass unchanged unless a delivery
below explicitly says otherwise (none does).

## Two corrections to the Phase A report (record, do not amend the report file)

1. §3.1 table names two branded profiles that do not exist ("Xprinter
   XP-80C", "Epson TM-T20III"). The real profiles are
   `xprinter-xp-v320m-v330m` (XP-V320M / XP-V330M) and `epson-tm-series`
   (TM Series). The capability values were correct; the names were not.
2. The §7 E04 correction is itself stale: the registry is 127 migrations,
   386/386 — not 124 / 377. Phase C must take the counts current at its own
   landing time.

## B1 — PF-01: generic raster becomes a validated opt-in (OWNER DECISION)

Ali decided on 2026-11-10: **option 2** from report §3.5. The rule to
implement, exactly:

- Both generic profiles (`generic-escpos-80`, `generic-escpos-58`) revert to
  the conservative baseline raster value: `enabled: false, widthDots: 0,
  maxBandHeight: 0, modes: []`. An unidentified printer fails closed exactly
  as the native path does today (financial Arabic rows → refusal with the
  existing message; non-financial → existing skip/warning policy).
- Raster may be enabled **per printer** only after validation: the owner runs
  a raster test print for that printer from the printer settings, the test
  print renders Arabic financial-style sample lines through the GS v 0 path,
  and the owner explicitly confirms in the UI that the lines printed
  correctly. Only then is a persisted per-printer validated flag set, and
  only for that printer does its effective capability gain raster (with the
  generic profile's width for its paper size: 576 for 80 mm, 384 for 58 mm).
- The existing `rasterProbe` diagnostic on the test-print route
  (`main/routes/printers.ts`) currently has no UI caller — wire the settings
  test-print flow to it or build the equivalent on the same route surface;
  do not invent a parallel print path. Reuse the codebase's existing
  validated-profile concept (see `rasterWebUsbPathEnabled`, which already
  distinguishes a 'validated-profile' source on the WebUSB path) and align
  the semantics instead of creating a second vocabulary.
- Branded profiles (Xprinter, Epson TM) keep their declared raster values
  unchanged — they are named models the project asserts.
- Scope notes: the validation flag lives with the printer's stored
  configuration (same store the profile/paper settings use); changing the
  printer's identity/profile resets validation. New UI strings go to
  `frontend/src/lib/i18n/messages/ar.json` and `en.json` only.
- Tests (required): replace the both-sides pin at
  `tests/raster-printing.test.ts:107-108` with assertions of the DECIDED
  rule — baseline off; every generic profile off by default; a validated
  generic printer's effective capability on; branded profiles on. Add
  coverage that an Arabic classic bill under an unvalidated generic profile
  is refused (0 bytes), and under a validated one produces raster requests
  as today. The printed bytes for the validated path must be identical to
  today's generic raster output; the oracle stays byte-identical with no
  golden regeneration.
- Docs travel with this fix (report §12.6): rewrite the raster/profile
  passages in `docs/architecture/printing.md` and `docs/printers.md` to the
  decided rule in the same PR, including the corrected printers.md
  financial-refusal guidance.

Owner also asked whether renaming the «المجموع» label to "TOTAL" would solve
PF-01. It would not, and labels stay Arabic: the subtotal and consumption-fee
rows are also Arabic financial rows, fee names are the official Arabic
tax-pack names on a locked Arabic-first receipt, and Arabic item names would
still be skipped or rasterized. Do not pursue label renaming.

## B2 — PF-04: queued receipt retry must not duplicate a manual reprint

- Implement ONE coherent mechanism: either an execution-time `printed_at`
  guard in the receipt path of the print worker, or cancellation of pending
  receipt jobs for a bill when a manual print of that bill succeeds — or
  both if the code shows they protect different windows. State the choice
  and why in the PR.
- Required test: reproduce the exact sequence — print fails → receipt job
  enqueued → manual reprint succeeds → worker pass → NO second print. Add
  it to the existing queue suite or a new suite wired into `package.json`.
- The frontend (localStorage) queue has the same window from its side:
  address it in this delivery, or scope it out explicitly in the PR with
  the reason and the residual risk stated.

## B3 — PF-02: logo raster respects the capability gate

- Emit receipt-logo GS v 0 bands only when raster is enabled in the
  effective capabilities used for that render (backend and frontend encoder
  paths). When a logo is configured but suppressed by the gate, surface an
  explicit warning through the existing bill-print-warnings channel instead
  of the current silent drop.
- Tests: logo emitted with raster on; suppressed with a warning with
  raster off (including the native-fallback capability shape your probe
  identified).

## B4 — PF-03: remove `whole-receipt` from the shipped profiles

- Remove `'whole-receipt'` from the `modes` of all four shipped profiles.
  Keep `encodeWholeReceiptRaster` and its unit test (synthetic
  capabilities) — the function is not the defect; the unexercised
  declaration on shipped profiles is. Update the profile passages in
  `docs/architecture/printing.md` accordingly.
- If B1's test rewrite touches the same assertions, sequence B4 after B1
  (the order above already does).

## Not approved / no change

- PF-05 (crash-window KOT duplicates): accepted as documented residual
  risk; no change. It is recorded in Phase C.
- PF-06/07/08 documentation and matrix corrections: Phase C, after B4
  lands — except the PF-01 doc rewrite, which travels with B1 as above.
- No verdict work in Phase B. Phase C (docs + matrix + your closure
  recommendation) opens with a separate decision after B4 lands. The
  Windows installer is dispatched by Ted after the last production
  delivery (B4) lands.

Start with B1. Announce the branch in `agent-comms/open/` as usual.

## Status (2026-11-10): B1 landed, B2 NEXT

B1 (PF-01) landed on upstream main at `7d204cd` (PR #31 closed unmerged; Ted battery 43 commands, 42 exit 0, test:raster Electron half NOT RUN — Xvfb supplementary exit 0; oracle 13/13 byte-identical; registry 389/389, 128 migrations). Decision `20261110-053` accepts B1 and closes thread 052. B2 (PF-04) is NEXT — start with B2. Announce the branch in `agent-comms/open/` as usual. No installer until B4 lands.

## Status (2026-11-10): B2 landed, B3 NEXT

B2 (PF-04) landed on upstream main at `d8d89dd` (PR #32 closed unmerged; Ted battery 36 commands, 35 exit 0, test:raster Electron half NOT RUN — Xvfb supplementary exit 0; oracle 13/13 byte-identical; registry 389/389, 128 migrations; kot-print-queue 146/146). Decision `20261110-055` accepts B2 and closes thread 054. B3 (PF-02, logo raster respects the capability gate) is NEXT — start with B3. Announce the branch in `agent-comms/open/` as usual. No installer until B4 lands.

## Status (2026-11-10): B3 landed, B4 NEXT

B3 (PF-02) landed on upstream main at `5ba440a` (PR #33 closed unmerged; Ted battery 36 commands, 35 exit 0, test:raster Electron half NOT RUN — Xvfb supplementary exit 0; oracle 13/13 byte-identical; registry 389/389, 128 migrations; print-document 46 checks, receipt-logo §6–§7 green). Decision `20261110-057` accepts B3 and closes thread 056. B4 (PF-03, remove `whole-receipt` from the four shipped profiles) is NEXT — start with B4. Announce the branch in `agent-comms/open/` as usual. No installer until B4 lands.
