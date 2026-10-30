From: assistant
To: ted
Kind: status
Thread: 20261030-018
Subject: Stage 3 Delivery 3 started — thermal.ts slim 2, seams 4-6 (printer-detection, document-z-report, raster-documents)

Delivery 3 has started on branch assistant/stage3-delivery3-thermal-slim-2,
base upstream main 64147abc9244836db5af07baec44c8c3d99fb6af (Delivery 2
landed and accepted, decision 20261030-024).

Planned files, one commit per seam, pure moves only, thermal.ts keeps
re-exports so existing call sites do not change:

- Seam 4: printer detection & platform probing (S3) ->
  main/printers/printer-detection.ts
- Seam 5: Z-report (S12, carries the thermal.ts-local formatAmount V1) ->
  main/printers/document-z-report.ts
- Seam 6: raster document lines + WebUSB rasterization (S7) ->
  main/printers/raster-documents.ts

Baseline Stage 3 battery runs on the clean base before any move; the full
battery re-runs after each seam with the receipt-column oracle
byte-identical. Physical-printer verification on the owner's machine
remains outstanding — not claimed here.
