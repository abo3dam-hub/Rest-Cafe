From: assistant
To: ted
Kind: status
Thread: 20261030-005
Subject: Stage 1 seam 2 done — usePosPrinting hook (assignment thread 20261030-004)

Seam 2 of assignment thread 20261030-004 is done as a pure move, one PR
per seam. Base: upstream/main 51d19d6. Branch:
assistant/stage1-seam2-printing. Local refactor commit 9f67e4a (remote
commits created through the Contents API carry different SHAs; file bytes
are verified identical before the PR opens).

What moved (verbatim, no behavior change):

- `printKotIfEnabled`, `fetchLatestBill`, and `printBillForTenant` moved
  out of `frontend/src/app/(dashboard)/pos/page.tsx` into the new hook
  `frontend/src/hooks/usePosPrinting.ts` (108 lines). In the hook:
  `printKotIfEnabled` at lines 41-66, `fetchLatestBill` at lines 68-71,
  `printBillForTenant` at lines 73-106. The hook reads its own
  `useTranslations('pos')`, `useAuthStore`, `usePosSettingsStore`, and
  `usePrinterStore` state, exactly as the page did.
- The page calls the hook at
  `frontend/src/app/(dashboard)/pos/page.tsx:828-830` and keeps the same
  names and signatures. Call sites are unchanged:
  lines 1429, 1895, 1897, 2278, 2309, and 2834.
- The page no longer defines the three helpers inline, no longer imports
  `isPrintCancelledOnTenantChangeError` or the KOT/receipt error-toast
  formatters, and no longer destructures `kotPrintingEnabled`,
  `autoPrintKot`, or `autoPrintBill` from the settings store. It keeps
  `printBill` from `usePrinterStore` for the direct call in
  `handleWsRequestBill`, which never went through the moved helpers.

One boundary decision, for the record: the helpers close over
`reportOrderFailure`, which owns the page's support-error state and is
called by many other handlers outside this seam. Moving that state into
the hook would have exceeded seam 2, so the hook takes
`reportOrderFailure` as its only option (typed as
`PosPrintingFailureEntry` in the hook file) and the page passes its
existing closure. Nothing else was parameterized, and no call site
changed shape. No thermal kernel, ESC/POS builder, printer service, or
oracle file was touched.

Verification (full protecting battery, serially, `npm run clean`
between suites, proxy unset except `build:frontend`, logs under
`~/workspace/rest-cafe-docs/stage1-seam2-2026-10-30/`): 20/20 green.
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
formatter over the two staged files and made no additional changes: the
committed diff is exactly the working diff, no wholesale normalization.

Physical printer verification is outstanding (owner's machine), as with
every printing change; nothing here claims it.

Next: seam 3 (`usePosTableWorkspace`) opens after seam 2 lands and the
assignment file is refreshed. No seam 3 work is in this PR.
