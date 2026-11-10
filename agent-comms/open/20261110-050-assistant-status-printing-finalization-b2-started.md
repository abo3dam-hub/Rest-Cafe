From: assistant
To: ted
Kind: status
Thread: 20261110-050
Subject: Printing finalization Phase B, delivery B2 started — PF-04 queued receipt retry must not duplicate a manual reprint (base bb7565e)

Printing finalization Phase B, delivery B2 has started, per Ted's decision
20261110-053 (thread 20261110-052), which accepted and landed B1 (PR #31)
and orders B2 NEXT, under decision 20261110-051 (thread 20261110-050).

Base head: bb7565ec0cba53fbacedea6a18844f30777ef36c (upstream main, B1 landed + follow-up 51 + decision 053)
Branch: assistant/printing-finalization-b2

B2 scope (PF-04 — queued receipt retry must not duplicate a manual reprint;
report docs/production-readiness/PRINTING_FINALIZATION_AUDIT.md §6):

- Implement ONE coherent mechanism: either an execution-time `printed_at`
  guard in the receipt path of the print worker, or cancellation of pending
  receipt jobs for a bill when a manual print of that bill succeeds — or
  both if the code shows they protect different windows. The choice and why
  will be stated in the hand-back PR.
- Required test: reproduce the exact sequence — print fails → receipt job
  enqueued → manual reprint succeeds → worker pass → NO second print. Add
  it to the existing queue suite (`tests/kot-print-queue.test.ts`) or a new
  suite wired into `package.json`.
- The frontend (localStorage) queue has the same window from its side:
  address it in this delivery, or scope it out explicitly in the PR with
  the reason and the residual risk stated.

Context from the report (§6.1–6.2): the durable backend queue works
(`main/services/print-queue.ts`: dedup, transactional claim, backoff
30s → 2m → 5m → 10m → 15m, 10 attempts; worker every 30s + one pass 10s
after startup); `markBillPrintedOnDispatch` stamps `printed_at` only after
dispatch success. KOT is already closed against this window by the F-004
marker (`kot_printed_at`, re-read at execution time); receipts have no
execution-time equivalent — that is the gap. The frontend queue
(`frontend/src/lib/printer/print-queue.ts`, key `flocafe:pending-print-jobs`)
queues only failures the backend never answered or WebUSB dispatch failures;
a backend-answered 502 is already server-queued. Impact is paper and
confusion, not money (printing never moves money).

Rules for this delivery: one PR for B2; Ted verifies and lands it before B3
starts; heartbeat at least every 30 minutes while in progress; blocked over
30 minutes or the same step failing twice gets a blocked note in
agent-comms/open/, no silent retries. No golden regeneration. The receipt
oracle must pass unchanged. No installer for this phase; the Windows
installer is dispatched by Ted after the last production delivery (B4)
lands.
