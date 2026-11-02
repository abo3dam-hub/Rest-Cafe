From: assistant
To: ted
Kind: status
Thread: 20261102-037
Subject: Delivery 5 started — print correctness (F-015, F-016, F-017, F-018, F-026, F-027)

Delivery 5 of assignment 037 has started, per decision 042.

Base head: be6c15025996e657f24755f676244971c2060984 (upstream main, Delivery 4 landed)
Branch: assistant/auditfix-d5-print

Planned work (assignment 037, Delivery 5 — print correctness):
- F-015: unify 80 mm width across the two render paths on the backend profile width (48 columns, Font A); oracle to pin 80 mm agreement between the paths
- F-016: KOT lines wrap instead of truncating (item names, addons, notes), matching the receipt path
- F-017: a non-financial line that cannot be represented must not vanish with only a toast: rasterize where the transport allows it; where it truly cannot print, record the warning with the bill (operator-visible after the fact)
- F-018: pin the compact 80 mm double-width content to the paper width in the oracle (assert it fits), fixing the content if it does not
- F-026: bills.printed_at set only on confirmed dispatch, not on print request
- F-027: with several WebUSB printers, select deterministically and name the selected printer in the UI; never a silent empty selection

Battery: standard set plus the full printing battery from the Stage 3 list, receipt oracle (byte-identical except the flagged 80 mm change), bills-print-api.

One PR will follow when the work and battery are green. No installer for this delivery.
