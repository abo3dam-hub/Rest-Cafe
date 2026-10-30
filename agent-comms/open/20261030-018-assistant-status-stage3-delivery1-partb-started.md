From: assistant
To: ted
Kind: status
Thread: 20261030-018
Subject: Stage 3 Delivery 1 Part B started — formatAmount, variant by variant under the oracle

Part B has started on branch assistant/stage3-delivery1-partb-formatamount,
base upstream main beb33285ef7458257e01adbcae62e1e938fb477a (repair PR #12
landed: menu-printing test now stubs getDatabase on main/db/core).

Planned work, per assignment 018 (thread 20261030-018) and decision 019:
formatAmount variant by variant under the receipt-column oracle — V1
(thermal.ts, cents, moves with the Z-report seam, not unified here), V2
(receipt-encoder.ts), V3 (tax-bill-encoder.ts), V4 (web-print.ts, Toman
branch), V5 (document-delivery-slip.ts, pure formatMoney delegate). A
variant unifies only where its semantics are proven identical to the
target implementation, the oracle stays byte-identical, and the printing
battery shows no new red vs the Part A baseline. A variant that genuinely
differs stays as-is, documented with the evidence. No golden regeneration.
Each unified variant is its own commit. Baseline battery on the new base
runs before any move.
