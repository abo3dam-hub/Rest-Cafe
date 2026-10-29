From: assistant
To: ted
Kind: status
Thread: 20261030-001
Subject: Stage 1 seam 1 — attempt types and validators moved, baseline green

Stage 1 partial hand-back. One seam is done and verified. The remaining
seams are not done in this PR; the reasons and the next seams are below.
Nothing in this PR changes behavior. A PR is a proposal, never a merge.

**Baseline (branch base upstream main 9782dde, before any move)**

Run serially, `npm run clean` between suites, proxy unset except
`build:frontend`. All green: lint (backend 964 warnings, budget 1000;
frontend 0/0), i18n:check, held-orders (includes the held-orders-store
file), issue-788-order-attempt-storage, issue-255 (cart plus append),
integration-order-hold-payment (87/87), integration-payments (11),
cart-variant-identity, cart-price-override, pos-keyboard-shortcuts,
pos-catalog-sort, pos-sort-settings, variant-pos-surface,
addon-inventory-pos-surface, payment-modal-currency-adapter,
charges-engine (196/196), bills-print-api (34/34),
receipt-column-oracle, build:frontend. Logs are local only, in
~/workspace/rest-cafe-docs/stage1-baseline-2026-10-30/.

Correction to the intro report: there is no separate
`test:held-orders-store` script. The `test:held-orders` script runs both
`held-orders.test.ts` and `held-orders-store.test.ts`. Likewise the
issue-255 coverage is `test:issue-255`, which runs the cart retry file
and the append idempotency file.

**What moved (one commit)**

Commit: `refactor(pos): move attempt types and validators to
lib/pos/order-attempts`. File map: `frontend/src/app/(dashboard)/pos/page.tsx`
(3,210 lines) lost its inline attempt block and now imports it;
`frontend/src/lib/pos/order-attempts.ts` (new) holds the verbatim block:
`POSTPAID_ATTEMPT_STORAGE_KEY`, `PostpaidAttempt`, `PrepaidAttempt`,
`PrepaidPaymentRequest`, `SupportOperationFailure`,
`OPERATION_REFERENCE_V4`, `STRUCTURED_HELP_CAPTURE_POINTS`,
`isUsablePostpaidAttempt`, `isUsablePrepaidAttempt`, and
`parsePrepaidPaymentRequest`, exported, with type-only imports added.
No logic was edited. One import was dropped after lint flagged it:
`PrepaidPaymentRequest` is used only inside the moved parser, not by the
page, so the page does not import it. That was the only change after the
first verification run, and lint was re-run to 0/0. The pre-commit
formatter also normalised five unrelated whitespace spots in page.tsx
(line breaks only, no logic); that churn is in the same commit and is
the disclosed hook behavior, not a behavior change.

**Verification after the move**

Lint (backend 964 warnings, unchanged; frontend 0/0), issue-255,
issue-788-order-attempt-storage, held-orders,
integration-order-hold-payment (87/87), integration-payments (11),
bills-print-api (34/34), receipt-column-oracle (green, no golden change),
build:frontend. No previously green suite turned red. No printing golden
changed bytes.

**Why the remaining seams stop here**

Inspection before moving showed the rest of the page-local attempt code
is not pure. The read/save/clear helpers (page.tsx:479-658 at the base),
`newIdempotencyKey`, and `buildCurrentCartFingerprint` are closures over
component state, refs, storage and the cart store, and the existing
`frontend/src/lib/order-attempt.ts` and `frontend/src/lib/append-attempt.ts`
already own the generic storage machinery. Extracting those closures as
pure lib functions would require parameterising every dependency and
changing every call site. That is not a pure move. The printing helpers,
table workspace handlers and order submission handlers have the same
shape: they must move as hooks carrying their state together, in that
order, with the same verification after each hook. That work is next,
as separate commits, and was not folded into this PR.

**Honest limits**

Windows runtime, real printing and touch were not verified here. The
receipt-column oracle was green, which pins the printed bytes in this
environment only. Physical-printer verification remains outstanding on
the owner's machine.

**Next**

Seam 2: printing helpers as a hook. Seam 3: table workspace binding as
a hook. Seam 4: order submission as a hook, last and only after seams
2-3 are green. Seam 5: slim the page to composition only. Each seam
gets its own commit and the same protecting suites before any hand-back.
