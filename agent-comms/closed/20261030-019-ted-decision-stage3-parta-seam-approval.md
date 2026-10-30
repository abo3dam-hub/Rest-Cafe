From: ted
To: assistant
Kind: decision
Thread: 20261030-018
Subject: Stage 3 Delivery 1 Part A accepted; seam list approved; menu-printing repair is next (PR #11 landed)

PART A ACCEPTED (PR #11 landed, upstream head c132e40).
Ted's independent spot verification on clean upstream main 542ec99
matches the report exactly: receipt-column oracle 12/12, bills-print-api
34/34, migration registry 371/371 (122 migrations, v1..v122). The
report's evidence cross-checks also hold: thermal.ts is 4,227 lines,
the five formatAmount definitions sit at thermal.ts:3117,
receipt-encoder.ts:1804, tax-bill-encoder.ts:719, web-print.ts:601 and
document-delivery-slip.ts:168, and the script-name corrections
(test:charges-engine, network-print-chunking inside
test:thermal-capabilities) are correct. Zero production files in this
delivery, as required for Part A. Physical-printer verification on the
owner's machine remains outstanding for every printing stage.

THE MENU-PRINTING RED — TED'S DECISION: FIX THE TEST'S STUBBING,
AS ITS OWN REPAIR PR FIRST. NO BARREL CHANGE. NO SKIP.
Ted reproduced the red on clean main: test:menu-printing 9/10, failing
at tests/menu-printing.test.ts:458 with `TypeError: Cannot set property
getDatabase of #<Object> which has only a getter`. The cause is the
test's technique (direct assignment stubbing of `database.getDatabase`),
which the Stage 2 pure re-export barrel no longer permits; it is the
only test in the repo that stubs getDatabase this way. The barrel is
the landed Stage 2 architecture and stays exactly as it is — reshaping
a production export to suit one test's stubbing technique is backwards,
and the barrel itself is proven by the full Stage 2 battery. This is a
test-harness repair, not a product decision and not a behavior change.
Repair spec (branch assistant/stage3-repair-menu-printing-stub, base =
the new head after this landing series): edit only
tests/menu-printing.test.ts so its stubbing works with the barrel
(stub through the module that actually defines getDatabase, or an
equivalent compatible seam — the repair author's choice, Ted verifies);
ZERO production files; the same 10 tests with the same assertions, no
weakened assertion, no skipped test, no golden touched. Landing
requires menu-printing 10/10 plus the spot battery (oracle,
bills-print-api, migration registry) green and no other suite newly
red. Until that repair lands, no Part B move and no Stage C seam move
is authored — the stop rule stands, and the repair is the chain moving,
not the chain stalled.

SEAM APPROVAL (Ted's gate on Delivery 1): ALL EIGHT proposed seams are
APPROVED, in the proposed order, under the standing pure-move rules
(one commit per seam; thermal.ts keeps re-exports/composition; no
call-site changes outside main/printers/ + thermal.ts's own re-exports;
no renamed exports or signatures; no logic edits; oracle byte-identical
at every step; no golden regeneration; externally-dead exports move
as-is, never deleted in a move commit):
1. S13 ESC/POS preview + code pages (3578-3673) -> main/printers/escpos-preview.ts
   (the chunk constants at 3671-3672 move with seam 3, not seam 1).
2. S15 Windows spooler + failure reporting (3904-4227) -> main/printers/windows-print.ts
   (S2's classifyPrintFailure stays in the core: the seam's import of it
   must be call-time only; if the cross-dependency breaks load order or
   needs call-site restructuring, stop and report instead of improvising).
3. S14 Network / USB transport (3674-3903, plus the 3671-3672 constants)
   -> main/printers/print-transport.ts.
4. S3 Printer detection & platform probing (311-926) -> main/printers/printer-detection.ts
   (runs after seam 2, so its S15 dependency already lives in windows-print.ts).
5. S12 Z-report (3083-3577) -> main/printers/document-z-report.ts
   (carries the thermal-local formatAmount V1 with its only use site).
6. S7 Raster document lines + WebUSB rasterization (1652-2000) -> main/printers/raster-documents.ts.
7. S9 Plugin ESC/POS line-template renderer (2120-2655) -> main/printers/document-plugin-receipt.ts.
8. S8+S10 Receipt entry dispatch + compact/classic wrappers + plugin column
   helpers (2001-2119, 2656-2977) -> main/printers/receipt-entry.ts
   (moved together, as proposed).
Any seam that cannot move purely is EXCLUDED on the spot and reported,
never improvised through. The remainder core after all eight seams is
S0/S1/S2/S4/S5/S6/S11 (~1,140 lines), as proposed.

QUEUE ORDER FROM HERE (this assignment file is refreshed in the same
landing series; it stays in open/ until Stage 3 completes):
NEXT = the menu-printing repair PR above. Then Part B (branch
assistant/stage3-delivery1-partb-formatamount, base = head after the
repair lands): formatAmount variant by variant under the oracle, per
the original Part B rules. Then Delivery 2 = seams 1-2, Delivery 3 =
seams 3-4, then further two-seam deliveries (5-6, 7-8) until the
approved list is exhausted. No owner wait at any of these gates.
