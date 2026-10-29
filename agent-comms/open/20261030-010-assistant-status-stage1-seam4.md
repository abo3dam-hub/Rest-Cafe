From: assistant
To: ted
Kind: status
Thread: 20261030-010
Subject: Stage 1 seam 4 done — usePosOrderSubmission hook (assignment thread 20261030-004)

Seam 4 of assignment thread 20261030-004 is done as a pure move, one PR
per seam. Base: upstream/main 8adb729837c2017a2f5bc4d681e391acab13367e.
Branch: assistant/stage1-seam4-submission. The seam start was announced
on this branch first (file agent-comms/open/20261030-004-assistant-status-
seam4-started.md, in assignment thread 20261030-004, per the assignment
file's announce rule). Local refactor commit follows this status file;
remote commits created through the Contents API carry different SHAs, and
file bytes are verified identical before the PR opens.

What moved (verbatim, no behavior change):

- Order submission moved out of
  `frontend/src/app/(dashboard)/pos/page.tsx` into the new hook
  `frontend/src/hooks/usePosOrderSubmission.ts` (1708 lines):
  `handlePlaceOrder` at lines 747-1054, `handlePrepaidCheckout` at lines
  1057-1591, `handlePaymentComplete` at lines 1682-1696, and
  `buildCurrentCartFingerprint` at lines 726-745. The page calls the
  hook at `frontend/src/app/(dashboard)/pos/page.tsx:580-604` and keeps
  the same handler names; call sites are unchanged (cart panel,
  prepaid checkout modal, payment modal, keyboard shortcuts).
- Attempt refs/storage/reporting moved with them: the prepaid,
  postpaid, and append-attempt refs at lines 137-149;
  `getAppendAttemptStorage` at lines 150-169; the postpaid
  read/save/clear helpers at lines 171-260; the prepaid
  strip/read/save/require/clear helpers at lines 262-349;
  `reportOrderFailure` at lines 351-394, `reportOrderStorageFailure` at
  lines 396-433, and `reportOrderRequestFailure` at lines 435-618;
  `newIdempotencyKey` at lines 620-623. The append-attempt replay
  effect (persisted attempt recovery on reload) moved at lines
  629-724. The `supportError` state moved into the hook (line 136); the page renders the returned `supportError` /
  `setSupportError` exactly as before. The hook reads the cart, held
  orders, auth, translations, currency formatting, and router state
  itself, as `usePosTableWorkspace` does.

Boundary decisions, for the record:

- `handleAddCartToOrder` moved too (lines 1594-1680). It lives entirely
  on the append-attempt storage, the attempt refs, and the failure
  reporters, and seam 3's hand-back recorded it as belonging to order
  submission (seam 4) rather than to the table workspace. The page's
  `TableCheckoutModal` still receives it under the same prop name.
- `usePosPrinting` is now invoked inside `usePosOrderSubmission`
  (lines 625-628) instead of directly by the page. Printing needs
  `reportOrderFailure`, and submission needs both the printing helpers
  and the reporting; calling the printing hook inside the submission
  hook is the only shape that keeps both dependencies one-way without
  passing half-built helpers through options. The page no longer calls
  `usePosPrinting` directly; the hook returns `printBillForTenant`
  for the `TableCheckoutModal` `onPrintBill` prop, the one remaining
  page-side use. `printKotIfEnabled` and `fetchLatestBill` stay
  internal: their only uses are inside the moved handlers.
- Page-owned state and callbacks arrive as hook options (the seam 3
  pattern): `pendingOrder` + setter (append mode, also owned by
  `handleAddItemsToOrder`, which stays page-local), `paymentBill` +
  setters, the modal setters (`setSubmitting`, `setMobileCartOpen`,
  `setShowPrepaidCheckout`, `setPrepaidModalAttempt`,
  `setCardTransactionIdRequired`), `refreshTables`, and
  `validateOrderPreflight`, which stays in the page because the
  keyboard shortcut's checkout path also calls it.
  `shouldTakePaymentNow` and `isServerRole` arrive as option values.
- Idempotency refs keep single-instance semantics: the hook is called
  exactly once, in `POSPage`, so its refs are created once per page
  instance exactly as the page's own refs were; no remount resets them.
  Nothing in the move replaces a damaged attempt with a fresh key.
- Two type-only adaptations, no behavior change: the support-error
  state shape is now the named `PosOrderSubmissionSupportError`
  interface (identical fields), and `reportOrderFailure` takes the
  shared `PosPrintingFailureEntry` type (identical shape to the page's
  former anonymous parameter type). Page-side cleanups forced by the
  move: the now-unused `user` destructure and `tExpenses` declaration
  were removed from the page; the page keeps its `PrepaidAttempt`
  type import for the prepaid modal attempt state.
- No pinning test was added. The attempt persistence/idempotency
  contract the hook relies on is already pinned at lib level by the
  issue-788 suite (in the battery), and this repo has no hook-render
  test infrastructure to pin ref identity with; the move is verbatim
  and the hook is called once per page render. The issue-788,
  integration-order-hold-payment, and integration-payments suites were
  run green at the base before the move, and the full battery after.
- No thermal kernel, ESC/POS builder, printer service, or oracle file
  was touched.

Verification (full protecting battery, serially, `npm run clean`
between suites, proxy unset except `build:frontend`, logs under
`~/workspace/rest-cafe-docs/stage1-seam4-2026-10-30/`): 20/20 green.
lint (backend 964 warnings / 0 errors, frontend 0/0 after removing the
now-unused `tExpenses` declaration in the page — the first post-move
lint run showed that one frontend warning, which was fixed and
re-run clean); lint-engine parity plus lint budget (964/1000 backend,
0/5 frontend); `i18n:check` including tsc and the print-labels drift
check; held-orders; issue-255 (17/17); issue-788;
integration-order-hold-payment (87/87); integration-payments
(11 passed); cart-variant-identity; cart-price-override;
pos-keyboard-shortcuts; pos-catalog-sort; pos-sort-settings;
variant-pos-surface; addon-inventory-pos-surface;
payment-modal-currency-adapter; charges-engine (196/196);
bills-print-api (34/34); receipt-column-oracle (12/12, no byte change —
green at the base before the move and green after, golden untouched);
`build:frontend` (static export green). The pre-commit hook ran the
formatter over the staged files; its only visible effect was joining
the hook's support-error `useState` onto one line. The committed tree
passes `oxfmt --check` on both files and was clean immediately after
the commit; no wholesale normalization of never-formatted files.

Physical printer verification is outstanding (owner's machine), as with
every printing-adjacent change; nothing here claims it. The KOT and
receipt print paths go through the same `usePosPrinting` helpers as
before the move.

Next: seam 5 (`page.tsx` to composition only) unlocks automatically
once seam 4 lands — no separate go-ahead needed, per assignment 004.
No seam 5 work is in this PR.
