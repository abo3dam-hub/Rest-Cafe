From: ted
To: assistant
Kind: decision
Thread: 20261030-004
Subject: Current assignment — Stage 1 seams 4+5, combined delivery (live queue item)

This file is the live assignment queue for the rest of Stage 1 and
stays in open/ until the stage completes. Ted refreshes it as seams
land; always work from the version on upstream main. Seams 1–3 are
landed (acceptances: closed/20261030-003-ted-decision-seam1-accepted.md,
closed/20261030-006-ted-decision-seam2-accepted.md, and
closed/20261030-009-ted-decision-seam3-accepted.md).

Seams 1–4 LANDED:
1. Seam 1 — usePosOrderAttempts (PR #4, closed unmerged).
2. Seam 2 — usePosPrinting hook (PR #5, closed unmerged).
3. Seam 3 — usePosTableWorkspace hook (PR #6, closed unmerged).
4. Seam 4 — usePosOrderSubmission hook (PR #7, closed unmerged).

NEXT (fallback path, 2026-10-30): seam 5 ALONE — slim page.tsx to
composition only. Flint began seam 4 alone before the combined-delivery
refresh landed, so seam 4 landed alone per the fallback clause; seam 5
alone now completes Stage 1. When seam 5 lands, Stage 1 is complete and
Ted closes this thread and dispatches the Windows installer. No
separate go-ahead is needed for seam 5.

ACCELERATION (owner decision, 2026-10-30): seams 4 and 5 are ONE delivery — one branch assistant/stage1-seams45-combined, one PR. Commits in order: (1) any pinning/characterization tests for seam 4, as their own commit; (2) seam 4 move — extract order submission into usePosOrderSubmission (idempotency refs keep single-instance semantics); (3) seam 5 move — slim page.tsx to composition only (no big-modal internals; print-menu modal stays lazy). Announce the combined start the usual way: push the branch first carrying a status message in open/ on this thread naming both seams, base head, planned files. Battery once on the final head; receipt oracle before and after; stop conditions unchanged (first unexplained red or any oracle byte diff — stop and report in a comms PR). If you already began seam 4 alone before reading this, finish it alone; Ted lands it the same way, then seam 5 alone. When the combined delivery (or fallback seam 5) lands, Stage 1 is complete and Ted closes this thread.

Seam 4 detail (for the combined delivery): extract order submission
(handlePlaceOrder, handlePrepaidCheckout, handlePaymentComplete, and
the attempt refs/storage/reporting) into a usePosOrderSubmission
hook. Extra care, per your own plan: idempotency refs keep
single-instance semantics (no remount may reset them); if coverage
looks thin anywhere, add a pinning test BEFORE moving.

Seam 5 detail: slim page.tsx to composition only (state ownership
audit, topbar, grid, cart, modals). No changes to the big modals'
internals; keep the lazy print-menu modal lazy.

Announce the combined start: the FIRST action is to push the branch
(assistant/stage1-seams45-combined) carrying one small status message
in open/ — From: assistant, Kind: status, this thread — saying both
seams have started, its base head, and the planned hook/file names.
Ted's loop turns that signal into a start notification for the owner.
Then work both seams on that same branch; the hand-back PR updates
the record.

Stop conditions, every seam: first unexplained red, or any oracle
byte diff — stop and report in a comms PR instead of pushing through.
If this file ever seems missing while seams above remain unlanded,
say so in a comms PR — the queue is Ted's to keep filled.
