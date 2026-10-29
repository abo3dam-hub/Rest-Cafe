From: assistant
To: ted
Kind: status
Thread: 20261029-003
Subject: Setup report — environment proof, baseline, locked rules, Stage 1 plan

This republishes, as a written record, the setup report first sent to Ali
in chat on 2026-10-29. No code is changed by this message. It was written
at head 21ef7c9; the checkout has since fast-forwarded to 9782dde with only
agent-comms files changed, so every code fact below still holds at 9782dde.

**1. Setup results**

Clone of abo3dam-hub/Rest-Cafe succeeded, clean tree at 21ef7c9. The
briefing pack downloaded and unpacked to
~/workspace/rest-cafe-docs/agent-pack/ (00-START-HERE.md, PROJECT-STATE.md,
PLATFORM-SETUP.md, and the four SKILL-*.md files), read in order, plus the
repo AGENTS.md and docs/reference/product-invariants.md. Graphify was
skipped: uv is unavailable and there is no graphify-out/ in this checkout;
impact analysis is by imports and grep, and stage reports will say so.

Dependencies were missing, so root was installed (558 packages, Electron
verify passed) and frontend/ was installed (481 packages). Git identity for
local commits: "Rest&Cafe Assistant Agent".

Environment proof, after `npm run clean`, proxy unset, exactly as specified:
migration registry 371/371 checks passed (122 migrations, v1..v122), exit 0.
A fresh database reached v122 with integrity and foreign-key checks clean.
The full log lives outside the repo at
~/workspace/rest-cafe-docs/migration-registry-proof-2026-10-29.log; it is
not in this PR. Re-run the command to reproduce it.

**2. Test baseline, in my own words**

Pack-reported baseline (verified 2026-10-28/29): the product is green
across a 308-leaf external battery plus 25 serial checks — lint, both
builds, i18n and docs checks, upgrade path, receipt oracle, bills printing,
KDS, reports, and backup. Backend lint warnings sit at 964 against a 1000
budget, so new code has almost no headroom. The only known reds are
environmental, not code signals: the e2e browser family needs a real
desktop, e2e:server has a broken harness importing a removed WhatsApp
module, and the print-menu suite prints a declared raster skip off Windows.

What I personally verified in this environment is narrower: only the
migration-registry suite above, on a clean tree. I did not re-run the full
battery or the POS suites. That is step zero of Stage 1, before any move.
Two pack line counts have drifted at this head — main/db.ts is 9,214 lines,
not 9,225, and main/printers/thermal.ts 4,227, not 4,232 — while the POS
page is exactly 3,210 lines as stated. Head matches, so the code is trusted
over the pack's counts.

**3. Five locked rules judged most dangerous to violate**

1. Order/payment idempotency is sacred. The POS page carries prepaid and
   postpaid attempt records, fingerprints, and idempotency keys in storage
   so a lost response replays instead of duplicating. A damaged attempt must
   never be replaced with a fresh key: breaking this can create a duplicate
   order or charge twice.
2. Printing is fail-closed, and the oracle is law. If financial lines
   cannot be represented by the printer's capabilities, the builder emits
   nothing rather than a bill without totals, and an empty no-printer Arabic
   preview is designed behavior. Never weaken the Arabic-shaping gate to
   "fix" a preview, never regenerate the receipt golden without explicit
   approval, and never claim physical-printer verification that cannot be
   done here.
3. Orders are never ownership-gated, and waiters never touch money. Any
   role with order access sees all orders. Waiters land on /tables, never
   see money actions, and return to /tables after placing an order.
4. Syria, Arabic-first, whole SYP, Latin digits, DD/MM/YYYY Gregorian,
   Asia/Damascus. Only ar/en are selectable, only SYP/USD in the picker,
   frozen locale catalogues stay frozen, and the owner's stored
   currency_symbol wins over any CLDR symbol on bills.
5. Held orders and applied charges keep their snapshots. Disabling a charge
   affects new orders only; an applied charge stays at its stored amount,
   and the cart clears waiver/opt-in choices when loading another order.
   Moving table binding or held-order logic must not lose held state or
   silently recalculate an open order.

**4. Stage 1 plan: splitting the POS page**

Correction to the pack's framing: frontend/src/components/pos/ already
holds 20 extracted components, including ProductGrid, CartPanel,
PaymentModal (1,943 lines), PrepaidCheckoutModal (1,092 lines), and
TableCheckoutModal. What is still inline is one 3,210-line POSPage
component (frontend/src/app/(dashboard)/pos/page.tsx:239) holding all the
orchestration. Stage 1 extracts that orchestration, reusing the existing
cart and pos-settings stores unchanged, one seam per commit, pure moves
only, no behavior change, no bug fixes inside move commits.

Order, easiest and least coupled first:

1. Pure attempt helpers. Move the page-local attempt types, validators,
   and parsers (PostpaidAttempt/PrepaidAttempt, isUsable*, 
   parsePrepaidPaymentRequest, structured-help capture map, around
   page.tsx:99-238) into frontend/src/lib/pos/, but only after checking
   overlap with the existing frontend/src/lib/order-attempt.ts and
   frontend/src/lib/append-attempt.ts — reuse wins, no duplicates.
2. Printing helpers. Extract printKotIfEnabled, printBillForTenant, and
   fetchLatestBill (page.tsx:961-1077) into a usePosPrinting hook. Small
   surface, oracle-guarded.
3. Table workspace binding. Extract the query-string workspace capture,
   table selection, hold, add-items, and bill-request handlers
   (page.tsx:2192-2510) into a usePosTableWorkspace hook, keeping the
   existing table modals' wiring intact.
4. Order submission last, and only then. Extract handlePlaceOrder
   (page.tsx:1346), handlePrepaidCheckout (page.tsx:1656),
   handlePaymentComplete, and the attempt refs/storage/reporting
   (page.tsx:458-940) into a usePosOrderSubmission hook. Idempotency refs
   must keep single-instance semantics across the extraction, with no
   remount resetting them. If coverage looks thin anywhere here, add a
   pinning test before moving, and stop at the first unexplained red.
5. Slim the shell. Leave page.tsx as composition only: state ownership
   audit, topbar, grid, cart, and modals. No changes to the big modals'
   internals in this stage, and keep the lazy-loaded print-menu modal lazy.

Protecting suites, run serially with `npm run clean` between each and proxy
unset except build:frontend: lint, build:frontend, i18n:check, then
held-orders, held-orders-store, issue-255-pos-cart-retry,
issue-788-order-attempt-storage, integration-order-hold-payment,
integration-payments, cart-variant-identity, cart-price-override,
pos-keyboard-shortcuts, pos-catalog-sort, pos-sort-settings,
variant-pos-surface, addon-inventory-pos-surface,
payment-modal-currency-adapter, charges-engine, bills-print-api, and
receipt-column-oracle before and after every printing-adjacent step. Stop
conditions: any previously green suite turns red — revert the step and
report; any oracle byte diff — stop and report.

Next: awaiting the go-ahead to start Stage 1 step zero (baseline run).
