From: ted
To: assistant
Kind: decision
Thread: 20261031-033
Subject: ACCEPTED — Full-house findings fixes landed, thread 033 closed (PR #22)

Delivery accepted and landed. PR #22 (branch `assistant/full-house-fixes`,
head `90a620d`) verified by Ted in an isolated worktree at the PR head
itself, and landed in original commit order on upstream main:

- `560f0f2` — announce start (thread 033)
- `3c3c24f` — `main/routes/tax-packs.ts` (Fix 1: atomic pack switching)
- `d0786ca` — `main/routes/orders.ts` (Fix 2: cancel closes unpaid bill)
- `d47ce0f` — `main/routes/bills.ts` (Fix 2 terminal bill + Fix 3 duplicate refusal)
- `498cfec` — `main/lib/operation-failure.ts` (`bill_cancelled` display code)
- `f0bd4d3` — `package.json` (two new test scripts + main chain wiring)
- `2723a7a` — `tests/bills-settlement-idempotency.test.ts` (updated pins)
- `d426b48` — `tests/restaurant-full-house.test.ts` (updated pins)
- `5842c1d` — `tests/tax-pack-switch-atomicity.test.ts` (new, 62 assertions)
- `e2bcb43` — `tests/cancel-closes-bill.test.ts` (new, 30 assertions)
- `b72bc74` — status report (thread 033)

Landed tree is byte-identical to the PR head (`git diff 90a620d HEAD`
empty). Ted's battery, serial with `npm run clean` between runs and
proxy env stripped: `lint` 1 warning / 0 errors (baseline-identical),
`build` green, `test:script-coverage` green,
`test:receipt-column-oracle` byte-identical (fail 0), `git diff --check`
clean; tax family (syria-tax-profile, manual-tax-production,
manual-tax-config, charges-engine, tax-engine, integration-tax) and bills
family (bills-print-api 34/34, refunds, cashier-workspace,
reports-reconciliation, issue-zero-balance-settlement 112/112,
issue-exact-balance-settlement 125/125, cancel-override) all green;
day-cycle 116/116, sold-out-backend 27/27; full-house twice green
(1,291 assertions/run, 0 findings, all pinned totals unchanged: R1
2,928,000; R2 3,220,800 / fee 292,800 / refunds 159,500 / net 3,061,300;
R3 235,750 / tax 30,750). The `test:cash-closures` section 15 (Z-print)
failure was independently reproduced by Ted on pristine main (502
`ECONNREFUSED 127.0.0.1:9100`, same 3 assertions, same :1694 crash) —
pre-existing, unrelated, not fixed.

Scope checks: `main/services/refund.ts` untouched (F-R2-2 intact, per the
owner's word); no golden files, no frontend files, no i18n keys, no UI
changes. Two disclosed limits are ACCEPTED and recorded in follow-up 31:
(1) a bill mixing a discount with a full payment of the discounted total
returns 200 (not 400) for a no-amount duplicate — status code only, no
money moves; refining it needs a settlement-path marker, a separate
owner decision, not smuggled into this fix. (2) Cancelling an order with
collected funds stays allowed with an owner PIN and the partially-paid
bill stays live, per the assignment (flag, don't change).

Follow-up 31 added to `docs/IMPLEMENTATION_REPORT_AR.md`. PR #22 commented
(comment `6545175259`) and closed UNMERGED per protocol. A Windows
installer follows this landing (production code changed) — Flint does
not dispatch it.

Thread 033 is CLOSED with this decision. No further authorized work
remains in the queue: the only files left in `agent-comms/open/` are the
legacy 20261029 welcome/transport records, which are not assignments. No
new assignment is created by this decision — do not invent work.
