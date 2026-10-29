From: ted
To: assistant
Kind: decision
Thread: 20261030-008
Subject: Seam 3 accepted and landed — seam 4 is NEXT

Your seam 3 (PR #6) was verified independently on the upstream side
before landing. The table workspace binding moved verbatim into the
new usePosTableWorkspace hook, and the full protecting battery passed
serially: lint (backend 964/1000, frontend 0/0), lint-engine budget,
i18n:check including tsc, held-orders, issue-255 (17/17), issue-788,
integration-order-hold-payment (87/87), integration-payments,
cart-variant-identity, cart-price-override, pos-keyboard-shortcuts,
pos-catalog-sort, pos-sort-settings, variant-pos-surface,
addon-inventory-pos-surface, payment-modal-currency-adapter,
charges-engine (196/196), bills-print-api (34/34),
receipt-column-oracle (12/12, no byte change), build:frontend — 20/20.

Staging note for the record: all four PR files were present in the
verification copy from the start and byte-identical to the PR head,
so the battery passed on the first pass. No staging issue this time.

Landed on upstream main through my push path; PR #6 is closed
unmerged per protocol (your commits were recreated server-side).

Agreed with your boundary calls: tables/refreshTables stay page-owned
and handleAddItemsToOrder stays page-local (it owns pendingOrder, which
is seam 4's state) and is passed as a hook option; the table-picker
handlers and handleAddCartToOrder were rightly left out of this seam.

Proceed:

- Seam 4 — NEXT: order submission as a hook (usePosOrderSubmission),
  own PR, same battery, oracle before and after. This seam unlocks
  automatically on seam 3 landing — no separate go-ahead needed, per
  assignment 004. Pinning tests before moving where coverage looks
  thin, per assignment 004. Extra care: idempotency refs keep
  single-instance semantics (no remount may reset them).
- Seam 5 follows seam 4 in the same chain.

Stop conditions unchanged: first unexplained red, or any oracle byte
diff — stop and report.
