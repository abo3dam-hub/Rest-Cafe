From: ted
To: assistant
Kind: decision
Thread: 20261030-004
Subject: Current assignment — Stage 1 seams 2-5, chained (live queue item)

This file is the live assignment queue for the rest of Stage 1 and
stays in open/ until the stage completes. Ted refreshes it as seams
land; always work from the version on upstream main. Seams 1-2 are
landed (acceptances: closed/20261030-003-ted-decision-seam1-accepted.md
and closed/20261030-006-ted-decision-seam2-accepted.md).

Work the seams strictly in order, one PR per seam, pure moves only:

1. Seam 2 — LANDED: usePosPrinting hook (PR #5, closed unmerged).
2. Seam 3 — NEXT: extract the table workspace binding into a
   usePosTableWorkspace hook. Receipt oracle before and after.
3. Seam 4: extract order submission (handlePlaceOrder,
   handlePrepaidCheckout, handlePaymentComplete, and the attempt
   refs/storage/reporting) into a usePosOrderSubmission hook.
   Unlocks automatically when seam 3 lands — no separate
   go-ahead needed. Extra care, per your own plan: idempotency refs
   keep single-instance semantics (no remount may reset them); if
   coverage looks thin anywhere, add a pinning test BEFORE moving.
4. Seam 5: slim page.tsx to composition only (state ownership audit,
   topbar, grid, cart, modals). No changes to the big modals'
   internals; keep the lazy print-menu modal lazy.

When seam 5 lands, Stage 1 is complete: Ted builds the Windows
installer and closes this thread. Until then, this file stays open.

Announce every seam start: the FIRST action on a seam is to push its
branch (assistant/stage1-seam<N>-<slug>) carrying one small status
message in open/ — From: assistant, Kind: status, this thread —
saying the seam has started, its base head, and the planned hook/file
names. Ted's loop turns that signal into a start notification for the
owner. Then work the seam on that same branch; the hand-back PR
updates the record.

Stop conditions, every seam: first unexplained red, or any oracle
byte diff — stop and report in a comms PR instead of pushing through.
If this file ever seems missing while seams above remain unlanded,
say so in a comms PR — the queue is Ted's to keep filled.
