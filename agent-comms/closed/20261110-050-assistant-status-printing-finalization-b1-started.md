From: assistant
To: ted
Kind: status
Thread: 20261110-050
Subject: Printing finalization Phase B, delivery B1 started — PF-01 generic raster validated opt-in (baseline 7658e76)

Printing finalization Phase B, delivery B1 has started, per Ted's decision
20261110-051 (thread 20261110-050), which accepted and landed Phase A
(PR #30) and opens Phase B. Start with B1.

Base head: 7658e76b937a9b8dbc19ee8724404b22bf9ba4ca (upstream main, Phase B decision 051)
Branch: assistant/printing-finalization-b1

B1 scope (PF-01 — generic raster becomes a validated opt-in; owner decision:
option 2 from report §3.5):

- Both generic profiles (generic-escpos-80, generic-escpos-58) revert to the
  conservative baseline raster value: enabled: false, widthDots: 0,
  maxBandHeight: 0, modes: []. An unidentified printer fails closed exactly
  as the native path does today (financial Arabic rows refused with the
  existing message; non-financial rows follow the existing skip/warning
  policy).
- Raster may be enabled per printer only after validation: the owner runs a
  raster test print for that printer from the printer settings, the test
  print renders Arabic financial-style sample lines through the GS v 0 path,
  and the owner explicitly confirms in the UI that the lines printed
  correctly. Only then is a persisted per-printer validated flag set, and
  only for that printer does its effective capability gain raster (generic
  profile width for its paper size: 576 for 80 mm, 384 for 58 mm).
- The existing rasterProbe diagnostic on the test-print route
  (main/routes/printers.ts) currently has no UI caller — wire the settings
  test-print flow to it or build the equivalent on the same route surface;
  do not invent a parallel print path. Reuse the codebase's existing
  validated-profile concept (rasterWebUsbPathEnabled, which already
  distinguishes a 'validated-profile' source on the WebUSB path) and align
  the semantics instead of creating a second vocabulary.
- Branded profiles (Xprinter, Epson TM) keep their declared raster values
  unchanged — they are named models the project asserts.
- The validation flag lives with the printer's stored configuration (same
  store the profile/paper settings use); changing the printer's
  identity/profile resets validation. New UI strings go to
  frontend/src/lib/i18n/messages/ar.json and en.json only.
- Tests (required): replace the both-sides pin at
  tests/raster-printing.test.ts:107-108 with assertions of the DECIDED rule
  — baseline off; every generic profile off by default; a validated generic
  printer's effective capability on; branded profiles on. Add coverage that
  an Arabic classic bill under an unvalidated generic profile is refused
  (0 bytes), and under a validated one produces raster requests as today.
  The printed bytes for the validated path must be identical to today's
  generic raster output; the oracle stays byte-identical with no golden
  regeneration.
- Docs travel with this fix (report §12.6): rewrite the raster/profile
  passages in docs/architecture/printing.md and docs/printers.md to the
  decided rule in the same PR, including the corrected printers.md
  financial-refusal guidance.
- Labels stay Arabic: renaming «المجموع» to "TOTAL" would not solve PF-01
  and is not pursued.

Rules for this delivery: one PR for B1; Ted verifies and lands it before B2
starts; heartbeat at least every 30 minutes while in progress; blocked over
30 minutes or the same step failing twice gets a blocked note in
agent-comms/open/, no silent retries. No golden regeneration. The receipt
oracle must pass unchanged. No installer for this phase; the Windows
installer is dispatched by Ted after the last production delivery (B4)
lands.
