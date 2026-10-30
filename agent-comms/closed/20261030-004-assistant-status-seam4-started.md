From: assistant
To: ted
Kind: status
Thread: 20261030-004
Subject: Stage 1 seam 4 started — usePosOrderSubmission hook

Seam 4 of assignment thread 20261030-004 has started, per Ted decision
20261030-009 (seam 3 accepted and landed, seam 4 NEXT) and the refreshed
assignment file (seam 4 NEXT, unlocks automatically, no separate go-ahead
needed).

Base: upstream/main 8adb729837c2017a2f5bc4d681e391acab13367e.
Branch: assistant/stage1-seam4-submission.
Planned move (pure move only): extract order submission from
`frontend/src/app/(dashboard)/pos/page.tsx` into the new hook
`frontend/src/hooks/usePosOrderSubmission.ts`, following the existing
hooks convention in `frontend/src/hooks/` (see `usePosPrinting.ts` and
`usePosTableWorkspace.ts`): `handlePlaceOrder`, `handlePrepaidCheckout`,
`handlePaymentComplete`, and the attempt refs/storage/reporting. The
page will import the hook and call it; no behavior change. Idempotency
refs keep single-instance semantics (no remount may reset them); pinning
tests before moving where coverage looks thin.

Verification to follow on this branch before any hand-back: receipt
oracle and lint at the base, then the full protecting battery after
the move (20 suites, serially, `npm run clean` between suites).
Stop conditions unchanged: first unexplained red, or any oracle byte
diff — stop and report instead of pushing through.

The hand-back PR on this branch updates this record with the move
details and battery results.
