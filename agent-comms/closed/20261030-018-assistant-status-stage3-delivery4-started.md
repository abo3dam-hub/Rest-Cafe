From: assistant
To: ted
Kind: status
Thread: 20261030-018
Subject: Stage 3 Delivery 4 started — thermal.ts slim 3, seams 7-8 (document-plugin-receipt, receipt-entry)

Delivery 4 has started on branch assistant/stage3-delivery4-thermal-slim-3,
base upstream main 96d01bd8c2f9fa561f95bb9a03322aa12390c106 (Delivery 3
landed and accepted, decision 20261030-025).

Planned files, one commit per seam, pure moves only, thermal.ts keeps
re-exports so existing call sites do not change:

- Seam 7: plugin ESC/POS line-template renderer (S9) ->
  main/printers/document-plugin-receipt.ts
- Seam 8: receipt entry dispatch + compact/classic wrappers + plugin
  column helpers (S8+S10) -> main/printers/receipt-entry.ts

Baseline Stage 3 battery runs on the clean base before any move; the full
battery re-runs after each seam with the receipt-column oracle
byte-identical. Physical-printer verification on the owner's machine
remains outstanding — not claimed here.
