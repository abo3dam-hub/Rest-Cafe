---
from: assistant
to: ted
date: 2026-10-31
thread: 20261031-033
kind: status
assignment: 20261031-033-ted-decision-full-house-fixes-assignment.md
base: upstream/main 5f92dd3
branch: assistant/full-house-fixes
---

# Status — Full-house findings fixes (thread 033)

All three fixes are implemented, with regression tests, in ONE delivery PR.
F-R2-2 (refund defaults to the line total including its fee share) is
**untouched**, exactly as the owner ordered. No UI changes. No receipt
bytes changed (receipt-column oracle byte-identical, golden untouched).

## Fix 1 — F-R3-1: tax-pack switching is atomic now

### Root cause (what the false 200 actually mutated)

With a manual tax pack active, `POST /api/tax-packs/syria-profile
{profile:'consumption', classification:'rated_4_5'}` returned 200 and
left checkout broken. Inside one transaction the handler did ALL of
this while leaving the manual pack active:

1. Upserted the Syria pack row (`syria-consumption`, country `'*'`) and
   persisted its artifacts — new version plus its categories, including
   `establishment-services`.
2. Called `activateInstalledPack`, which deactivated only packs with
   the SAME country (`'*'`). The manual pack (`manual-sy`, country
   `'SY'`) stayed `status = 'active'`.
3. Remapped ALL products and addons to the Syria category:
   `UPDATE products SET tax_category_id = 'establishment-services'`
   (and the same for addons).
4. Inserted charge overrides for the new Syria version.
5. After the transaction, set the settings markers
   (`taxes_enabled='true'`, `tax_profile`, `syria_tax_classification`,
   `syria_tax_rate`).

Net state: TWO packs `active` — manual-sy (`'SY'`) and syria (`'*'`).
Active-pack resolution (`activePackForCountry`, `tax-packs.ts`, and
`getActiveCountryPack`, `main/services/tax.ts`) is
`WHERE pack.country IN (?, '*') AND pack.status = 'active' ORDER BY
exact-country match first` — so the manual pack always beat the Syria
wildcard. Products pointed at `establishment-services`, which exists
only in the Syria pack version's `tax_categories`, so
`main/services/tax-engine.ts` threw
`Line … resolved unknown tax category establishment-services` and
every order creation failed 400. The 200 was false: the handler
completed without error while the system sat in a mixed state.

### What changed (`main/routes/tax-packs.ts`, +130/−9)

- **Rejection before any mutation.** The Syria-profile, version-activate
  and rollback paths now consult the resolved-active pack first
  (new helpers `findResolvedActivePack` / `conflictingActivePack`).
  When a different owner-configured pack is resolved-active, the call
  is rejected with **409** and nothing is mutated — no pack row, no
  category remap, no settings marker:
  ```json
  {
    "error": "A different tax pack (manual-sy) is currently active. Deactivate it first, then activate the Syria tax profile.",
    "code": "active_pack_conflict",
    "active_pack_id": "manual-sy"
  }
  ```
  The shape mirrors the existing `/manual-config` 409 precedent
  (`{error, active_pack_id, can_override}`) plus the stable `code`
  the assignment asked for.
- **Two-step path works end to end.** New endpoint
  `POST /api/tax-packs/:packId/deactivate`
  (`requirePermission('tax-packs.manage')`): 404 for an unknown pack;
  `{changed:false}` when the pack is not active (idempotent); otherwise
  one transaction sets the pack to `installed`, clears
  `active_version_id`, sets its active version row to `installed`,
  and audits `deactivate_pack`. It deliberately does NOT touch products
  or settings — the next activation remaps them. No endpoint to
  deactivate a pack existed anywhere before this fix.
- **Deactivation widened to the resolution set.**
  `activateInstalledPack` now deactivates `(country = ? OR country =
  '*')` packs (and the same for `installed_print_templates`), so the
  next activation heals a stale active flag instead of leaving a
  second active pack behind. (For a `'*'` pack the widening changes
  nothing — an exact-country pack always beats `'*'` in resolution.)
- **Syria-family exception.** Re-activating the Syria profile while a
  Syria pack is already the active pack — including switching
  consumption → sales, which changes classification and rate — keeps
  working exactly as today. Both Syria packs share one category
  vocabulary (`establishment-services`) and one builder, so a switch
  between them remaps products onto a category both packs define and
  applies completely; the existing suite
  `tests/syria-tax-profile.test.ts` §10 pins that switch as working.
  The rejection applies only when the active pack is OUTSIDE the Syria
  family (a manual pack or any other pack). The version-activate and
  rollback guards do NOT get the family exception: no existing flow
  activates a version of a different pack while another is active,
  and the Syria-profile route is the sanctioned way to switch profiles.
- **Bundled `local-generic` is not a conflict.** A fresh store resolves
  against the bundled generic pack (`local-generic`, country `'*'`,
  installed by migration v38 with status `active`) until a real pack
  is activated. It carries only the bundled generic categories — no
  owner configuration — so replacing it loses nothing, and the guards
  exclude any bundled pack (`BUNDLED_PACKS_BY_ID`). Without this
  exception every Syria activation on a fresh database would 409; this
  was found by the full-house R2 run failing at its Syria activation
  and fixed by evidence, not by working around the suite (see below).

### Sibling activation paths audited (whole family in `tax-packs.ts`)

| Path | Verdict |
|---|---|
| `/syria-profile` | Non-atomic → guarded (409) + two-step path added |
| `/manual-config` | Applies completely in resolution terms (manual `'SY'` wins; products remapped; settings set), but left the replaced pack's row `active` — a landmine for a later deactivation. **Fixed** by the widened deactivation in `activateInstalledPack` (verified: manual-config over an active Syria pack leaves ONLY manual-sy active) |
| `/:packId/versions/:versionId/activate` | Silent no-op switch — activating a version of a different pack changed no resolved state while reporting `{changed:true}`. **Fixed** with the same 409 guard (allowed when the target is already resolved-active, or no pack is active) |
| `/:packId/rollback` | Version change within one pack, but set its pack `status='active'` unconditionally without deactivating others — could create a double-active state. **Fixed** with the same 409 guard (allowed when no pack is active — restore path — or the target pack is the active one) |
| `/reinstall` | Repairs rows in place, does not touch pack status. Probed clean — not an activation path |
| `GET /:packId` | Read-only |

### Before / after (one line each)

- Before: manual pack active → Syria-profile activation returned 200 and
  broke every checkout with a 400 unknown-tax-category error.
- After: the same call returns 409 `active_pack_conflict` with the
  active pack named, nothing mutates, and checkout keeps working with
  the manual pack's numbers; deactivate-then-activate completes the
  switch, and re-activating the Syria profile while it is active still
  works (including consumption → sales and classification changes).

### Regression tests — `tests/tax-pack-switch-atomicity.test.ts` (new, 62 assertions, green)

Production shape (country `''`, SYP, real wizard-free bootstrap):
(a) manual 10% active → Syria activation 409 with code
`active_pack_conflict` + `active_pack_id: 'manual-sy'`, settings
snapshot byte-identical before/after, product category unremapped,
only manual-sy active, checkout afterwards 201 with manual numbers
(tax 1000, total 11000); (b) deactivate manual (404 unknown pack;
200 `changed:true`; active list empty; repeat `changed:false`) →
activate Syria rated_4_5 → 200, fee 10%, products remapped to
`establishment-services`; (c) classification change rated_4_5 →
rated_2_3 on the active Syria pack → 200, fee 5%; (d) version-activate
of manual-sy's version while Syria is active → 409 + checkout still
Syria 5%; manual-config over the active Syria pack (rate 5%) → 200,
ONLY manual-sy active (stale Syria flag healed), checkout manual 5%;
rollback of syria-consumption while manual is active → 409; rollback
of manual-sy (active, 2 versions) → 200, back to the 10% version.
Wired as `test:tax-pack-switch-atomicity` in `package.json` (script +
main test chain, right after `test:syria-tax-profile`).

## Fix 2 — F-R1-1: cancelling an order closes its unpaid bill

### What changed (`main/routes/orders.ts`, `main/routes/bills.ts`, `main/lib/operation-failure.ts`)

- In the `'cancelled'` case of `PATCH /:id/status` (`orders.ts`), in the
  SAME transaction that cancels the order, restores stock and frees the
  table: `UPDATE bills SET payment_status='cancelled', updated_at=?
  WHERE order_id=? AND payment_status='unpaid' AND
  COALESCE(paid_amount,0)=0`. The row keeps its total, its items and
  its history — nothing is hard-deleted (the merge path's
  `DELETE FROM bills` was the pattern NOT followed). The closed bill
  ids are added to the cancel audit details (`closed_bill_ids`) when
  non-empty. `payment_status` has no CHECK constraint, and the value
  follows the existing vocabulary (orders and order_items already use
  `'cancelled'`); no new column, table or parallel state machine.
- The closed bill is terminal everywhere it matters in `bills.ts`:
  payment on it is refused with **409 `bill_cancelled`** (in
  `preparePaymentBatch`, before the refunded check — otherwise the
  "closed" bill would still accept money and the fix would be
  incomplete); the three "another live bill" checks now also exclude
  `'cancelled'`; `syncOrderBill`, split reallocation, the split-check
  endpoint and the discount endpoints were read and need no change
  (their predicates already exclude it or are gated on order status).
- `bill_cancelled` was added to `PAYMENT_DISPLAY_CODES` in
  `main/lib/operation-failure.ts`: the serializer drops display codes
  outside the capture point's enum, so without that one-line addition
  the 409 response carried only `{error}` and the client could not
  tell a cancelled bill from any other refusal.

### Before / after

- Before: cancel-after-bill left an `unpaid` bill row live forever,
  retrievable via `GET /api/bills/order/:id`.
- After: the same cancel closes the never-paid bill in the same
  transaction; it reads `'cancelled'` through the existing bill read
  paths, keeps its total and items, and refuses payment with 409.

### Out of reach, flagged — not changed

A bill with ANY payment recorded is out of this fix's reach, exactly
as assigned. Verified: cancelling an order with collected funds is
ALLOWED today with an owner PIN (`requiresCancelOverride` when
`hasCollectedFundsOnOrder`) and the bill stays live (`'partial'`,
paid_amount intact). That behaviour is unchanged and is flagged here
for the owner — it is not part of this fix.

### Regression tests — `tests/cancel-closes-bill.test.ts` (new, 30 assertions, green)

Full-app bootstrap (country `''`, SYP; manager PIN `1234` is the
override approver — `seedOwnerUser` sets no PIN): (1) create order →
generate bill → cancel with PIN → bill reads `'cancelled'` via
`GET /api/bills/order/:id`, total 10000 intact, paid_amount 0, bill
row and order items still exist; (2) paying the cancelled bill → 409,
message names cancelled, `display_code: 'bill_cancelled'`, bill stays
cancelled with paid 0; (3) partially-paid bill: pay 4000 → bill
`'partial'` → cancel with PIN succeeds (the flagged behaviour above)
→ bill stays `'partial'`, paid_amount 4000; (4) cancelling an order
with no bill creates no bill rows. Wired as
`test:cancel-closes-bill` in `package.json` (script + main test chain,
right after `test:cancel-override`). Note: plain generated bills carry
NO `bill_items` rows (those are written only by split-check and
refunds) — the "keeps its items" assertion reads `order_items`.

## Fix 3 — F-R2-1: duplicate payment with no amount refuses like the explicit one

### What changed (`main/routes/bills.ts`, `preparePaymentBatch`)

In the `payment_status === 'paid'` branch, the old code threw only
when the duplicate carried a positive amount and otherwise returned
an empty `prepared` set → the caller answered 200. The branch now
throws `Bill is already paid` (`bill_already_paid`, 400) for a
no-amount duplicate too — **when the bill was fully paid in money**:
no bill-level discount and no item-level discount on the order, with
`paid_amount` covering the total. The discriminator is stated here
because it is the one place this delivery deviates from a literal
"total > 0" reading, and the battery forced the correction:

- The first version used `total > 0` as the gate. It broke the
  zero-balance settlement retries: a bill whose balance was zeroed by
  a discount is settled with a total still > 0, and its no-amount
  settle retry must stay a 200 no-op — `test:issue-zero-balance-settlement`
  failed 3 cases, `test:issue-exact-balance-settlement` 1 case.
- The corrected gate refuses only when the bill was fully paid in
  money. When part of the bill was forgiven by a discount, the
  no-amount call is the zero-balance settlement's own retry shape: the
  discount, not a payment, completed the settlement. An item discount
  shrinks the bill's subtotal instead of the bill's `discount_amount`
  column, so the gate also sums `order_items.discount_amount` for the
  order. An explicit-amount duplicate still refuses on any settled
  bill, discounted or not.
- **Known limit, disclosed:** a bill that mixed a discount with a
  full payment of the discounted total also reads as
  discount-settled here, so its no-amount duplicate returns 200
  instead of 400. Amounts alone cannot separate "the discount
  completed it" from "the payment completed it after a discount" —
  only the event order differs, and no stored marker records it. No
  money moves either way; the difference is only the status code. If
  the owner wants the mixed case to refuse too, that needs a
  settlement-path marker, which is a separate design decision — not
  smuggled into this fix.
- Zero-balance settlement itself is untouched: a bill whose total is
  genuinely 0 that has not yet been settled still settles through the
  existing `remainingCents <= 0` flow, and the zero-balance suites are
  green unmodified (see battery).

### Before / after

- Before: paying an already-settled bill with no amount returned 200
  and changed nothing; with an explicit amount it returned 400.
- After: both shapes return 400 `Bill is already paid` on a bill
  fully paid in money, `paid_amount` unchanged, the day's totals count
  the payment once; the zero-balance settle retry still returns 200.

### Regression tests — `tests/bills-settlement-idempotency.test.ts` (updated, 134/134 green)

The ONLY suite pinning the old 200 no-op on paid bills. Sections
1.1–1.4 now pin the 400 refusal for null/zero-amount duplicates on
settled positive-total bills (singular AND batch endpoints), while
KEEPING their underlying assertions: 0 loyalty points, 0 ledger rows,
bill/order untouched, no new kitchen-delivery-override audit rows —
a 400 refusal awards no points and trips no kitchen check, so those
intents survive. New section 1.5: settle a 500 bill, then explicit
duplicate → 400, no-amount duplicate → 400, batch no-amount
duplicate → 400, all three with the IDENTICAL error string, bill
stays paid, paid_amount 500, `payment_details` has exactly 1 recorded
payment. Section 2 zero-balance replays are untouched (same
Idempotency-Key returns the cached 200 before `preparePaymentBatch`
is reached). Section 3.1 (the deterministic race: owner cancels the
order DURING the waiter's payment) now pins the new behaviour: the
mid-flight cancel closes the bill first (Fix 2), so the payment is
refused 409 `bill_cancelled`, bill stays `'cancelled'`, balance 500,
paid_amount 0, order stays `'cancelled'` — the no-resurrection
invariant is preserved and strengthened (before: the payment landed
on a cancelled order, 200, bill `'paid'`).

This change to the suite's pinned expectations is intentional and is
flagged here explicitly: the assignment's Fix 3 contract demands the
400, and its "new/updated regression coverage" clause covers updating
a suite whose pinned behaviour intentionally changes — the same class
as the full-house pin updates the assignment explicitly orders.

## Full-house suite — pins updated, twice green

`tests/restaurant-full-house.test.ts`:

- Integrity sweep: orphaned-unpaid-bills expectation `2` → `0` for
  all rounds, plus a second assertion that the two cancel-after-bill
  rows per round now read `'cancelled'`.
- R3 stacking probe rewritten: the old probe pinned the BROKEN
  behaviour (activation 200, then order 400 naming `unknown tax
  category`). It now pins the fix: activation → 409 with code
  `active_pack_conflict` + `active_pack_id: 'manual-sy'`, only
  `manual-sy` active afterwards, checkout after the rejected switch →
  201 with manual numbers.
- **Two runs in a row, final tree: both exit 0, 0 findings,
  1,291 assertions/run, 9.9s each.** Pinned totals unchanged: R1
  gross 2,928,000; R2 gross 3,220,800 / fee 292,800 / refunds
  159,500 / net 3,061,300; R3 gross 235,750 / tax 30,750.
- The first full-house run in this delivery FAILED at the R2 Syria
  activation (409): a fresh database resolves against the bundled
  `local-generic` pack (country `'*'`, installed active by migration
  v38), and the first version of the Fix 1 guard treated it as a
  conflicting owner pack. The cause was established by reading the
  migration and the bundled pack definition — not worked around in the
  suite — and fixed by the bundled-pack exception above. The R2
  activation is the same path the day-cycle Round B uses, and it is
  green there too (116/116).

## Protecting battery (serial, `npm run clean` between suites, proxy unset)

All on the final tree. `test:cash-closures` §15 is the known
pre-existing failure, byte-identical to pristine base (same 3 failed
assertions: Z-print 502 `ECONNREFUSED 127.0.0.1:9100`, `isReprint`,
dispatch count; same crash at `cash-closures.test.ts:1694`).

| Suite / check | Result |
|---|---|
| `npm run lint` | 1 warning, 0 errors (same as baseline) |
| `npm run build` | exit 0, 0 TS errors |
| `npm run test:script-coverage` | OK: 259 reachable, 8 excluded; 309 files run |
| `npm run test:receipt-column-oracle` | golden match, 0 fail — no receipt bytes changed |
| `git diff --check` | clean |
| `test:syria-tax-profile` | 46 passed, 0 failed |
| `test:manual-tax-production` | 12 passed, 0 failed |
| `test:manual-tax-config` | 22 passed, 0 failed |
| `test:charges-engine` | 196/196 passed |
| `test:tax-engine` | 18 passed, 0 failed |
| `test:integration-tax` | 363/363 passed, 0 failed |
| `test:tax-pack-switch-atomicity` (new) | 62 passed, 0 failed |
| `test:cancel-override` | 30/30 passed, 0 failed |
| `test:cancel-closes-bill` (new) | 30 passed, 0 failed |
| `test:bills-print-api` | 34/34 passed, 0 failed |
| `test:refunds` | 40 passed, 0 failed |
| `test:cashier-workspace` | all assertions passed |
| `test:reports-reconciliation` | all assertions passed |
| `test:issue-zero-balance-settlement` | 112/112 passed, 0 failed |
| `test:issue-exact-balance-settlement` | 125/125 passed, 0 failed |
| `test:bills-settlement-idempotency` | 134/134 passed, 0 failed |
| `test:cash-closures` | §15 pre-existing failure only, identical to pristine base |
| `test:restaurant-day-cycle` | 116/116 passed, 0 failed |
| `test:sold-out-backend` | 27 passed, 0 failed |
| `test:full-house` ×2 | both green, 0 findings, 1,291 assertions/run |

## F-R2-2 — refund behaviour untouched (owner's word)

An item refund still defaults to the line total INCLUDING its fee
share (`main/services/refund.ts` — not touched, no file in this
delivery references it). The R2 pinned refund total 159,500
(11,000 + 148,500) is unchanged, and `test:refunds` is green.
No toggle, no "fix", no new behaviour.

## Delivery contents

Commits on `assistant/full-house-fixes` (base `5f92dd3`):

1. `f0e512b` fix(tax): reject pack activation over a different active pack
2. `df646d9` fix(bills): close unpaid bill on cancel; duplicate payment refuses either way
3. `7ab0df0` test: regression coverage for the full-house findings fixes
4. `d8f6cfb` fix(bills): duplicate-payment gate only refuses bills fully paid in money

Files: `main/routes/tax-packs.ts`, `main/routes/orders.ts`,
`main/routes/bills.ts`, `main/lib/operation-failure.ts`,
`tests/tax-pack-switch-atomicity.test.ts` (new),
`tests/cancel-closes-bill.test.ts` (new),
`tests/bills-settlement-idempotency.test.ts`,
`tests/restaurant-full-house.test.ts`, `package.json`
(2 new test scripts + main chain wiring), plus this status file and
the announce file. Zero production files outside the three fixes.
No i18n keys added (Fix 1's rejection message is an API error string
in the existing style, not a user-visible UI string). No UI changes.

## Flagged for the owner / Ted (not fixed, by design)

1. Cancelling an order with collected funds is still allowed with an
   owner PIN and the partially-paid bill stays live (see Fix 2).
2. The mixed discount + full-payment bill returns 200 instead of 400
   for a no-amount duplicate (see Fix 3 limit); refining it needs a
   settlement-path marker, a separate decision.
3. `test:cash-closures` §15 remains the pre-existing Z-print
   environment failure, identical on pristine base — not this
   delivery's.

Please verify and land; the delivery changes production code, so the
Windows installer follows landing. Thread 033 stays open until Ted's
decision accepts it.
