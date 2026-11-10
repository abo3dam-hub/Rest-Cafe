From: assistant
To: ted
Kind: status
Thread: 20261110-054
Subject: Printing finalization Phase B, delivery B2 complete — PF-04 queued receipt retry must not duplicate a manual reprint (thread 20261110-050)

Delivery B2 is complete and ready for review, per Ted's decision
20261110-051 (thread 20261110-050) and decision 20261110-053 (B2 NEXT).
Base head: bb7565ec0cba53fbacedea6a18844f30777ef36c (upstream main, B1
landed). Branch: assistant/printing-finalization-b2 (fork
tedfoagen-stack). Pull request: to be opened after this status file is
published; the PR carries 3 commits (announce + 1 work commit + this
status file) and 7 files (6 B2 files + this status file).

## What changed

PF-04, decision 051: a queued receipt retry must not duplicate a
manual reprint. Both approved mechanisms, because the code shows they
protect different windows (see "Mechanism choice" below).

- Cancellation on confirmed print (`cancelPendingReceiptJobs`,
  main/services/receipt.ts:93-110): deletes pending receipt jobs for a
  bill, called in the same transaction as the printed_at stamp in all
  three places a manual print success becomes visible in the database:
  `recordPrintConfirmation` (receipt.ts:139) — the funnel for every
  frontend-confirmed print (WebUSB, server, browser dialog, via POST
  /api/bills/:id/print); `markBillPrintedOnDispatch` (receipt.ts:170)
  — a worker success withdraws a second pending job for the same bill
  under a different payload; and the operator-attestation endpoint
  POST /api/bills/:id/markPrinted (main/routes/bills.ts:5381-5388),
  now wrapped in withTxn with the stamp. Only `pending` jobs are
  removed; a `processing` job is mid-flight and the guard covers it.
  The row is deleted rather than marked done: the retry never executed,
  and the print_logs row is the record of the print.
- Execution-time printed_at guard (main/services/print-queue.ts:507-508):
  the receipt path of `executePrintJob` re-reads the bill and returns
  `{ ok: true, skipped: true }` without dispatching when
  `bill.printed_at > job.created_at`. Strict `>`: a bill printed
  before the job was queued means the job is a failed reprint retry,
  and it must still print (pinned by test). Both stamps are UTC
  `YYYY-MM-DD HH:MM:SS`, so the string compare is chronological.
  `processDuePrintJobs` (print-queue.ts:541-545) completes a skipped job
  as done and counts it resolved, but does not call
  `markBillPrintedOnDispatch` for it — a skip must not re-stamp
  printed_at, or the manual print's stamp would be overwritten by the
  worker-pass time. The KOT path is untouched (the F-004 marker already
  closes it).
- Frontend queue (frontend/src/lib/printer/print-queue.ts:238-251):
  new `removePendingPrintJobsForBill(billId)` removes the bill's
  pending receipt retries from localStorage, leaving KOT jobs alone.
  `printBill` in frontend/src/hooks/usePrinter.ts calls it on every
  successful exit (usePrinter.ts:320-326 helper;
  backend-path success :383, browser-print success :404 via
  executeBrowserPrint, WebUSB success :609), so a manual reprint from
  the POS withdraws the queued frontend retry before returning.
- No migration, no golden regeneration, no label renames, no
  money/tax/settlement/refund behaviour change. The thermal kernel,
  ESC/POS builder, and oracle are untouched. The Phase A report file
  was not amended. docs/architecture/printing.md and docs/printers.md
  do not mention the queue, so there is no stale passage to update in
  this delivery; the PF-06/07/08 doc corrections remain Phase C.

## Mechanism choice, and why

Both, because they protect different windows:

- Cancellation is the primary mechanism: it removes the stale job
  promptly, including the same-second case (printed_at and the job's
  created_at are second-resolution, so a manual print in the same
  second as the enqueue is invisible to the guard). It runs in the
  same transaction as the stamp, so a confirmed print and its
  withdrawal cannot split across a crash.
- The guard is the second line of defence: it covers a job that was
  already claimed (`processing`) when the manual print succeeded —
  cancellation only removes `pending` rows — a second pending job
  under a different payload, and any confirmation path that stamps
  printed_at without going through the cancellation (none exists
  today; the guard makes that a safe invariant rather than an
  assumption). The guard alone would miss the same-second case; the
  cancellation alone would miss a mid-flight claim. Together the
  exact sequence cannot produce a second print.

## Frontend queue: addressed, with one stated residual

The audited window — print fails on this till, the operator reprints
manually from the same POS, the drain would re-run the queued job —
is closed by the `printBill` withdrawal above. What is NOT closed,
deliberately: a manual print from ANOTHER terminal stamps printed_at
on the backend but cannot reach this till's localStorage queue, and
the drain has no clock-safe way to notice — the job's createdAt is
renderer-local epoch ms while printed_at is a backend UTC stamp, so
comparing them across unsynchronised till clocks could wrongly skip a
legitimate reprint retry (a behind-clock till would read an older
printed_at as newer than the job). The backend queue is fully
protected by the guard in that cross-terminal case; the frontend
queue is not. Residual risk: one duplicate receipt if the operator
reprints the same bill from a different terminal inside this till's
frontend retry window (first retry 30 s, backoff to 15 m, 5 attempts).
Impact stays paper and confusion, not money. Closing it needs a
backend-answered signal the drain can trust (e.g. the drain asking
the backend whether the bill was printed after the job was queued);
that is a follow-up, not part of this delivery.

## Tests

- tests/kot-print-queue.test.ts: 146/146 (was 119/119; 27 new PF-04
  assertions, all in the existing suite — no new suite needed).
  Exact sequence, fail → enqueue → manual reprint succeeds → worker
  pass → NO second print: the confirmation stamps printed_at, the
  pending job is gone, the worker processes 0 jobs and the dispatcher
  is never called. Guard alone: a bill stamped after the (backdated)
  job is skipped with no dispatcher call, job done, printed_at
  unchanged. Reprint retry still prints: a bill printed before the
  job was queued dispatches on the worker pass. Cancel scoping:
  removes only the pending receipt job for the bill — a processing
  job, another bill's job, and KOT jobs are untouched. Frontend:
  removing for a bill drops only its receipt jobs; removing for an
  unknown bill is a no-op.
- No test covers the `printBill` withdrawal call sites directly (the
  hook is not unit-tested in this suite); the helper is pinned above
  and the call sites are the three success returns of `printBill`.

## Battery (full protecting battery)

31 commands, 30 exit 0. The single exit 1 is `test:raster`,
Electron half NOT RUN on this host — `Missing X server or $DISPLAY`,
pre-existing since D5, reproduced on a pristine checkout.
Supplementary Xvfb run of `test:raster`: exit 0 ("Chromium raster
surface rendered styled RTL output", "Warm Chromium raster singleton
lifecycle passed").

- test:printer 0 (printer.test.ts 460 passed, 0 failed; printer-api
  112/112 passed, 0 failed; menu-selection passed; printer-ipc passed)
- test:printing-settings 0, test:print-parity 0 (613 assertions passed,
  0 failed), test:receipt-column-oracle 0 (13/13 pass, 0 fail —
  byte-identical, no golden regeneration), test:receipt-column-width 0
- test:thermal-capabilities 0, test:kot-print-queue 0 (146/146 passed,
  0 failed), test:kot-line-wrap 0, test:kot-order-notes 0,
  test:bill-print-warnings 0 (17/17), test:bill-printed-at 0 (16/16),
  test:menu-printing 0, test:print-kernel 0, test:print-document 0,
  test:merchant-print-templates 0, test:delivery-slip 0,
  test:printer-width-refresh 0, test:printer-migrations 0,
  test:webusb-printer-selection 0, test:receipt-printing 0,
  test:bills-print-api 0 (34/34 passed, 0 failed),
  test:issue-printing-and-kds-resilience 0,
  test:issue-266-currency-symbol-print 0, test:print-labels 0
- i18n:check 0, lint 0 (1 frontend warning / 0 errors — the
  pre-existing warning, same as baseline), build 0,
  build:frontend 0, docs:check 0, test:migration-registry 0
  (389/389 checks passed, 128 migrations v1..v128)
- Pre-move baseline at base bb7565e (oracle + lint) was green before
  any edit; `npm run clean` between suites; proxy unset except
  build:frontend (proxy on). Logs under
  ~/workspace/rest-cafe-docs/stage1-seam-b2-2026-11-10/logs/
  (summary.tsv + per-suite logs + test-raster-xvfb.log).
  Battery script: stage1-seam-b2-2026-11-10/b2-battery.sh (B1's
  script, same 31 commands).

## Disclosures

- Formatter churn (pre-commit hook, oxc): none beyond the edited
  lines — the committed diff is exactly the 6 B2 files, no wholesale
  normalization of any never-formatted file.
- No import cycle introduced: `cancelPendingReceiptJobs` lives in
  main/services/receipt.ts (which imports only from main/db), so
  main/services/print-queue.ts and main/routes/bills.ts both import it
  through their existing receipt imports; no service↔route edge was
  added.
- Physical-printer verification is outstanding (owner's machine) — no
  real-printer claim is made here. The duplicate is prevented by the
  guard + cancellation in code and pinned by test, not by a hardware
  print.

## What is next

B3 (PF-02: logo raster respects the capability gate) starts only after
B2 lands. No installer for B2; the installer is dispatched after the
last production delivery (B4), per decision 051.
