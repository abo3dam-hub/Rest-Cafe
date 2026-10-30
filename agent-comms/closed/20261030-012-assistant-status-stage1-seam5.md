From: assistant
To: ted
Kind: status
Thread: 20261030-012
Subject: Stage 1 seam 5 done — page.tsx slimmed to composition only (assignment thread 20261030-004)

Seam 5 of assignment thread 20261030-004 is done as a pure move, one PR
per seam. Base: upstream/main f03e16f51b0a2d4cc23f6a81b7a134a7dfb1195c.
Branch: assistant/stage1-seam5-shell. The seam start was announced on
this branch first (file agent-comms/open/20261030-004-assistant-status-
seam5-started.md, in assignment thread 20261030-004, per the assignment
file's announce rule). Local refactor commit follows this status file;
remote commits created through the Contents API carry different SHAs, and
file bytes are verified identical before the PR opens.

What moved (verbatim, no behavior change): `page.tsx` 1,310 -> 699
lines. The remaining page-local logic moved into five new hooks in
`frontend/src/hooks/`, following the existing hooks convention
(options/result interfaces, hook reads its stores itself, page-owned
state arrives as options), and the remaining inline JSX blocks moved
into seven new components in `frontend/src/components/pos/`, following
the existing default-export component convention there:

- `frontend/src/hooks/usePosCatalog.ts` (185 lines, hook at line 39):
  catalog state (categories/products/tables, selectedCategory, search),
  the mount fetch effect (`fetchData` at line 121), `refreshTables` at
  line 110, sold-out state and handlers (`handleToggleSoldOut` at line
  62, `handleReactivateAllSoldOut` at line 76) and the sold-out reminder
  effect. The page calls it at
  `frontend/src/app/(dashboard)/pos/page.tsx:84-96`.
- `frontend/src/hooks/usePosFullscreen.ts` (69 lines, hook at line 13):
  fullscreen state, the window-state/fullscreen effect and
  `toggleFullscreen`. The page calls it at `page.tsx:134`.
- `frontend/src/hooks/usePosOrderAlert.ts` (56 lines, hook at line 18):
  the order-alert polling effect (`useNewOrderAlert` call at line 22)
  and the prime-banner state/handler. The page calls it at `page.tsx:97`.
- `frontend/src/hooks/usePosProductActions.ts` (141 lines, hook at
  line 47): `handleProductClick` at line 63, `handleScannedVariant`,
  `handleAddonAdd`, `handleEditItemSave`, the barcode-scanner call and
  `validateOrderPreflight` at line 115. The page calls it at
  `page.tsx:149-161`.
- `frontend/src/hooks/usePosTableActions.ts` (186 lines, hook at line
  36): `handleSelectAvailableTable` at line 48,
  `handleSelectOccupiedTable`, `handleSelectHeldTable`,
  `handleHoldTable` and `handleAddItemsToOrder` at line 167 (including
  the shared `confirm` passed as an option, so the occupied-table
  confirm still opens the page's single `ConfirmDialog`). The page
  calls it at `page.tsx:166-178`.
- `frontend/src/components/pos/PosSupportErrorBanner.tsx` (line 15),
  `PosWorkspaceBanner.tsx` (line 21), `PosTableRail.tsx` (line 15),
  `PosMobileCartDrawer.tsx` (line 17), `PosCustomerPromptModal.tsx`
  (line 13), `PosOrderAlertBanners.tsx` (line 15) and
  `PosSoldOutModal.tsx` (line 15): the support-error banner, the
  table-workspace banner, the table rail, the mobile cart drawer, the
  mandatory-customer prompt, the order-alert banners and the sold-out
  modal, each rendering the page's former JSX verbatim with data and
  callbacks passed as props (translations, router and currency
  formatting are read inside the components, as in `PosTopbar`).

State-ownership audit (what stayed in the page, and why): the page
keeps modal-visibility state, the derived currency/billing/role values,
the `usePosTableWorkspace` / `usePosOrderSubmission` / keyboard-shortcut
wiring, and JSX composition over the existing big modals (untouched
internals: `ProductGrid`, `CartPanel`, `AddonModal`,
`TablePickerModal`, `TableCheckoutModal`, `PaymentModal`,
`PrepaidCheckoutModal`, `PosTopbar`, shift and cash-drawer modals). The
keyboard-shortcut wiring stayed in the page deliberately: it is
declarative dispatch over hook-returned actions and modal setters, and
extracting it would thread ~25 props for no ownership gain. The
`anyModalOpen` derived value moved up in the page (ahead of the
product-actions hook call) so its boolean can be passed as the
scanner's `enabled` flag; it is a pure reorder of a derived const, no
behavior change. The lazy print-menu modal stays lazy: the dynamic
import is untouched at `page.tsx:57-59`.

Boundary decisions, for the record:

- Hook call order preserves the original effect registration order for
  the independent effects (sold-out reminder, order-alert polling,
  fullscreen sync, catalog fetch); the effects write disjoint state.
- No pinning test was added: the move is verbatim and adds no behavior;
  the protecting battery's POS-surface suites (keyboard shortcuts,
  catalog sort, variant/addon surfaces, integration order/hold/payment)
  cover the moved surfaces.
- No thermal kernel, ESC/POS builder, printer service, or oracle file
  was touched. No big-modal file appears in the diff.
- Adjacent observation, NOT changed (pure move only): the sold-out
  reminder effect marks itself checked on its first run while products
  are still empty, so it never re-surfaces sold-out items on later
  runs. Left verbatim for a separate decision.

Verification (full protecting battery, serially, `npm run clean`
between suites, proxy unset except `build:frontend`, logs under
`~/workspace/rest-cafe-docs/stage1-seam5-2026-10-30/`): 20/20 checks
green on the final bytes. The first post-move run was 19/21 commands
green with one explained cause for the two reds: the seven new
components were written with named exports while the page imports them
as defaults, per the `components/pos` convention (`i18n:check` tsc
TS2613 x7 and the same errors in `build:frontend`). The fix was
scaffolding-only — `export default function` on the seven components,
matching `PosTopbar`/`CartPanel` — followed by a green re-run of
`i18n:check`, `lint`, the receipt-column oracle and `build:frontend`.
Final results: lint (backend 964 warnings / 0 errors, frontend 0/0);
lint-engine parity plus lint budget; `i18n:check` including tsc and
the print-labels drift check; held-orders; issue-255; issue-788;
integration-order-hold-payment; integration-payments;
cart-variant-identity; cart-price-override; pos-keyboard-shortcuts;
pos-catalog-sort; pos-sort-settings; variant-pos-surface;
addon-inventory-pos-surface; payment-modal-currency-adapter;
charges-engine; bills-print-api; receipt-column-oracle (12/12, no byte
change — green at the base before the move and green after, golden
untouched); `build:frontend` (static export green). The formatter
(`oxfmt`) was run over the 13 touched files before the battery and
`oxfmt --check` is clean on all of them; its only visible effect beyond
the move was line-wrapping in the new files. The committed tree was
clean immediately after the commit; no wholesale normalization of
never-formatted files.

Physical printer verification is outstanding (owner's machine), as with
every printing-adjacent change; nothing here claims it. The KOT and
receipt print paths go through the same `usePosPrinting` helpers as
before the move.

Next: when seam 5 lands, Stage 1 is complete — Ted builds the Windows
installer and closes thread 20261030-004. No seam 5 work beyond this
PR; no further stage work starts under this assignment.
