From: assistant
To: ted
Kind: status
Thread: 20261102-037
Subject: Delivery 3 status — KOT printed marker, durable print queue, KDS reconnect chime (F-004, F-009, F-029, F-013)

# Delivery 3 — KOT printed marker, durable print queue, KDS reconnect chime

Base: upstream main `90ad8f8cf1522e443ebb54a49a218bbd6d170347`.
Branch: `assistant/auditfix-d3-kot`.
Assignment thread: 20261102-037 (production-audit fix round, owner-approved).

All four Delivery 3 findings are implemented. No production behaviour
outside the four findings changed: money math, tax, settlement semantics,
refund fee-share, cancel-with-collected-amounts, duplicate-payment
200/400 semantics, and the two reservation contrast lines are untouched.
No receipt-oracle byte change (oracle green, see battery). The EPERM
write fault that blocked Delivery 1 and 2 did NOT return during this
delivery: local git, tsc, and the full battery all ran on this host.

## F-004 — a printed marker per KOT item

`main/db/migrations.ts:3581-3603` (migration v123): `order_items`
gains `kot_printed_at TEXT DEFAULT NULL` (guarded by a column check),
plus the `print_jobs` table used by F-009.

`main/services/kot-print.ts` (new, 19-260): the KOT dispatch core,
moved verbatim from the route so the route and the queue worker share
it. `getUnprintedKotItems` (133) / `getUnprintedKotItemIds` (149)
return only pending items with no marker; `markKotItemsPrinted` (162)
stamps only still-unmarked rows and returns the count;
`dispatchKotForOrder` (206) sends one ticket per station group and
marks each group only on its own dispatch success, so a failed group
stays unmarked and a retry sends exactly those items again.

`main/routes/printers.ts`: the `/print-kot` route now dispatches through
`dispatchKotForOrder` (response shapes unchanged: 403 disabled / 400
missing orderId or no printer / 404 no order / 200 `{success, warnings}`
/ 502 with failure fields / 500). Caller-supplied items only scope the
dispatch by id; the database rows are authoritative for status and the
marker. New endpoint `POST /printers/kot-printed` (1195) records a
successful frontend (WebUSB) dispatch by stamping the marker.

`main/printers/document-kot.ts`: `buildKotPrintData` (the single choke
point for all backend KOT rendering) filters `!kot_printed_at`. The
frontend filters the same way in `kot-encoder.ts:294`,
`kot-web-print.ts:170`, and `print-document.ts:363`
(`buildFrontendKotDocument`); `OrderItem` gained
`kot_printed_at?: string | null`. The append path's new-id filter is
unchanged.

## F-009 — durable pending-print queue with automatic retry

Backend: `main/services/print-queue.ts` (new, 26-523).
`enqueuePrintJob` (126) dedupes an identical pending/processing job
(kind + order + bill + payload JSON); the first retry is 30 s out.
`claimDuePrintJobs` (155) claims inside a transaction (`processing`);
`completePrintJob` (177) / `failPrintJob` (194) move the state, with
backoff 30 s, 2 m, 5 m, 10 m, 15 m cap (`printJobRetryDelayMs`, 76) and
`PRINT_JOB_MAX_ATTEMPTS = 10`, after which the job stays `failed` as
the record. `executePrintJob` (411) re-reads the order on every attempt
and dispatches through the same functions the routes use, so retries
respect the F-004 marker and never duplicate; `processDuePrintJobs`
(453) claims and executes due jobs. `PrintQueueService` (487) runs
every 30 s plus one pass 10 s after startup, single-flight, `unref()`,
started in `main/index.ts:1169` after `localBackup.start()` and stopped
in the shutdown list (`main/index.ts:1355`).

`main/routes/printers.ts`: the print-bill business block moved verbatim
into `buildReceiptBusiness` (`print-queue.ts:270`) with
`resolveReceiptLanguagesForTenant` (243) and `dispatchBillPrint` (384),
shared by the route and the worker. The route enqueues a receipt job on
a 502 only when the bill id is real (`Number(bill.id) > 0`; a synthetic
bill id 0 is not queued), and never on the no-printer 400 — the POS
falls back to browser print there, so queueing would duplicate it.
The print-kot route enqueues on the no-printer 400 (only if the order
exists and unprinted candidates exist, 1113-1130) and on a 502 (failed
item ids, falling back to candidate ids, 1164-1183); the 400/502
responses are unchanged. No `POST /printers/print-jobs` endpoint was
needed: the backend route enqueues its own failures, and frontend
no-response/WebUSB failures go to the frontend queue, whose drain
retries through the same print functions. `printDeliverySlip` is out of
scope (F-009 names KOT and receipt jobs only). The worker never touches
`printed_at` or `print_logs` (F-026 belongs to Delivery 5).

Frontend: `frontend/src/lib/printer/print-queue.ts` (new, 24-268):
localStorage queue (`flocafe:pending-print-jobs`, same storage pattern
as the cart draft, in-memory fallback), same backoff, 5 attempts,
dedupe by kind + order + bill + item ids, exhausted jobs kept as the
record and skipped by the drain. `frontend/src/hooks/usePrinter.ts`:
`printKot` enqueues on a backend failure with no `response` (timeout /
transport — an answered failure is already queued server-side, 756)
and on a WebUSB dispatch throw (890), and reports a successful WebUSB
dispatch to `/printers/kot-printed` for exactly the items that ticket
carried (`reportKotPrinted`, 62; `kotPendingUnmarkedItemIds`, 76; 904).
`printBill` does the same on a no-response backend failure (384) and a
WebUSB throw (554). Browser-print failures are not queued: the dialog's
outcome is unknowable and a timer-driven retry would only open another
popup; the toast at failure time stays the signal. `printTaxBill` is
out of scope. `frontend/src/hooks/usePrintQueueDrain.ts` (new): on POS
mount and every 60 s (`PRINT_QUEUE_DRAIN_INTERVAL_MS`, 18) it retries
due jobs — KOT by re-fetching the order and calling the printer store's
`printKot` (which still enforces the master `kotPrintingEnabled`
toggle; a disabled toggle leaves the job untouched instead of burning
attempts), receipt by re-fetching the bill and calling `printBill`.
A transport failure leaves the job untouched (no attempt burned); an
answered failure counts as an attempt; a 404 drops the job. Mounted in
`frontend/src/app/(dashboard)/pos/page.tsx:105` next to
`usePosOrderAlert()`.

## F-029 — KDS reconnect catch-up chime, once per reconnect

`frontend/src/lib/order-alert.ts:186-283` (appended to the existing
chime engine): `seenOrderIdsStorageKey` (per surface,
`flocafe:order-alert:<surface>:seen-ids`), `loadSeenOrderIds` /
`saveSeenOrderIds` (damaged values read as never-persisted),
`diffNewOrders` (fresh ids + the set pruned to the snapshot),
`SEEN_ORDER_IDS_CAP = 500`.

`frontend/src/hooks/useNewOrderAlert.ts:117-127`: the first snapshot
after mount now seeds from the persisted set when the surface had one,
so orders that arrived during the outage produce exactly one catch-up
chime + banner (the existing per-snapshot batching already plays one
chime per batch); a brand-new board (nothing persisted) still seeds
silently. Every snapshot diff saves the pruned set. The effect deps
gained `surface` (exhaustive-deps warning fixed in the same change).
Applies to both surfaces (`kds` and `pos`, surface-scoped keys). The
hard disconnect already unmounts the workspace and destroys the
in-memory seen set; the persisted set is what survives it. No chime
storms: one signal per reconnect, not per historical order.

## F-013 — progression flexibility is intended (documentation only)

`docs/architecture/order-lifecycle.md:274-276` (Order status section):
"Item-status progression is deliberately unenforced: any authorised
role may move an item to any live status, forward or backward, and
accountability comes from audit attribution, not transition rules."
Per decision 20261102-038. No progression-rule code changed anywhere.

## New suites

`tests/kot-print-queue.test.ts` (119 assertions, `test:kot-print-queue`,
electron-node runner): migration v123 objects on a fresh DB; the marker
filter and idempotent stamping; queue enqueue/dedupe/claim/complete;
failure backoff to the 10-attempt cap; the worker end-to-end with stub
dispatchers (KOT fail-then-retry, receipt success, orphan receipt fails
without calling the dispatcher); frontend queue helpers (backoff, dedupe,
due timing, exhaustion, removal).

`tests/kds-reconnect-chime.test.ts` (25 assertions,
`test:kds-reconnect-chime`, ts-node runner): seen-set round-trip per
surface, damaged storage seeds silently, the catch-up diff and pruning,
one batch per reconnect, the 500-id cap.

Both use the throwing `assert*OrThrow` helpers and are wired into
`package.json` (script definitions `test:kot-print-queue` /
`test:kds-reconnect-chime` at lines 161-162, and in the `test` chain
next to `test:pos-wifi-drop`). `test:script-coverage` passes.

Two test-driven fixes in the same commit: the new frontend parsers now
reject non-number stored values instead of coercing them (`null`
coerces to `0` under `Number()` and would have been accepted as id 0)
— `loadSeenOrderIds` and `parsePendingPrintJob` / `asNumberArray` in
`frontend/src/lib/printer/print-queue.ts`.

## Files changed (20)

- `main/db/migrations.ts` — migration v123 (marker + queue table + index).
- `main/services/kot-print.ts` — new: KOT dispatch core with marker.
- `main/services/print-queue.ts` — new: durable queue + worker + shared receipt dispatch.
- `main/routes/printers.ts` — print-kot via the new core, kot-printed endpoint, print-bill via the shared dispatch, enqueue on 400/502.
- `main/index.ts` — worker start/stop.
- `main/printers/document-kot.ts` — `buildKotPrintData` filters marked items.
- `frontend/src/lib/printer/kot-encoder.ts`, `kot-web-print.ts`, `print-document.ts` — frontend KOT filters.
- `frontend/src/lib/types.ts` — `OrderItem.kot_printed_at`.
- `frontend/src/lib/printer/print-queue.ts` — new: frontend queue.
- `frontend/src/hooks/usePrintQueueDrain.ts` — new: POS retry drain.
- `frontend/src/hooks/usePrinter.ts` — enqueue on no-response/WebUSB failure, report WebUSB KOT success.
- `frontend/src/app/(dashboard)/pos/page.tsx` — mount the drain.
- `frontend/src/lib/order-alert.ts` — seen-set persistence helpers.
- `frontend/src/hooks/useNewOrderAlert.ts` — seed from the persisted set, save on every diff.
- `docs/architecture/order-lifecycle.md` — F-013 documentation.
- `tests/kot-print-queue.test.ts`, `tests/kds-reconnect-chime.test.ts` — new suites.
- `package.json` — the two new scripts + test-chain wiring.

## Battery

Full D3 battery run on this host, serially, via
`~/workspace/rest-cafe-docs/auditfix-d3-2026-11-02/d3-battery.sh`
(adapted from the D2 fault-aware waiter; logs in
`~/workspace/rest-cafe-docs/auditfix-d3-2026-11-02/battery/`):
**21/21 steps green, elapsed 586 s, no fault retries needed.**

- `lint`: backend 966 warnings / 0 errors, frontend 1 warning / 0 errors (baseline was 969 / 1; the drop is three `any`s removed by the route rewrites).
- `test:lint-engine`: green. `i18n:check`: green. `build`: green.
  `build:frontend`: green. `test:script-coverage`: green.
  `docs:check`: green. `git diff --check`: clean.
- `test:printer`: 440 passed + printer-api 94/94 + print-menu-printer-selection + printer-ipc, 0 failed.
- `test:bills-print-api`: 34/34. `test:menu-printing`: green.
  `test:print-kernel`: green.
- `test:kot-print-queue`: 119/119. `test:kds-reconnect-chime`: 25/25.
- `test:kds-integration`: green. `test:kds-live-push`: green.
  `test:issue-133-kds-kot-toggles`: 41/41.
  `test:migration-registry`: 374/374 (123 migrations, v1..v123).
- `test:full-house`: 0 findings. `test:restaurant-day-cycle`: 116/116.
  `test:receipt-column-oracle`: fail 0 (no byte change).

Pre-move baseline snapshot at the base (logs in
`~/workspace/rest-cafe-docs/auditfix-d3-2026-11-02/`): receipt-column
oracle green, lint backend 969 warnings / 0 errors, frontend 1 warning
/ 0 errors. Per-commit verification before each commit: root tsc clean,
frontend tsc clean, lint at or below baseline, `test:printer-api`,
`test:bills-print-api`, `test:print-kernel`, `test:issue-133-kds-kot-toggles`,
oracle green.

## Commits (7, on `assistant/auditfix-d3-kot`, base 90ad8f8)

1. `c011913` — `feat(db): add KOT printed marker and durable print-jobs table (F-004, F-009)`
2. `66de163` — `feat(print): record a KOT printed marker per item (F-004)`
3. `af89cc5` — `feat(print): durable pending-print queue with automatic retry (F-009)`
4. `d7f092c` — `feat(print): frontend pending-print queue with POS retry drain (F-009)`
5. `daceed8` — `feat(kds): chime once for orders that arrived during a disconnect (F-029)`
6. `b7208e8` — `docs(kds): document deliberate item-status progression flexibility (F-013)`
7. `5d58695` — `test(print,kds): cover the KOT marker, durable queue, and reconnect chime (F-004, F-009, F-029)`

## Disclosures

- No `POST /printers/print-jobs` endpoint: the backend route enqueues
  its own failures and the frontend drain retries through the same
  print functions; a duplicate job is harmless because the worker and
  the drain both re-read from the database and the F-004 marker makes a
  second execution a no-op.
- The print-bill no-printer 400 is deliberately NOT queued backend-side
  (the POS browser fallback would print it, then the queue would print
  it again). The print-kot no-printer 400 IS queued (no browser
  fallback exists for KOT tickets on that path — the POS toast is the
  only signal otherwise).
- Browser-print failures are not auto-queued (outcome unknowable; a
  timer retry would only open another popup).
- The frontend drain retries only while the POS page is open; the
  backend worker retries regardless of which screen is open.
- `printDeliverySlip` and `printTaxBill` are out of scope for F-009
  (KOT and receipt jobs only).
- Physical-printer verification on the owner's machine remains
  outstanding (never claimed here): the queue paths are verified with
  stub dispatchers and the existing printer suites, not a live printer.

## Not done

- Nothing in the Delivery 3 scope is left undone. Delivery 4 (F-026
  printed_at semantics, F-030, and the rest of the assignment) is a
  separate delivery and starts after this one lands, per the assignment
  order.

## What is next

- Ted's review and landing of this PR. No Windows installer for this
  landing (accessibility/test-only precedent aside, the single installer
  comes after the last production delivery lands, per decision 040).
- Delivery 4 starts after D3 lands.
