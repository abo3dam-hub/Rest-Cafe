# Decision — Printing finalization B3 accepted; B4 is NEXT (thread 20261110-056)

From: Ted (reviewer/gatekeeper). Date: 2026-11-10.

## B3 — PF-02 logo raster respects the capability gate: ACCEPTED and landed

Flint PR #33 (`assistant/printing-finalization-b3`, base `b7b5b54`, head
`be0c1fe`) is verified and landed on upstream main, final head `5ba440a`
(all 8 commits in original order, one file per fix commit; landed tree
byte-identical to the fork head, empty diff). PR commented and closed
unmerged per protocol.

Ted's independent verification (staged tree at PR head, serial battery,
`npm run clean` between suites, proxy unset except `build:frontend`):
36 commands, 35 exit 0. The single exit 1 is `test:raster`, Electron
half only — `Missing X server or $DISPLAY`, pre-existing environment
issue (same as D5 / Phase A / B1 / B2); the ts-node half passed, and a
supplementary Xvfb run exited 0. Receipt-column oracle 13/13
byte-identical with no golden regeneration; bills-print-api 34/34;
migration-registry 389/389 (128 migrations, v1..v128); printer 460 +
printer-api 112/112; print-parity 613 assertions; kot-print-queue
146/146; bill-print-warnings 17/17; bill-printed-at 16/16;
print-document 46 checks (receipt-logo suite §6–§7 all green); lint
830 backend + 1 frontend warnings (identical to the B2 baseline),
0 errors; lint-engine, i18n:check, build, build:frontend green;
docs:check green (policy warnings pre-existing, none in B3 docs);
diff-check clean.

Scope confirmed against decision 051: receipt-logo GS v 0 bands are
emitted only when `rasterCapabilityEnabled` holds for the effective
capabilities, on both render paths — backend classic via
`renderBillDocumentToClassicLines` (new optional `warnings` sink on
`ClassicDocumentRenderOptions`, passed through by
`renderClassicReceiptViaDocument` into the warnings
`prepareReceipt`/`printReceipt` already return) and merchant templates
via the same classic lines, and the frontend classic + compact
encoders (`buildClassicReceiptBytes` / `buildCompactReceiptBytes`,
warnings collected by `usePrinter.ts` into `encoderWarnings` and
returned from `printBill`). A configured logo suppressed by the gate
produces exactly one `configuration` warning via the shared
`makeLogoRasterSuppressedWarning()` in `shared/print/warnings.ts`
(field `receipt logo`) — a warning, never a refusal, since the logo
is non-financial and the receipt still prints. `buildBillDocument`
still attaches `logoRaster` when configured (the document model stays
capability-agnostic); the backend compact renderer has no logo path.
Tests pin the gate on both sides: raster on emits with no warning;
native-fallback caps, the strict generic baseline, and no capabilities
at all each suppress with exactly one warning.

Disclosure recorded in follow-up 53: `main/printers/document-merchant.ts`
was wholesale-normalized by the pre-commit formatter hook (a
never-formatted file) — import collapsing plus line reflows in `finish`
and the `renderDocument` / `applyMerchantTemplate` calls, whitespace
only; the only semantic change in that file is the `warnings`
pass-through in `renderDocument`. Physical-printer verification remains
outstanding on the owner's machine — no hardware-print claim is made.

No installer for B3 (installer after B4, per decision 051).

## Next: B4 (PF-03) is NEXT

B4 — remove `'whole-receipt'` from the `modes` of all four shipped
profiles; keep `encodeWholeReceiptRaster` and its unit test; update
the profile passages in `docs/architecture/printing.md` accordingly —
starts now, per decision 051. One PR, Ted verifies and lands it before
Phase C opens. Announce the branch in `agent-comms/open/` as usual.
