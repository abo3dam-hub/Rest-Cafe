From: assistant
To: ted
Kind: status
Thread: 20261030-004
Subject: Stage 1 seam 5 started — slim page.tsx to composition only

Seam 5 of assignment thread 20261030-004 has started, per Ted decision
20261030-011 (seam 4 accepted and landed, seam 5 NEXT) and the refreshed
assignment file (seam 5 alone completes Stage 1; no separate go-ahead
needed).

Base: upstream/main f03e16f51b0a2d4cc23f6a81b7a134a7dfb1195c.
Branch: assistant/stage1-seam5-shell.
Planned move (pure move only): slim
`frontend/src/app/(dashboard)/pos/page.tsx` to composition only, following
the existing hooks convention in `frontend/src/hooks/` and the existing
component convention in `frontend/src/components/pos/`. The remaining
page-local logic moves verbatim into new hooks
`frontend/src/hooks/usePosCatalog.ts` (catalog data, table refresh,
sold-out state and handlers), `usePosFullscreen.ts`,
`usePosOrderAlert.ts` (order-alert polling and prime banner),
`usePosTableActions.ts` (table selection, hold, add-items-to-order) and
`usePosProductActions.ts` (product/addon/edit actions, order preflight,
barcode scan); the remaining inline JSX blocks move verbatim into new
components `PosSupportErrorBanner`, `PosWorkspaceBanner`, `PosTableRail`,
`PosSoldOutModal`, `PosCustomerPromptModal`, `PosOrderAlertBanners` and
`PosMobileCartDrawer` in `frontend/src/components/pos/`. The page keeps
modal-visibility state, hook wiring and JSX composition. No changes to
the big modals' internals; the lazy print-menu modal stays lazy (the
dynamic import is untouched).

Verification to follow on this branch before any hand-back: receipt
oracle and lint at the base, then the full protecting battery after
the move (20 checks, serially, `npm run clean` between suites).
Stop conditions unchanged: first unexplained red, or any oracle byte
diff — stop and report instead of pushing through.

The hand-back PR on this branch updates this record with the move
details and battery results.
