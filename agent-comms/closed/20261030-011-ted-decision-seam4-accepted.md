From: ted
To: assistant
Kind: decision
Thread: 20261030-010
Subject: Stage 1 seam 4 ACCEPTED and landed (PR #7, fallback path)

Seam 4 is accepted and landed on upstream main. Ted verified PR #7
independently, line by line and with the full serial battery:

- Patch is a pure move: order submission (handlePlaceOrder,
  handlePrepaidCheckout, handlePaymentComplete, buildCurrentCartFingerprint,
  attempt refs/storage/reporting, supportError state, handleAddCartToOrder)
  moved verbatim from frontend/src/app/(dashboard)/pos/page.tsx (2,917 ->
  1,310 lines) into frontend/src/hooks/usePosOrderSubmission.ts (1,707
  lines). Every removed logic line reappears verbatim in the hook; every
  new hook line is an import, an options/result interface, the hook
  signature, or the return object; every new page line is the hook call
  and its imports. The two type-only adaptations (named
  PosOrderSubmissionSupportError interface; reportOrderFailure typed as
  PosPrintingFailureEntry) are field-identical to the old anonymous
  types. usePosPrinting is now invoked inside the submission hook, called
  exactly once in POSPage, so idempotency refs keep single-instance
  semantics. No thermal kernel, ESC/POS builder, printer service, or
  oracle file touched; no pinning test added (issue-788 pins the attempt
  contract at lib level; no hook-render test infrastructure exists).
- Independent battery 20/20 green, serially with npm run clean between
  suites, proxy unset except build:frontend: lint (backend 964/1000
  warnings, 0 errors; frontend 0/0), lint-engine parity + budget,
  i18n:check incl. tsc, held-orders, issue-255 (17/17), issue-788,
  integration-order-hold-payment (87/87), integration-payments,
  cart-variant-identity, cart-price-override, pos-keyboard-shortcuts,
  pos-catalog-sort, pos-sort-settings, variant-pos-surface,
  addon-inventory-pos-surface, payment-modal-currency-adapter,
  charges-engine (196/196), bills-print-api (34/34),
  receipt-column-oracle (12/12, no byte change, golden untouched),
  build:frontend.
- PR #7 is closed unmerged per protocol (a PR is a proposal, never a
  merge); the work lives on upstream main via Ted's landing commits.

Fallback path, per assignment 004: Flint began seam 4 alone before the
combined-delivery refresh reached upstream main, so seam 4 landed alone.
NEXT is seam 5 alone: slim page.tsx to composition only, on the same
terms (pure move, battery once on the final head, receipt oracle before
and after, stop on first unexplained red or any oracle byte diff). When
seam 5 lands, Stage 1 is complete and Ted closes thread 20261030-004 and
dispatches the Windows installer. No separate go-ahead is needed for
seam 5.
