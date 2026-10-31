From: assistant
To: ted
Kind: status
Thread: 20261031-031
Subject: Full-house rush suite + money oracle delivered (test-only, no production code)

Assignment 031 is complete. One PR contains the new permanent suite
`tests/restaurant-full-house.test.ts`, its `package.json` wiring
(`test:full-house`, in the main `test` chain right after
`test:restaurant-day-cycle`), and this report. Zero production code
changed, zero settings changed, zero fixes. Test-and-report only, as
assigned.

## What the suite does

Three rounds on fresh DBs created through the real setup wizard with
production shape (country `''`, SYP/SP, Asia/Damascus, Arabic, finedine),
40 tables at 100% occupancy, one independent in-suite ledger plus
hand-computed pinned constants, and a three-way reconciliation at each
finale (Reports API vs independent SQL ledger vs pinned constants) with a
cash closure (variance 0) and a DB integrity sweep.

- Round 1: full house, tax off.
- Round 2: full house again, Syria consumption fee 10% (`rated_4_5`),
  plus discounts, split payments (by item and by amount), partial payment,
  and two refunds (partial item + full bill).
- Round 3: 4 tables, manual sales tax 5% AND consumption fee 10% together
  in one manual pack (two percent components, one category), one table
  with a 10% discount.
- Simultaneity block inside Round 1 at peak: 10 tables bill+pay in one
  burst; duplicate payment; duplicate order submission; two waiters
  adding concurrently; KDS double advance; timing table below.

## Assertions and results

1,289 assertions per run, 0 findings. The suite ran green three times in
a row (two direct runs + once via `npm run test:full-house`): exit 0,
runtime 9.7s / 9.9s / 10.2s. Money mismatches are soft findings (recorded
verbatim, suite exits 1 at the end); structural failures throw.

Pinned grand totals (all verified by all three legs of the reconciliation):

| Round | Gross collected | Discounts | Fee / tax | Refunds | Net collected | Cash | Card |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1 (fee 0%) | 2,928,000 | 27,000 | 0 | 0 | 2,928,000 | 2,708,000 | 220,000 |
| R2 (fee 10%) | 3,220,800 | 27,000 | 292,800 | 159,500 | 3,061,300 | 2,978,800 | 242,000 |
| R3 (5% + 10%) | 235,750 | 5,000 | 30,750 | 0 | 235,750 | 178,250 | 57,500 |

- R1: 52 orders created (46 dine-in + 3 takeaway + 3 delivery), 43
  completed, 9 cancelled (8 normal + 1 merged); units SH 42 / FA 15 /
  CO 51 / KU 20 / TE 13 / MA 4; 44 bills; cash close counted 2,783,000
  (100,000 + 2,708,000 − 0 − 25,000), variance 0.
- R2: same order counts; TE 12 (the refunded tea line is excluded from
  units everywhere, as topProducts does); cash net 2,819,300; cash close
  counted 2,894,300 (100,000 + 2,978,800 − 159,500 − 25,000), variance 0.
- R3: 4 orders created / 4 completed / 0 cancelled; units SH 4 / KU 1 /
  CO 1 / MA 1; tax split sales 10,250 + fee 20,500; no cash session.

## Peak snapshot (Round 1 and Round 2, identical)

40/40 rush tables occupied, 40 open orders, KDS feed and kitchen board
each list all 40, per-table running totals match the ledger exactly.
(The demo setup profile also seeds 4 tables numbered T1–T4; the rush
tables are the numeric 1–40.)

## Simultaneity timing table (run 3, ms; median single op 8ms)

| Burst | R1 | R2 | Bound |
| --- | --- | --- | --- |
| duplicate-submission (2 calls) | 9 | 13 | 80 |
| kds-double-advance (2 calls) | 9 | 8 | 80 |
| concurrent-add (2 waiters) | 10 | 10 | 80 |
| bill-and-pay x10 (40 calls) | 130 | 133 | 320 |
| duplicate-payment (2 calls) | 15 | 6 | 80 |

Bound = max(10, calls) x median single op: a burst must beat running
its calls one after another. All bursts pass. Every simultaneity
invariant held: duplicate submission created exactly 1 order (201 +
200 replay, same id); duplicate payment with an explicit amount was
rejected twice with 400 `Bill is already paid` and paid_amount
unchanged; KDS double advance gave one 200 + one 409 naming the
refresh conflict, item ends `preparing`, order rollup unpoisoned;
concurrent add landed both items with no lost update.

## Findings (verbatim)

F-R3-1 — Two-pack tax stacking breaks checkout. With a manual tax pack
active, re-activating the Syria consumption profile returns 200 yet
leaves checkout broken: every subsequent order fails 400
`Tax calculation failed: Line... resolved unknown tax category
establishment-services`. The active pack stays `manual-sy`; the switch
does not take effect and does not fail cleanly. Minimal repro, on a
fresh DB with the manual two-component pack active:
`POST /api/tax-packs/syria-profile {profile:'consumption',
classification:'rated_4_5'}` → 200; `POST /api/orders {type:'takeaway',
items:[{product_id:'p-shawarma',quantity:1}]}` → 400 with the error
above. The suite pins this verified behaviour (asserts the 400) and
records the finding here; it does not fix it. Two-pack stacking is
impossible; the working Round 3 configuration is a single manual pack
with both components (5% + 10%) in one category.

F-R1-1 — Cancel-after-bill leaves an orphaned unpaid bill. Cancelling
an order after bill generation (owner PIN) succeeds, the table frees,
but the bill row remains (`payment_status: 'unpaid'`, total intact,
retrievable via `GET /api/bills/order/:id`). Money totals are
unaffected: every report and the SQL ledger exclude it. 2 such rows in
R1/R2 (T17/T18, both cancelled after generation, before payment). The
suite pins this (asserts exactly 2 orphaned unpaid bills with
paid_amount 0) and records it here.

F-R2-1 — Duplicate payment with no amount is a 200 no-op. Paying an
already-paid bill with an explicit amount returns 400 `Bill is already
paid` (both attempts, paid_amount unchanged). Paying with NO amount
(pay remaining balance = 0) returns 200 and changes nothing. Minor;
recorded for completeness.

F-R2-2 — An item refund defaults to the line total INCLUDING its fee
share. Refunding T1's tea line (price 10,000, fee 10%) refunds 11,000,
not 10,000 (`main/services/refund.ts`: amount defaults to
`item.total`). The order and bill totals do not move on refund; the
refund is a separate row netted by reports. The suite's pinned R2
constants use 11,000 + 148,500 = 159,500 total refunds.

## Verified definitions (not defects, recorded so the next reader does not re-derive them)

- A new expense starts unpaid (`paid_minor: 0`) and takes nothing out of
  the drawer until paid; the suite pays the 25,000 mid-day expense in
  cash (`POST /api/expenses/:id/payments`) so the close nets it.
- `cash-summary` `cash_collected` is gross cash paid; only
  `net_collected` is net of refunds. The daily CSV export's
  `payment_*` rows are net of refunds (their sum = `net_collected`);
  the sales-breakdown `collected` is gross paid. The daily CSV
  `part=summary` is `metric,value` rows (`order_count`,
  `gross_collected`, `net_collected`, `refunds_issued`, `tax_total`,
  `discount_total`, `payment_cash`, `payment_card`).
- `GET /api/orders*` is capped by `orderReadRateLimit` (120/min, no
  private-IP skip, plain-text 429). The suite drives both KDS passes
  from the single `GET /api/kds/orders` feed to stay under it; order
  reads per round are ~18.
- Item cancel of a pending line needs owner/manager
  (`orders.item.cancel`); item void of a started line is waiter + PIN
  (`orders.item.void`); item edit is owner-only (`orders.item.edit`);
  the chef role has no `orders.read` (KDS transitions are the chef's,
  order reads go through the owner token).

## Not exercisable through the API

- Physical-printer verification on Ali's machine (the suite prints
  bills through the API; the ESC/POS bytes are not asserted here —
  the receipt-column oracle covers the bytes).
- The Windows installer and any desktop-only UI flow (no installer
  dispatched for this delivery, per the assignment).

## Protecting battery (after the suite, serially, `npm run clean` between)

PASS: `test:restaurant-day-cycle`, `test:sold-out-backend`,
`test:cashier-workspace`, `test:reports-reconciliation`,
`test:charges-engine`, `test:syria-tax-profile`,
`test:manual-tax-production`, `test:refunds`, `test:expenses`,
`test:daily-sales-export`, `test:full-house` (x3), `npm run lint`,
`npm run build`, `npm run test:script-coverage`, `git diff --check`.

FAIL (pre-existing, NOT caused by this delivery — identical 3
failures on the pristine base, verified by stashing `package.json`
and re-running): `test:cash-closures` section 15, Z-print — the
`printZReport` mock does not intercept in this environment, so the
real socket to 127.0.0.1:9100 is attempted and returns 502
(`ECONNREFUSED`). This delivery touches no production code and no
printer code. Flagged for Ted, not fixed here (test-only scope).

## What is next

Ted gatekeeps on landing: re-run the suite serially, recompute the
grand totals independently. No installer for this delivery. The
physical-printer verification on Ali's machine remains outstanding.
