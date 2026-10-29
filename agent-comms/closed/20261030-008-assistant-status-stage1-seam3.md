From: assistant
To: ted
Kind: status
Thread: 20261030-008
Subject: Stage 1 seam 3 done — usePosTableWorkspace hook (assignment thread 20261030-004)

Seam 3 of assignment thread 20261030-004 is done as a pure move, one PR
per seam. Base: upstream/main 3b425fb2c2c8215b730cb3393c632098626895d1.
Branch: assistant/stage1-seam3-tables. The seam start was announced on
this branch first (thread 20261030-007, in assignment thread
20261030-004). Local refactor commit follows this status file; remote
commits created through the Contents API carry different SHAs, and file
bytes are verified identical before the PR opens.

What moved (verbatim, no behavior change):

- The cashier table workspace binding moved out of
  `frontend/src/app/(dashboard)/pos/page.tsx` into the new hook
  `frontend/src/hooks/usePosTableWorkspace.ts` (155 lines):
  `wsParams` query capture at lines 45-54, the re-read effect at
  lines 55-64, `wsTable`/`wsOrder`/`wsBillBusy`/`wsInitRef` at lines
  66-69, the workspace entry effect at lines 71-104,
  `handleWsRequestBill` at lines 106-143, and `goWsTable` at lines
  145-152. The hook reads its own `useTranslations('pos' | 'common' |
  'tables')`, `useAuthStore`, `useCartStore`, and `usePrinterStore`
  state, exactly as the page did.
- The page calls the hook at
  `frontend/src/app/(dashboard)/pos/page.tsx:2100-2105` and keeps the
  same names. Call sites are unchanged: the workspace banner and hall
  list in the JSX, and `handleAddItemsToOrder` passed in as before.
- The page no longer defines the workspace state/effects/handlers
  inline, no longer destructures `printBill` from `usePrinterStore`,
  and no longer imports `showPrintWarningsToast` (both now used only
  inside the hook). It keeps the `usePrinterStore` import for
  `usePrinterStore.getState()` in the print-menu path.

Boundary decisions, for the record:

- The hook takes `tables`, `refreshTables`, and
  `handleAddItemsToOrder` as its options. `tables`/`refreshTables`
  stay page-owned: the table list is populated by the page's initial
  load effect together with categories, products, and held orders,
  and `refreshTables` is called by many other handlers. Moving either
  would have exceeded seam 3.
- `handleAddItemsToOrder` stays page-local for the same reason: it
  owns `pendingOrder` (seam 4's append-mode state) and is also the
  `onAddItems` path of the table checkout modal. The hook calls the
  page's existing closure during workspace entry, exactly as the page
  did. Nothing else was parameterized, and no call site changed
  shape. The table-picker handlers (`handleSelectAvailableTable`,
  `handleSelectOccupiedTable`, `handleSelectHeldTable`,
  `handleHoldTable`) and `handleAddCartToOrder` were NOT moved: they
  belong to the picker/checkout modals and to order submission
  (seam 4), not to the query-string workspace binding.
- No thermal kernel, ESC/POS builder, printer service, or oracle
  file was touched.

Verification (full protecting battery, serially, `npm run clean`
between suites, proxy unset except `build:frontend`, logs under
`~/workspace/rest-cafe-docs/stage1-seam3-2026-10-30/`): 20/20 green.
lint (backend 964 warnings / 0 errors, frontend 0/0); lint-engine
parity plus lint budget (964/1000 backend, 0/5 frontend); `i18n:check`
including tsc and the print-labels drift check; held-orders;
issue-255 (17/17); issue-788; integration-order-hold-payment (87/87);
integration-payments (11 passed); cart-variant-identity;
cart-price-override; pos-keyboard-shortcuts; pos-catalog-sort;
pos-sort-settings; variant-pos-surface; addon-inventory-pos-surface;
payment-modal-currency-adapter; charges-engine (196/196);
bills-print-api (34/34); receipt-column-oracle (12/12, no byte change —
green at the base before the move and green after, golden untouched);
`build:frontend` (static export green). The pre-commit hook ran the
formatter over the staged files and made no additional changes: the
committed diff is exactly the working diff, no wholesale normalization.

Physical printer verification is outstanding (owner's machine), as with
every printing-adjacent change; nothing here claims it. The workspace
bill-request path prints through the same `printBill` store call as
before the move.

Next: seam 4 (`usePosOrderSubmission`) unlocks automatically once seam 3
lands — no separate go-ahead needed, per assignment 004 and decision
20261030-006. No seam 4 work is in this PR.
