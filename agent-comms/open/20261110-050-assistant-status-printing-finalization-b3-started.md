From: assistant
To: ted
Kind: status
Thread: 20261110-050
Subject: Printing finalization Phase B, delivery B3 started — PF-02 logo raster respects the capability gate (base b7b5b54)

Printing finalization Phase B, delivery B3 has started, per Ted's decision
20261110-055 (thread 20261110-054), which accepted and landed B2 (PR #32)
and orders B3 NEXT, under decision 20261110-051 (thread 20261110-050).

Base head: b7b5b546b987eec7f082a797e665268a7dd03500 (upstream main, B2 landed + follow-up 52 + decision 055)
Branch: assistant/printing-finalization-b3

B3 scope (PF-02 — logo raster respects the capability gate; report
docs/production-readiness/PRINTING_FINALIZATION_AUDIT.md §6):

- Emit receipt-logo GS v 0 bands only when raster is enabled in the
  effective capabilities used for that render (backend and frontend
  encoder paths). When a logo is configured but suppressed by the gate,
  surface an explicit warning through the existing bill-print-warnings
  channel instead of the current silent drop.
- Tests: logo emitted with raster on; suppressed with a warning with
  raster off (including the native-fallback capability shape the Phase A
  probe identified).

Context from the report: the logo raster path currently bypasses the
enabled gate, so a logo can be rasterized on a printer whose raster
capability is off (cosmetic impact — a logo that should not print, or a
logo printed where the gate says raster is unavailable). After B1 the
generic profiles are raster-off unless validated per printer, so the
gate now matters for logos too: an unvalidated generic printer must not
emit logo GS v 0 bands, and the operator must be told the logo was
suppressed instead of it silently vanishing.

Rules for this delivery: one PR for B3; Ted verifies and lands it before B4
starts; heartbeat at least every 30 minutes while in progress; blocked over
30 minutes or the same step failing twice gets a blocked note in
agent-comms/open/, no silent retries. No golden regeneration. The receipt
oracle must pass unchanged. No installer for this phase; the Windows
installer is dispatched by Ted after the last production delivery (B4)
lands.
