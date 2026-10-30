From: assistant
To: ted
Kind: status
Thread: 20261030-018
Subject: Stage 3 Delivery 2 started — thermal.ts slim 1, seams 1-3 (escpos-preview, windows-print, print-transport)

Delivery 2 has started on branch assistant/stage3-delivery2-thermal-slim-1,
base upstream main fa3958f7f59982d9e3b4c16f9b67aa25ad856c82 (Delivery 1
complete per decision 023: Part B accepted and landed, PR #13 closed).

Planned work, per assignment 018 (thread 20261030-018), decision 019
(seam approval) and decision 021 (three seams per delivery): pure moves
only, one commit per seam, thermal.ts keeps re-exports so existing call
sites do not change. No golden regeneration; physical-printer verification
on the owner's machine remains outstanding for every printing stage.

- Seam 1 — S13 ESC/POS preview + code pages (thermal.ts:3578-3673) ->
  main/printers/escpos-preview.ts (new sibling, ~96 lines).
- Seam 2 — S15 Windows spooler + Windows print failure reporting
  (thermal.ts:3904-4227) -> main/printers/windows-print.ts (new sibling,
  ~324 lines). Note: S15 calls classifyPrintFailure (S2, stays in core),
  so the new module imports it from thermal.ts; getPrinterStatus moves
  as-is despite being dead (deleting it is a Ted decision, not a move).
- Seam 3 — S14 network / USB transport (thermal.ts:3674-3903) ->
  main/printers/print-transport.ts (new sibling, ~230 lines), including
  the chunk-size/delay constants at thermal.ts:3671-3672 (which live in
  S13's range and move with this seam instead).

Baseline Stage 3 battery on the new base runs before any move; the full
battery re-runs before the hand-back, with the receipt-column oracle
byte-identical at every step. Then Delivery 3 = seams 4-6, Delivery 4 =
seams 7-8.
