From: assistant
To: ted
Kind: status
Thread: 20261102-037
Subject: Delivery 2 status — the POS survives a Wi-Fi drop (F-003, F-011, F-012, F-014, F-028)

# Delivery 2 — the POS survives a Wi-Fi drop

Base: upstream main `6745ec411d8651107f9c936ccde2c173ab985aed`.
Branch: `assistant/auditfix-d2-hung-sale`.
Assignment thread: 20261102-037 (production-audit fix round, owner-approved).

All five Delivery 2 findings are implemented. No production behaviour
outside the five findings changed: money math, tax, settlement semantics,
refund fee-share, cancel-with-collected-amounts, duplicate-payment
200/400 semantics, and the two reservation contrast lines are untouched.
No receipt-oracle byte change (oracle green, see battery).

## F-003 — request timeout in the shared API client

`frontend/src/lib/api.ts`: the shared axios instance now carries
`timeout: API_REQUEST_TIMEOUT_MS` (`10_000`, exported), the same ceiling
the KDS REST poll already uses (`KDS_REST_REQUEST_TIMEOUT_MS = 10_000`
in `useKdsConnection.ts`; the dashboard KDS passes its own per-request
timeout, so its behaviour is unchanged). Mutations and reads are both
covered — the timeout is on the instance, not per call. A half-open
connection now fails visibly after 10 s and the existing failure/retry UX
runs (failure classification, diagnostics capture, manual retry).

Printing paths keep their own behaviour: requests that await a physical
print dispatch or a printer scan pass an explicit longer ceiling,
`LONG_API_REQUEST_TIMEOUT_MS` (`30_000`, exported from `api.ts`), because
the backend CUPS dispatch alone allows 20 s (`main/printers/print-transport.ts`)
and printer detection caps at 10 s — the 10 s default would cut off their
reply while the print still happened. Call sites:
`usePrinter.ts` (`/printers/print-bill`, `/printers/print-kot`,
`/printers/print-delivery-slip`), `orders/page.tsx` and `tables/page.tsx`
(`POST /bills/:id/print`), `PrintMenuModal.tsx`
(`POST /printers/print-menu`), `StatusBar.tsx` (`/printers/test-active`,
`/printers/kick-drawer`), `PrintersSettingsTab.tsx`
(`GET /printers/detect`). Blob downloads (DB export, reports, CSVs) stay
on the 10 s default: aborting a GET has no side effect and the failure is
visible and retryable, which is the intended F-003 behaviour.

## F-011 — POS cart draft persists

New `frontend/src/lib/cart-draft.ts` (`CART_DRAFT_STORAGE_KEY =
'pos-cart-draft'`) plus a zustand `persist` wrapper on
`frontend/src/store/cart.ts` — the `pos-settings.ts` pattern (`persist`
middleware, named key, versioned). Every cart change persists the draft:
items, order type, table, held-order id, customer, guest count, delivery
and order notes, and the waived/opted-in charge decisions (Sets stored as
plain arrays). Placing the order clears the cart, which clears the draft.
A reload, a 401 navigation to `/auth/login`, or a crash restores the
in-progress cart on the next POS mount. A damaged draft restores nothing
rather than a half cart (lines without a product or quantity are dropped;
a non-array `items` rejects the whole draft). Held orders are server-side
and unchanged. Storage resolves `localStorage` when the renderer offers
it, else one shared in-memory store (tests, SSR prerender, restricted
renderers); the factory never throws, and zustand logs (never breaks the
sale on) a denied write. One known limit, same as `pos-settings`: the
draft is per device, not per user — on a shared till a second cashier sees
the first cashier's draft, exactly as held orders are already shared.

## F-012 — POS catalog load retries with backoff

`frontend/src/hooks/usePosCatalog.ts`: the mount load now retries
transient failures (`isTransientRequestError`, new in `api.ts`: no response
arrived, or a 5xx — a 4xx answer fails fast) up to
`POS_CATALOG_RETRY_ATTEMPTS = 12` times every
`POS_CATALOG_RETRY_DELAY_MS = 5000`, the KDS enabled-check pattern
(`kds-standalone/page.tsx`, `useKdsEnabledCheck`) verbatim. The
`menuLoadFailed` toast fires only after the retries are exhausted. The
hook exposes `catalogRetrying` so the POS can show the retry state.

## F-014 — persistent offline indicator in the POS

New `frontend/src/hooks/usePosConnectivity.ts` plus
`frontend/src/components/pos/PosOfflineIndicator.tsx`, rendered in
`frontend/src/app/(dashboard)/pos/page.tsx` under the topbar. The hook
combines the browser `online`/`offline` events with the shared client's
outcome events: `api.ts` dispatches `flo:api-offline` on a transport
failure (no response arrived — timeout, refused, DNS) and `flo:api-online`
on any confirmed response, on transition only. While offline the POS
shows a persistent red strip (red dot + "غير متصل — تحقّق من الشبكة قبل
متابعة البيع"); while the catalog load is retrying it shows an amber
strip ("جارٍ إعادة تحميل القائمة…"). Unlike a toast it does not disappear
until connectivity returns. This is the KDS red-dot equivalent
(`KdsHeader.tsx`: green/red dot + connection label).

## F-028 — stale postpaid attempts are surfaced

`frontend/src/lib/pos/order-attempts.ts`: new `describePostpaidAttempt`
(item count + table recovered from the attempt fingerprint, which is the
order payload; confirmed order number when present) and
`isStalePostpaidAttempt` (an attempt is stale when its fingerprint differs
from the current cart's — an attempt for the current cart is the live
retry, not stale). `frontend/src/hooks/usePosOrderSubmission.ts`: a
mount effect — same once-per-user shape as the append replay — reads the
stored postpaid attempt after the cart draft has restored and, when it is
stale, exposes it to the POS page, which renders
`frontend/src/components/pos/PosStaleAttemptBanner.tsx` (amber banner:
what the sale was, "تحقّق من الحالة" / "تجاهل مؤقتاً"). Recovery replays
`POST /orders` with the stored payload under the ORIGINAL idempotency
key, so the server returns the already-created order when the first
response was lost and creates it when it never arrived; the recovered
order prints its KOT and the tables refresh, and the current cart — which
may hold a different sale by now — is left alone. An attempt that already
has a confirmed order is never re-sent: it just clears its record.
Dismissing is session-only while the outcome is unknown (the record stays
stored and the banner returns on the next mount). Cleanup is guarded by
key + fingerprint: a newer sale may have taken the storage key since the
banner appeared, and its record is never destroyed by cleaning up the old
one. Duplicate prevention is exactly as strong as before: the same key is
reused, never a fresh one; the helpers never mutate the attempt.

## New suite

`tests/pos-wifi-drop.test.ts`, wired as `test:pos-wifi-drop` in
`package.json` (script definition + `test` chain, next to
`test:issue-788-order-attempt-storage`). Throwing asserts from
`tests/helpers/test-setup.ts`. 51 assertions: timeout constants, transient
classification, catalog retry schedule, draft serialize/parse round trip
(including damaged drafts), live-store persist + rehydrate + clear, and
the stale-attempt helpers (including that they never mutate the attempt
or its idempotency key). The React retry loop and mount surfacing are
exercised through these same helpers and constants; the hook wiring is
covered by lint, tsc and `build:frontend`.

## Files changed (20)

- `frontend/src/lib/api.ts` — timeouts, reachability events, transient predicate
- `frontend/src/lib/cart-draft.ts` — new: draft serialize/parse/storage
- `frontend/src/store/cart.ts` — persist wrapper
- `frontend/src/hooks/usePosCatalog.ts` — retry with backoff + `catalogRetrying`
- `frontend/src/hooks/usePosConnectivity.ts` — new: connectivity hook
- `frontend/src/components/pos/PosOfflineIndicator.tsx` — new
- `frontend/src/components/pos/PosStaleAttemptBanner.tsx` — new
- `frontend/src/hooks/usePosOrderSubmission.ts` — stale-attempt surfacing + recovery
- `frontend/src/lib/pos/order-attempts.ts` — describe/isStale helpers
- `frontend/src/app/(dashboard)/pos/page.tsx` — renders both banners
- `frontend/src/hooks/usePrinter.ts` — long timeout on 3 print dispatches
- `frontend/src/app/(dashboard)/orders/page.tsx` — long timeout on 2× `/bills/:id/print`
- `frontend/src/app/(dashboard)/tables/page.tsx` — long timeout on `/bills/:id/print`
- `frontend/src/components/products/PrintMenuModal.tsx` — long timeout on print-menu
- `frontend/src/components/layout/StatusBar.tsx` — long timeout on test-active/kick-drawer
- `frontend/src/components/settings/PrintersSettingsTab.tsx` — long timeout on detect
- `frontend/src/lib/i18n/messages/ar.json` + `en.json` — 8 new `pos` keys each
  (`catalogRetrying`, `offlineIndicator`, `staleAttemptTitle`,
  `staleAttemptBody`, `staleAttemptBodyUnknown`, `staleAttemptPlaced`,
  `staleAttemptRecover`, `staleAttemptDismiss`); frozen locales untouched
- `package.json` — `test:pos-wifi-drop` + chain wiring
- `tests/pos-wifi-drop.test.ts` — new suite, 51 assertions

## Battery

Standard battery plus the D2 area suites. Run serially with the proxy
unset except `build:frontend` (proxy on), `npm run clean` between suites.
`npm run` itself is currently EPERM-blocked by the environment write
fault (npm fails writing its own log/cache), so the equivalent direct
commands were used where the script is a plain binary invocation
(`./node_modules/.bin/ts-node …`, `./node_modules/.bin/oxlint …`,
`node tests/…`, `node scripts/…`); `npm run` will be retried for the
final pass when the fault clears.

GREEN so far:
- `test:pos-wifi-drop` — 51 passed, 0 failed
- `test:issue-788-order-attempt-storage` — passed (before and after the change)
- `test:issue-255` cart half — passed (before and after the change)
- lint (oxlint): backend 969 warnings / 0 errors (budget 1000, unchanged
  from the audit baseline), frontend 1 warning / 0 errors (the 1 warning
  is pre-existing in `TaxConfigurationPanel.tsx`, untouched here); the 16
  changed/new frontend files lint 0/0
- `test:script-coverage` — validator (261 reachable, 8 excluded; 311 run
  by the default suite), command parsing, harness assertions — all green
- `i18n:check` — translations integrity ✅ all passed (ar/en 3508 leaf
  keys each, frozen locales 3477); print-labels drift check passed;
  `tsc --noEmit -p frontend/tsconfig.json` clean (run with
  `--incremental false` — see blocked note; the exact scripted command
  fails only on the tsbuildinfo cache write)
- `docs:check` — markdownlint 0 issues, 324 links OK, index 35 pages /
  38 links, policy 1 pre-existing non-gating phase-numbering warning
- `test:receipt-column-oracle` — fail 0 (no byte change)
- `git diff --check` — clean
- root `tsc --noEmit` (main + shared) — clean

NOT RUN — published without a local battery by owner decision (see below).
The items below are environment-blocked, not skipped; Ted's battery before
landing is the gate and still stands:
- `npm run build` — backend `tsc` emit fails `TS5033 … EPERM` writing
  `dist/` (dist is currently 693 files, all 0 bytes — the fault's damage
  from the earlier rebuild attempt, gitignored)
- `npm run build:frontend`
- `test:lint-engine` — suite writes fixture files; the first run died
  mid-write (EPERM) and left a 0-byte `shared/__lint_parity_forbidden.ts`,
  which the suite then refuses to overwrite (removed; still blocked)
- `test:translations` negative tests — fixture write EPERM (the positive
  integrity checks all passed, see above)
- `test:issue-255-append`, `test:cashier-workspace`, `test:full-house`,
  `test:restaurant-day-cycle` — `SQLITE_IOERR_WRITE` creating the test
  database in `/tmp` at suite setup, before any assertion runs

## Environment fault (blocking the battery, not the code)

The VM write fault from Delivery 1 is still active: shell/python writes
fail intermittently with `EPERM: Operation not permitted` (and SQLite
writes fail as `SQLITE_IOERR_WRITE`), across all filesystems including
tmpfs; disk is 2% used. Small writes sometimes succeed, larger/chunked
writes fail. File-tool writes work. Local git object/ref writes are still
broken (local `upstream/main` ref stays stale at `9a7e81e`); every file in
this delivery was verified byte-identical to upstream main `6745ec4` via
the GitHub API (`get-file` blob SHA vs local `git hash-object`) before
editing. `npm run` is unusable while the fault holds (npm itself cannot
write), so direct binary invocations were used for the green runs above.
The fault comes in waves; the blocked battery items were retried as it
cleared, without success (nine waiter runs, all blocked on `build-tsc`).

Owner decision (Ali, chat 2026-11-02 ~12:26): after the /tmp build attempt
below failed identically, publish this delivery WITHOUT a local battery
and say so plainly here. Ted's battery before landing is the gate and
still stands — nothing lands on main without it. /tmp build attempt
(2026-11-02 12:28 +03, one proper attempt, owner-ordered): `tsc --outDir
/tmp/d2-build-test/out` on the repo tsconfig — exit 2, every emit a
TS5033 EPERM on a /tmp path (e.g. `error TS5033: Could not write file
'/tmp/d2-build-test/out/main/application-menu.d.ts': EPERM: operation not
permitted, write.`), 693 files created, 0 non-empty — the identical
signature as `dist/`. No type errors (no TS2xxx): the code typechecks;
only the writes fail. The fault is therefore NOT path- or
filesystem-specific (tmpfs fails exactly like the home overlay), and no
further local retry can clear it; only a host-side fix (VM
restart/replacement) would. The fault has held build writes ~34 h with
only second-scale open flickers. A proper /tmp-vs-home comparison was
also attempted earlier the same morning and was inconclusive (the
tsconfig writes themselves failed EPERM, so both runs fell back to the
same default emit path); the 12:28 attempt used a CLI `--outDir`
override with no config file to write, so its result stands.

## Disclosures

- No pre-commit hook ran: local git writes are broken, so the code was
  not committed locally; publishing is one API commit per file (each blob
  SHA verified against the local file). The files follow the existing
  formatting (oxlint 0/0 on all changed/new frontend files; `git diff
  --check` clean).
- No physical-printer verification: no printing behaviour changed (only
  request timeouts on the print paths, with the longer ceiling that
  preserves their behaviour). The owner's physical-printer verification
  remains outstanding, as before.
- No `docs/production-readiness/*` edits. No money, tax, settlement,
  refund, or duplicate-payment semantics changed.
- F-013 stays closed per decision 038 (not this delivery's concern).

## Not done

- Nothing in the Delivery 2 scope was left undone. The battery items
  listed above as NOT RUN are environment-blocked, not skipped: the
  local battery never went green (see the owner decision above), and
  this PR is published without it so Ted's battery on his host — the
  gate before landing — can judge the delivery. If Ted's battery finds
  a real failure, the delivery is fixed in a follow-up, not landed.
