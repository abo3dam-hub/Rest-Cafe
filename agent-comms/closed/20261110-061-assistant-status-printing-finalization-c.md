From: assistant
To: ted
Kind: status
Thread: 20261110-061
Subject: Printing finalization Phase C — matrix + docs corrections and closure recommendation (thread 20261110-050)

Phase C is complete (docs + matrix only; no production, test, or golden
changes). Base: upstream/main `3a5230f0d8fda27c70ae1a637f319123246ed48c`.
Branch: `assistant/printing-finalization-c`. The Phase A report
(`docs/production-readiness/PRINTING_FINALIZATION_AUDIT.md`) was not
amended — it is frozen.

## What was corrected (row by row, verified against current code/tests)

All suite counts below were run live in this delivery on clean main at the
Phase C base.

- C06 (KDS reconnection): expected result no longer says orders appear
  "without a chime". They now sound the F-029 catch-up chime
  (`frontend/src/lib/order-alert.ts`, persisted seen set, cap 500 ids).
  Status stays NOT RUN (no live outage drill); the chime is pinned by
  `test:kds-reconnect-chime` 25/25.
- C07 (KOT retry duplicates): expected result now says a retry sends only
  items not yet printed. The F-004 marker exists
  (`order_items.kot_printed_at`, migration v123,
  `main/db/migrations.ts:3577-3595`); dispatch filters to unprinted items
  (`main/services/kot-print.ts:143`) and stamps the marker on success
  (`:172-173`). Status FAIL → PASS (in-process), `test:kot-print-queue`
  146/146; no live print run.
- C08 / F09 (printer unavailable at submission): "no automatic retry" is
  gone. A failed KOT/receipt is queued in `print_jobs` for automatic
  retry — backoff ladder (`main/services/print-queue.ts:86`), 10 attempts
  (`:82`), worker every 30 s with a pass 10 s after startup (`:559-579`).
  Status stays NOT RUN (no live printer fault drill); queue behaviour
  pinned by `test:kot-print-queue` 146/146. The stale evidence pointer to
  `frontend/src/hooks/usePosPrinting.ts:37-104` is replaced (that file now
  holds only the `printer.queue_failed` error code).
- F06 (long item names): "KOT truncates" is gone. KOT wraps item names,
  addons, and instructions (`main/printers/document-kot.ts:408-448`,
  `pushWrapped`). Status NOT RUN → PASS (in-process),
  `test:kot-line-wrap` 22/22; no paper run.
- F08 (reprints): "KOT reprint duplicates pending items" is gone. A KOT
  reprint sends only items not yet printed (same marker evidence as C07);
  the receipt reprint banner renders from the reprint message
  (`main/printers/document-compact.ts:252-253`). Status FAIL → PASS
  (in-process), `test:kot-print-queue` 146/146.
- F10 (disconnect/reconnect): "there is no queue" is gone. The durable
  queue retries pending jobs on its next pass. Status stays NOT RUN (no
  printer hardware); durability pinned by `test:kot-print-queue` 146/146.
- F11 (restart with a job pending): "No print queue exists" is gone.
  Pending jobs survive the restart in `print_jobs` and the worker picks
  them up 10 s after startup without operator action. Status stays NOT
  RUN (drill not run); restart pickup pinned by `test:kot-print-queue`
  146/146 and the worker startup pass.
- P07 (no silent loss of kitchen tickets): a failed KOT is queued for
  automatic retry; flagging for manual reprint is no longer the path.
  Status stays NOT RUN (no live printer-offline drill); queue behaviour
  pinned by `test:kot-print-queue` 146/146.
- E04 (migration counts): now v128 / registry 389/389 (128 migrations,
  v1..v128), from `npm run test:migration-registry` run in this delivery
  on clean main at the Phase C base. The 371/371 (v122) figures were the
  audit-time counts.

## The two Phase A corrections (decision 051)

- Branded profile names: already correct in the canonical docs — B1 fixed
  them (`docs/architecture/printing.md:234-235`,
  `docs/printers.md:62`, `docs/guides/testing-printers.md:24` all name
  `xprinter-xp-v320m-v330m` and `epson-tm-series`). Nothing further to
  change; the wrong names survive only inside the frozen report itself and
  in `docs/IMPLEMENTATION_REPORT_AR.md:561`, where they are quoted as the
  report's error, not stated as fact.
- E04 counts: taken current at Phase C landing time as above (389/389,
  128 migrations).

## PF-05 — accepted residual risk, recorded

`docs/architecture/printing.md` ("KOT item eligibility") now records the
crash window: if the process crashes between a successful KOT dispatch and
the `kot_printed_at` stamp that follows it in the same function — or, on
the WebUSB path, if the marker POST fails after the ticket printed — the
next dispatch re-sends those items, because no surviving state
distinguishes "printed but unmarked" from "never printed". No code change,
per decision 051. The companion production audit
(`docs/production-readiness/RESTAURANT_PRODUCTION_AUDIT.md`) was left
untouched: it is a historical audit record, not a canonical doc, and its
F-004/F-009/F-016 statements stand as audit-time findings; the Phase A
report §7 already records their staleness.

## Closure recommendation

Flint recommends the printing system be accepted as SOFTWARE-CLOSED,
subject to Ted's decision. PF-01–PF-04 are fixed and verified (generic
raster is a validated per-printer opt-in; the receipt logo respects the
raster capability gate; `whole-receipt` is removed from every shipped
profile; queued receipt retries are guarded by `printed_at`), the stale
matrix rows are corrected in this delivery, and PF-05 stands as the single
accepted residual risk above. One honest limit remains: no
physical-printer verification has run on the owner's hardware — the
live-drill rows in the matrix stay NOT RUN until the pilot checklist runs
on the real printers. The recommendation is also written in the matrix
("Printing closure recommendation" section, end of
`docs/production-readiness/RESTAURANT_TEST_MATRIX.md`). Flint recommends;
Ted decides — SOFTWARE-CLOSED is not declared here.

## Verification

- `npm run docs:check` — exit 0 (markdownlint 0 issues, 329 links OK,
  index completeness OK). The 13 process-material policy findings it
  reports are warnings, not gated, and all sit in files this delivery did
  not touch (`docs/IMPLEMENTATION_REPORT_AR.md`,
  `docs/production-readiness/PRINTING_FINALIZATION_AUDIT.md`); none is in
  either corrected file. Pre-existing.
- `git diff --check` — clean.
- `npm run test:migration-registry` — 389/389 (128 migrations, v1..v128).
- `npm run test:kot-print-queue` — 146/146.
- `npm run test:kds-reconnect-chime` — 25/25.
- `npm run test:kot-line-wrap` — 22/22.
- No golden regeneration, no oracle run (no code touched). The pre-commit
  hook made no formatting changes to either file — no formatter churn to
  disclose.

## What is next

Ted decides SOFTWARE-CLOSED. No installer for Phase C. After the PR opens,
Phase C stops and waits for Ted's decision (thread 20261110-050).
