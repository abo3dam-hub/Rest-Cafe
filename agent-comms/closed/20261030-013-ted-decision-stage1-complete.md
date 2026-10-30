From: ted
To: assistant
Kind: decision
Thread: 20261030-004
Subject: Stage 1 COMPLETE — seam 5 accepted and landed (PR #8, fallback path)

Stage 1 is complete. Ted verified PR #8 independently, line by line
and with the full serial battery:

- Patch is a pure move: the remaining page-local logic of
  frontend/src/app/(dashboard)/pos/page.tsx (1,310 -> 699 lines)
  moved verbatim into five new hooks in frontend/src/hooks/
  (usePosCatalog 185 lines, usePosFullscreen 69, usePosOrderAlert 56,
  usePosProductActions 141, usePosTableActions 186) and the remaining
  inline JSX moved verbatim into seven new default-export components
  in frontend/src/components/pos/ (PosSupportErrorBanner,
  PosWorkspaceBanner, PosTableRail, PosMobileCartDrawer,
  PosCustomerPromptModal, PosOrderAlertBanners, PosSoldOutModal).
  Every removed logic line reappears verbatim in a hook or component;
  every new line is an import, an options/result or props interface,
  a hook signature, a return object, or prop plumbing (setShowX(false)
  -> onClose, goWsTable -> onSelectTable, and the like). Keyboard
  wiring stayed in the page deliberately (declarative dispatch; ~25
  props to extract for no ownership gain); the anyModalOpen derived
  value moved up ahead of the product-actions hook call so its boolean
  can feed the scanner's enabled flag — a pure derived-const reorder.
  The lazy print-menu modal stays lazy (dynamic import untouched);
  no big-modal internals, no thermal kernel, no ESC/POS builder, no
  printer service, no oracle file touched. No pinning test added: the
  move is verbatim and adds no behavior; the POS-surface suites in the
  battery cover the moved surfaces.
- Independent battery 20/20 green, serially with npm run clean
  between suites, proxy unset except build:frontend: lint (backend
  964/1000 warnings, 0 errors; frontend 0/0), lint-engine parity +
  budget, i18n:check incl. tsc, held-orders, issue-255, issue-788,
  integration-order-hold-payment, integration-payments,
  cart-variant-identity, cart-price-override, pos-keyboard-shortcuts,
  pos-catalog-sort, pos-sort-settings, variant-pos-surface,
  addon-inventory-pos-surface, payment-modal-currency-adapter,
  charges-engine, bills-print-api, receipt-column-oracle (12/12, no
  byte change, golden untouched), build:frontend. The staging tree
  was verified file-by-file against the PR file list before running,
  and matched the fork branch head byte-for-byte on all 13 code files.
- PR #8 is closed unmerged per protocol (a PR is a proposal, never a
  merge); the work lives on upstream main via Ted's landing commits.

Stage 1 summary (all pure moves, no behavior change in any seam):
seam 1 usePosOrderAttempts (PR #4), seam 2 usePosPrinting (PR #5),
seam 3 usePosTableWorkspace (PR #6), seam 4 usePosOrderSubmission
(PR #7, fallback path — begun alone before the combined-delivery
refresh), seam 5 composition-only page (PR #8, fallback path — the
delivery that completes the stage). Thread 20261030-004 is closed by
this decision; thread 20261030-012 (seam 5 status) is closed with it.
The Windows installer is dispatched from main after this landing.
No further Stage 1 work remains under this assignment. Any next
workstream needs a new assignment file in open/ from Ted.
