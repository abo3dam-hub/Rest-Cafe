From: ted
To: assistant
Kind: decision
Thread: 20261031-031
Subject: ASSIGNMENT — Full-House Rush test: 40 tables at 100% occupancy, all scenarios, hand-computed money oracle (owner-ordered)

# Owner's order (Ali, 2026-10-31, relayed verbatim in substance)

«بدي ياك تصمملي خطة لتجربة حالة المطعم بحالة الفول أي ٤٠ طاولة ممتلئة، طلبات كثيرة، حالات إرجاع وإلغاء طلبات، فواتير بأوقات متقاربة، كل السيناريوهات اللي ممكن تصير والمطعم بحالة امتلاء ٤٠ طاولة. بدي تصمم هالخطة وتعطيها لفلينت ينفذها، ونشوف ضمان سير العملية ونشوف إذا ممكن يصير أخطاء ونشوف دقة الفواتير والتقارير وكل شي ممكن يبين معنا. خلي فلينت ينفذ.»

Owner authorization: **direct, given in his chat today** — same standing as
threads 027/028. This file is the live assignment; it stays in `open/` until
the delivery lands and Ted closes the thread.

# What this is (and what it is NOT)

Build a new **permanent automated suite** — the big sibling of
`tests/restaurant-day-cycle.test.ts` — that fills a restaurant to **40 tables
at once**, runs every realistic rush scenario against the real API on a fresh
database created through the **real setup wizard with production shape**
(country `''`, SYP / SP / Asia/Damascus / Arabic / finedine — never the
test-harness regional defaults), and then proves, against numbers computed
**before any response is read**, that:

1. every bill is exact (items, discounts, consumption fee, totals),
2. every report equals an independent SQL ledger AND the hand-computed
   expectations (three-way reconciliation),
3. no order, item, payment, or table is lost, duplicated, or stuck when
   many things happen at nearly the same time.

**This is a test-and-report assignment, not a fix assignment.** Production
code is OUT of scope. A mismatch is a **finding**: record it exactly
(table, order, expected vs actual, minimal repro) and keep going with the
remaining scenarios wherever it is safe. Never tune an expected number to
match actual output — that is the day-cycle rule and it is absolute here.

# Working cadence (read carefully — corrected rule)

- The 10-minute queue check is a **discovery interval only**: it exists so
  you notice new assignments/decisions. It is **not** a working rhythm.
- Once you start this assignment, work **in one continuous session** until
  the defined endpoint (the delivery PR below). Never stop mid-task to
  wait for the next poll, and never split the delivery into pulses.
- Endpoint = **one PR** containing the suite, its package.json wiring, and
  your status report file for this thread. One delivery, not batches.

# The suite: `tests/restaurant-full-house.test.ts`

Script name: `test:full-house`, wired into `package.json` (individual script
**and** the main `test` chain, per the script-coverage rule). Use the
throwing assert helpers (`assert*OrThrow` family / the day-cycle pattern) —
a suite that cannot fail protects nothing. Follow the day-cycle file's
structure: production route composition (`registerRoutes`), real setup
wizard bootstrap, seeded staff (owner, manager with PIN, cashier, two
waiters), a fixed menu of **whole-SYP prices** chosen so every total is
hand-computable (e.g. 10,000 / 15,000 / 25,000 / 40,000 / 60,000).

Create the 40 tables through the real bulk-tables endpoint. Seed one cash
session open at day start. Build an in-code **expected ledger** as the
scenario script runs (every order's lines, discounts, fees, payments,
refunds), and ALSO pin the day's **grand totals as hard-coded constants**
computed by hand — the script ledger and the constants must agree with each
other before either is compared to the system, so a script bug cannot
masquerade as a system bug.

## Round 1 — Full house, plain shop (tax off)

Fill all 40 tables, then assert the **peak snapshot**: 40 tables occupied,
40 open orders, the KDS feed/board shows all 40, the tables list shows each
table's correct running total.

Table groups (interleave operations across groups — do not run the house
group-by-group to completion; a rush is mixed):

- **T1–T8 — the straight road.** Multi-item orders, second course on the
  same table, KDS walk (pending → preparing → ready → served), bill
  requested → generated → printed, cash payment, table freed.
- **T9–T14 — edits while the kitchen is working.** Add items after KDS
  start; quantity increase and decrease on a started line; void one started
  item with the manager PIN; cancel one single item before kitchen start.
- **T15–T20 — cancellations.** Cancel one whole order before payment (with
  reason); cancel one order after bill generation but before payment;
  verify both tables free up, the items never reach a bill, and the final
  reports count cancellations correctly (reason visible).
- **T21–T26 — discounts and split money.** Order-level percentage discount
  on two tables; split-by-item on one table (one guest pays his items and
  leaves, the rest pay later — children sum == original exactly);
  split payment cash+card on two tables; partial payment then remainder on
  one table. Every figure asserted per bill.
- **T27–T31 — table surgery.** Merge T28 into T27 mid-service (totals
  combine, source order closes with the merge reason, source table freed,
  merged order is NOT counted as a normal cancellation in the finale);
  after T1–T8 start freeing tables, **second seating**: seat new guests on
  five freed tables and run them to payment — the day must end with more
  distinct orders than 40.
- **T32–T35 — bill, then more food.** Bill requested and printed, THEN the
  table orders dessert: the flow must handle the post-print addition
  correctly (bill state/reprint behaviour per the current contract), then
  payment and release.
- **T36–T38 — sold-out in the middle of the rush.** Mark one popular
  product sold out while tables are mid-service: orders already containing
  it are unaffected; a NEW order containing it is refused
  (`400 product_sold_out`, whole cart rolls back); add-items of it is
  refused; a quantity *reduction* of an existing line of it stays allowed
  (the locked exception). The product stays sold out at day end (never
  auto-resets).
- **T39 — self-order.** The table's guests order through the self-order
  path (per-table HMAC token), the order lands in the same KDS/POS
  pipeline, and the table pays at the cashier like any other.
- **T40 — reservation cycle.** Reserved (name/phone/arrival) → seated →
  order → whole-order cancellation → table available → re-seated with a
  normal order → paid. One table, two lifecycles.
- **No-table orders, interleaved:** 3 takeaway + 3 delivery orders during
  the rush; one takeaway cancelled, the rest paid; type breakdown asserted
  in the finale.
- **One held order** placed on hold mid-rush and resumed to payment.

## Round 2 — Full house again, money round (fresh DB)

Same 40-table fill, compressed scenario mix (reuse the Round-1 driver with
a scenario table — do not copy-paste a second suite), with the **Syria
consumption fee at 10%** (the 4–5-star classification; configure it through
the same settings path the day-cycle Round B uses) plus: percentage
discounts on several tables, split payments, and **refunds**: after full
payment, a partial refund (one item) on one table and a full refund on
another. Assert per bill: fee computed on the correct (discounted) base,
refund amounts reduce the day's net and the cash summary exactly, refunded
orders keep their history, and no table or bill is left in a stuck state.

## Round 3 — Small combined-tax probe (fresh DB, 4 tables only)

Manual mode with the **sales tax ON at 5% AND the consumption fee at 10%**
together, 4 tables run straight to payment (one with a discount). Expected
figures derived from the charges/tax engine suites' documented order of
operations, computed before reading responses. If the stacking behaviour
cannot be derived from existing suites/docs, say so in the report and
record what the system actually does as a finding/question — do not guess
an expectation and do not skip the round silently.

## The simultaneity block (inside Round 1, at peak)

Real concurrency, via parallel requests (`Promise.all`), not sequence:

1. **Ten tables request their bill and pay within the same burst.**
   All ten totals exact; no cross-table contamination.
2. **Duplicate payment attempt** on one already-settled bill (same moment,
   twice): the second must not create revenue — assert the day's totals
   count it once.
3. **Duplicate order submission** (same order submitted twice in
   parallel, using the client attempt mechanism where the API offers it):
   exactly one order exists afterwards.
4. **Two waiters add different items to the same table concurrently:**
   both items present afterwards, total = sum of both (no lost update).
5. **KDS advances the same item twice concurrently:** the item ends in
   exactly one consistent state; no error poisons the order.
6. Record a **timing table** (duration per burst) in the status report —
   generous sanity bounds only (flag anything pathological, e.g. a burst
   taking >10× the median single operation); this is not a benchmark.

## Finale — three-way reconciliation (both main rounds)

After every table is paid/cancelled/refunded and the house is empty:

- **Reports API vs independent SQL vs hand-computed constants**, all three
  equal: gross sales, discounts total, consumption fee total (Round 2),
  refunds total, net revenue, order count by status (completed / cancelled
  — with merged orders distinguished from cancellations), order count by
  type (dine-in / takeaway / delivery / self-order), per-product units sold
  (sales breakdown / dish data), cash-vs-card payment totals.
- **Cash closure:** open a session at start, record one mid-day expense;
  closing count expected = opening + cash in − refunds paid in cash −
  expense, variance **zero**.
- **Exports:** the daily export (CSV and XLSX where both exist) carries the
  same headline numbers as the API.
- **Database integrity sweep:** no order left in a non-terminal state, no
  orphan bill items, no bill whose items don't sum to its total, every
  table `available` at day end, the sold-out product still sold out.

# Verification you run before the PR

- The new suite itself, **twice in a row** (it must be deterministic —
  a flaky rush suite is a failed delivery), with `npm run clean` between
  runs and the proxy env stripped per house rules.
- Protecting suites: `test:restaurant-day-cycle`, `test:sold-out-backend`,
  `test:cashier-workspace`, `test:reports-reconciliation`,
  `test:charges-engine`, `test:syria-tax-profile`,
  `test:manual-tax-production`, settlement suites.
- `npm run lint`, `npm run build`, `npm run test:script-coverage`,
  `git diff --check`.

# Status report (in the same PR, this thread)

`agent-comms/open/20261031-031-assistant-status-full-house-rush.md` with:

- assertion count per round + the grand-total constants you pinned,
- the peak-snapshot evidence and the simultaneity timing table,
- **every finding verbatim**: scenario, table/order ids, expected vs
  actual, and whether the rest of the run could continue,
- anything you could NOT exercise through the API (name it honestly —
  e.g. anything that exists only in the Windows UI),
- suite runtime duration.

# Hard scope limits

- **Tests + this status file only.** No production code, no settings
  changes, no fixes. Findings are reported, never repaired, in this thread.
- Locked product decisions are the contract (Syria production shape,
  sold-out backend rule incl. the reduction exception, merge semantics,
  split-check children summing exactly, orders never ownership-gated).
  Behaviour contradicting a locked decision = a finding, flagged as such.
- No new dependencies. Reuse the day-cycle helpers/patterns.
- Ted gatekeeps on landing: he re-runs the suite serially, recomputes the
  grand totals independently, and only then lands + reports to the owner.
  A Windows installer is NOT part of this delivery (no production change).
