From: ted
To: assistant
Kind: decision
Thread: 20261031-033
Subject: ASSIGNMENT — Fix the three full-house findings (F-R3-1 tax switch, F-R1-1 orphan bills, F-R2-1 duplicate payment); F-R2-2 stays as-is (owner decision)

# Owner's decision (Ali, 2026-10-31, in his chat)

After Ted explained the four full-house findings (thread 031) in plain
terms, Ali decided verbatim: **«صلّح الضريبة + الفواتير اليتيمة + الدفع
المكرر، واترك الإرجاع متل ما هو»** — fix the tax switch, the orphaned
bills, and the duplicate payment; **leave the refund behaviour (F-R2-2)
exactly as it is**. His authorization is direct, under the standing grant
(20261030-006). This file is the live assignment; it stays in `open/`
until the delivery lands and Ted closes the thread.

# Working cadence (same corrected rule as thread 031)

The 10-minute queue check is a **discovery interval only**. Once you start,
work **in one continuous session** until the endpoint: **one PR** with all
three fixes, their regression tests, the updated full-house pins, and your
status report for this thread. Never pause mid-task waiting for a poll.

# Fix 1 — F-R3-1: tax-pack switching must be atomic (the serious one)

Verified behaviour today: with a manual tax pack active,
`POST /api/tax-packs/syria-profile {profile:'consumption',
classification:'rated_4_5'}` returns **200** but checkout is left broken —
every subsequent order fails 400 `Tax calculation failed: ... resolved
unknown tax category establishment-services`, while the active pack stays
`manual-sy`; the switch neither took effect nor failed cleanly.

**Required contract (Ted's design ruling, inside the owner's order):**

1. **No half-applied switch, ever.** Any pack activation path (syria-profile
   activation, manual-config activation, pack activate/deactivate — audit
   the whole family in `main/routes/tax-packs.ts`) either applies
   completely or leaves **all** tax state byte-for-byte untouched, and
   checkout keeps working with the previously active configuration.
2. **Syria-profile activation while a DIFFERENT pack (e.g. a manual pack)
   is active must REJECT with a clear error** (409 or 400 with a stable
   error code and a human-readable message; match the file's existing
   error style) instead of returning a false 200 — silently discarding
   the owner's hand-built manual configuration is data loss and is NOT
   acceptable. The owner can deactivate the manual pack first, then
   activate the profile; that two-step path must work end-to-end.
   - Exception: re-activating the syria profile when the syria pack is
     **already** the active pack (e.g. changing classification
     rated_2_3 → rated_4_5) is a legitimate in-place update and must keep
     working exactly as today.
3. Root-cause first: your status report must state precisely what the 200
   path mutated (settings markers? product category remap? overrides?)
   while leaving the manual pack active, so the fix provably covers the
   actual mechanism, not a symptom.
4. Regression coverage (production shape, country `''`): (a) manual pack
   active → syria-profile activation rejected, error shape asserted, and
   a checkout order afterwards succeeds with the manual pack's numbers
   unchanged; (b) deactivate manual → activate profile → checkout succeeds
   with the fee applied; (c) classification change on the already-active
   syria pack still works; (d) the same atomicity probe for any sibling
   activation path you find non-atomic (fix + test it the same way, or
   report it as a finding if it cannot be fixed inside this scope).

# Fix 2 — F-R1-1: cancelling an order must close its unpaid bill

Verified behaviour today: generate a bill for an order, then cancel the
order (owner PIN) before payment — the order cancels and the table frees,
but the bill row stays `payment_status: 'unpaid'` with its total intact,
retrievable via `GET /api/bills/order/:id`, forever. (Money reports
already exclude it; this is a data-integrity/clarity defect, not a money
bug.)

**Required contract:**

1. When an order is cancelled, its **unpaid, never-paid** bill is closed
   in the **same transaction**: it must afterwards read as
   cancelled/void through the existing bill read paths (use whatever
   terminal representation the bills model already has for this — follow
   existing patterns in `main/routes/bills.ts` / order cancellation; do
   not invent a parallel state, and do not hard-delete the row or its
   items: the audit trail stays).
2. A bill with **any payment recorded** is out of this fix's reach: leave
   the existing cancellation behaviour for paid/partially-paid bills
   exactly as it is (if cancellation is currently refused there, it stays
   refused; if it is allowed, flag it in your report — do not change it).
3. Update the full-house suite's pinned expectation: the integrity sweep
   must now assert **zero** orphaned live-unpaid bills after
   cancel-after-bill (the two T17/T18-style rows read as closed), and the
   rest of the full-house numbers must not move by a single unit.

# Fix 3 — F-R2-1: duplicate payment with no amount must refuse like the explicit one

Verified behaviour today: paying an already-settled bill **with** an
explicit amount returns 400 `Bill is already paid`; paying it with **no
amount** (pay-the-remaining-balance semantics, remaining = 0) returns 200
and changes nothing.

**Required contract:**

1. On a bill whose total is **greater than zero** and which is already
   fully paid/settled, a no-amount payment attempt returns the **same
   refusal** as the explicit-amount attempt (400, `Bill is already paid`
   — same code/message family as the existing path).
2. **Zero-balance settlement must NOT break:** a bill whose total is
   genuinely 0 (e.g. 100% discount) that has not yet been settled still
   settles through the existing zero-balance flow (`test:issue-zero-balance-settlement`
   and friends stay green, unmodified in meaning).
3. Regression coverage: both duplicate shapes (explicit + no-amount)
   refuse identically on a settled bill, `paid_amount` unchanged, and the
   day's totals count the payment once.

# Explicitly OUT of scope

- **F-R2-2 is settled behaviour, owner's word:** an item refund defaults
  to the line total **including** its fee share (`main/services/refund.ts`)
  — do NOT change it, do not "fix" it, do not add toggles for it.
- The pre-existing `test:cash-closures` §15 Z-print environment failure
  (printer socket mock; fails identically on pristine base) — not yours.
- No UI changes are required for these fixes; if Fix 1's rejection needs a
  new user-visible string in the tax panel to be understandable, add it in
  **ar.json + en.json only** (locale freeze) and say so in your report.
- No receipt-byte changes: the receipt-column oracle must stay
  byte-identical; no golden regeneration.

# Tests & battery (before the PR, serially, `npm run clean` between)

- The new/updated regression coverage for all three fixes.
- `test:full-house` (updated pins; **twice in a row**, deterministic),
  `test:restaurant-day-cycle`, `test:sold-out-backend`.
- Tax family: `test:syria-tax-profile`, `test:manual-tax-production`,
  `test:manual-tax-config`, `test:charges-engine`, `test:tax-engine`,
  `test:integration-tax`.
- Bills/payments family: `test:bills-print-api`, `test:refunds`,
  `test:cashier-workspace`, `test:reports-reconciliation`,
  `test:issue-zero-balance-settlement`,
  `test:issue-exact-balance-settlement`,
  `test:bills-settlement-idempotency`, `test:cash-closures`
  (its §15 pre-existing failure must be **identical**, no new failures).
- `npm run lint`, `npm run build`, `npm run test:script-coverage`,
  `npm run test:receipt-column-oracle`, `git diff --check`.

# Status report (same PR, this thread)

`agent-comms/open/20261031-033-assistant-status-full-house-fixes.md` with:

- Fix 1's root cause (what the false 200 mutated) and the rejection error
  shape you implemented;
- for each fix: files touched, the regression tests added and where, and
  the before/after behaviour in one line each;
- the full-house run results after pin updates (twice), and the battery
  table with pass/fail per suite;
- any sibling non-atomic switch path found (fixed or flagged);
- explicit confirmation that F-R2-2 / refund behaviour is untouched.

# Gatekeeping on landing (Ted)

Ted re-runs the battery serially, re-runs `test:full-house` twice,
recomputes the affected totals, and only then lands, writes the Arabic
follow-up, closes this thread, and dispatches the new Windows installer
(the delivery changes production code, so the installer follows landing —
Flint does not dispatch it).
