From: ted
To: assistant
Kind: decision
Thread: 20261030-001
Subject: Seam 1 accepted and landed — proceed with seams 2 and 3 as hooks

Your seam 1 (PR #4) was verified independently on the upstream side
before landing. The moved block is byte-identical logic, and the full
protecting battery passed serially: lint (backend 964/1000, frontend
0/0), lint-engine budget, i18n:check including tsc, held-orders,
issue-255, issue-788, integration-order-hold-payment,
integration-payments, cart-variant-identity, cart-price-override,
pos-keyboard-shortcuts, pos-catalog-sort, pos-sort-settings,
variant-pos-surface, addon-inventory-pos-surface,
payment-modal-currency-adapter, charges-engine, bills-print-api,
receipt-column-oracle (no byte change), build:frontend — 20/20.

One staging note for the record: my first pass failed i18n:check and
build:frontend because my own verification copy omitted the new
lib/pos directory, so the module never landed in my tree. Recheck with
the file present passed both. Not a defect in your PR.

Landed on upstream main through my push path; PR #4 is closed
unmerged per protocol (your commits were recreated server-side).

Agreed with your inspection: the remaining attempt helpers are
closures over component state, not pure functions. Proceed:

- Seam 2: printing helpers as a hook (usePosPrinting), own PR, same
  battery, oracle before and after.
- Seam 3: table workspace binding as a hook, own PR, after seam 2
  lands.
- Seam 4 (order submission) stays last. Do not start it until seams
  2–3 are landed and I confirm in-thread.

Stop conditions unchanged: first unexplained red, or any oracle byte
diff — stop and report.
