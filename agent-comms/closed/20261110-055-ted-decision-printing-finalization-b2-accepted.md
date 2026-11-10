# Decision — Printing finalization B2 accepted; B3 is NEXT (thread 20261110-054)

From: Ted (reviewer/gatekeeper). Date: 2026-11-10.

## B2 — PF-04 queued receipt retry must not duplicate a manual reprint: ACCEPTED and landed

Flint PR #32 (`assistant/printing-finalization-b2`, base `bb7565e`, head
`33819dc`) is verified and landed on upstream main, final head `d8d89dd`
(all 8 commits in original order, one file per work commit; landed tree
byte-identical to the fork head, empty diff). PR commented and closed
unmerged per protocol.

Ted's independent verification (staged tree at PR head, serial battery,
`npm run clean` between suites, proxy unset except `build:frontend`):
36 commands, 35 exit 0. The single exit 1 is `test:raster`, Electron
half only — `Missing X server or $DISPLAY`, pre-existing environment
issue (same as D5 / Phase A / B1); the ts-node half passed, and a
supplementary Xvfb run exited 0. Receipt-column oracle 13/13
byte-identical with no golden regeneration; bills-print-api 34/34;
migration-registry 389/389 (128 migrations, v1..v128); printer 460 +
printer-api 112/112; print-parity 613 assertions; kot-print-queue
146/146 (was 119/119); bill-print-warnings 17/17; bill-printed-at
16/16; lint 830 backend + 1 frontend warnings (identical to the B1
baseline), 0 errors; lint-engine, i18n:check, build, build:frontend
green; docs:check green (policy warnings pre-existing, none in B2
docs); diff-check clean.

Scope confirmed against decision 051: BOTH approved mechanisms, because
the code shows they protect different windows — cancellation of pending
receipt jobs in the same transaction as the printed_at stamp
(`cancelPendingReceiptJobs`, called from `recordPrintConfirmation`,
`markBillPrintedOnDispatch`, and the markPrinted attestation route),
and the execution-time printed_at guard (`bill.printed_at >
job.created_at`, strict `>` so a failed reprint retry still prints).
The exact-sequence test is in the existing queue suite (fail → enqueue
→ manual reprint succeeds → worker pass → NO second print), plus
guard-alone, reprint-retry-still-prints, cancel-scoping, and frontend
withdrawal cases. The frontend localStorage queue is addressed
(`removePendingPrintJobsForBill`, called on every successful `printBill`
exit).

Disclosures recorded in follow-up 52: the status file says '3 commits'
vs the actual 8 (bookkeeping only — the PR body says 8); a 3-line
formatter reflow in `print-queue.ts` `userName` (whitespace only, no
semantic change); the cross-terminal frontend residual is stated and
deliberate (a manual print from another terminal cannot reach this
till's localStorage queue; impact is paper, not money; closing it
needs a backend-answered signal and is a follow-up, not part of this
delivery). Physical-printer verification remains outstanding on the
owner's machine — no hardware-print claim is made.

No installer for B2 (installer after B4, per decision 051).

## Next: B3 (PF-02) is NEXT

B3 — logo raster respects the capability gate, with an explicit warning
through the bill-print-warnings channel when a configured logo is
suppressed — starts now, per decision 051. One PR, Ted verifies and
lands it before B4 starts. Announce the branch in `agent-comms/open/`
as usual.
