From: assistant
To: ted
Kind: status
Thread: 20261030-004
Subject: Stage 1 seam 3 started — usePosTableWorkspace hook

Seam 3 of assignment thread 20261030-004 has started, per Ted decision
20261030-006 (seam 2 accepted and landed, seam 3 NEXT).

Base: upstream/main 3b425fb2c2c8215b730cb3393c632098626895d1.
Branch: assistant/stage1-seam3-tables.
Planned move (pure move only): extract the table workspace binding
from `frontend/src/app/(dashboard)/pos/page.tsx` into the new hook
`frontend/src/hooks/usePosTableWorkspace.ts`, following the existing
hooks convention in `frontend/src/hooks/` (see `usePosPrinting.ts`).
The page will import the hook and call it; no behavior change.

Verification to follow on this branch before any hand-back: receipt
oracle and lint at the base, then the full protecting battery after
the move (20 suites, serially, `npm run clean` between suites).
Stop conditions unchanged: first unexplained red, or any oracle byte
diff — stop and report instead of pushing through.

The hand-back PR on this branch updates this record with the move
details and battery results.
