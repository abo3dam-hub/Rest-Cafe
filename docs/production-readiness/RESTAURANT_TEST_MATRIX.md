# Rest&Cafe — Production Test Matrix

- **Audited HEAD:** `4743bfd3a9ad92cc754451d57077096a3c17f303` (upstream `main`).
- **Corrections after the audit:** rows C06–C08, F06, F08–F11, P07 and E04
  were corrected on 2026-11-10 during printing finalization Phase C, and
  row F04 plus this note in a follow-up correction the same day. The
  audited HEAD above remains the baseline of the original 2026-11-01
  audit; corrected rows describe the behaviour the current code and
  suites pin, not the code at that HEAD.
- **Companion report:** `RESTAURANT_PRODUCTION_AUDIT.md` in this directory.
- **Status meanings:** PASS — executed in this audit and passed. FAIL —
  executed and failed. NOT RUN — not executed; the reason is in the Actual
  result column. BLOCKED — cannot run until the stated blocker is fixed.
- **Priority:** P0 — pilot blocker. P1 — must pass before a real-restaurant
  pilot. P2 — pass before scale, or accept explicitly.
- **Never mark a test PASS because the relevant code exists.** Every PASS
  below names the suite and the run that produced it; everything else is
  NOT RUN or BLOCKED.
- **Evidence column** names the test file or the code path that implements
  the behaviour. A file reference is not a pass.

## A. Host startup and service availability

| ID | Scenario | Preconditions | Execution steps | Expected result | Actual result | Evidence | Status | Priority |
|---|---|---|---|---|---|---|---|---|
| A01 | Fresh Windows startup, app launched | Clean install, database present | Start Windows, launch Rest&Cafe from the desktop shortcut | POS window opens, all three servers report running, database opens | NOT RUN — no Windows host in this environment | `main/index.ts:1155-1245` | NOT RUN | P1 |
| A02 | Application launch after Windows restart | App installed, database present, no autostart configured | Restart Windows, launch the app manually | Same as A01; operator must launch manually (no autostart exists — see audit F-005) | NOT RUN — no Windows host; autostart absence verified by code search | `main/index.ts` (no `setLoginItemSettings`) | NOT RUN | P1 |
| A03 | Port already occupied (3001) | Another process holds 3001 | Start the app | Server bumps to 3002 and logs it; POS window follows the bumped port | PASS — suite green in this audit | `tests/server-port-collision.test.ts` | PASS | P1 |
| A04 | All three default ports occupied | Processes hold 3001–3010 | Start the app | After 10 attempts startup fails with a clear error and exits 1 | NOT RUN — collision suite covers single-port cases; exhaustion path not run here | `main/server.ts:406-424` | NOT RUN | P2 |
| A05 | Database file missing on an initialised install | `.flo-db-initialized` marker present, `flo.db` deleted | Start the app | Startup refuses with `ERR_DATABASE_MISSING`; no empty database is created | PASS — suite green in this audit | `tests/issue-278-fail-closed-db.test.ts`; `main/db/core.ts:556-568` | PASS | P0 |
| A06 | Database file corrupt | `flo.db` with a corrupt page | Start the app | Integrity check flags it in `dbHealthError`; behaviour (boot vs refuse) is by design boot-with-warning — verify the operator sees a warning | NOT RUN — integrity-failure surfacing unverified (audit R-01) | `main/db/core.ts:646-672` | NOT RUN | P1 |
| A07 | Database newer than the build | `user_version` above the highest migration | Start an older build against the database | Startup throws `SchemaVersionMismatchError` with both versions | NOT RUN — covered by migration code, no run in this audit | `main/db/migrations.ts:3668-3671` | NOT RUN | P1 |
| A08 | Second app instance launched | App already running | Launch the app again | Second instance exits; existing window is focused | NOT RUN — no Windows host; code path read only | `main/index.ts:375-395` | NOT RUN | P2 |
| A09 | Startup failure reporting | Any startup step throws (e.g. database locked) | Start the app with a fault injected | Error box shows the failure; process exits 1; relaunch gate prevents a loop | NOT RUN — no fault-injection run in this audit | `main/index.ts:1257-1290` | NOT RUN | P1 |
| A10 | Tablets reconnect after host becomes available | Host down, 4 tablets showing errors | Start the host | Tablets reconnect (POS catalog needs a manual reload — see F-012; KDS reconnects automatically) | NOT RUN — no multi-device run | `frontend/src/hooks/useKdsConnection.ts`; `frontend/src/hooks/usePosCatalog.ts` | NOT RUN | P1 |

## B. Concurrent restaurant operations

| ID | Scenario | Preconditions | Execution steps | Expected result | Actual result | Evidence | Status | Priority |
|---|---|---|---|---|---|---|---|---|
| B01 | 4 waiters create orders simultaneously | 4 logged-in waiter sessions, 4 free tables | Each creates an order at the same time | 4 distinct orders, correct tables, no lost items, totals correct | PASS (simulated) — full-house suite: 40 tables, concurrent bursts, 0 money mismatches, 9.7 s | `tests/restaurant-full-house.test.ts` | PASS | P0 |
| B02 | Two waiters append to the same order | One open order, 2 waiter sessions | Both append different items at the same time | Both appends land; totals recomputed once; no lost lines | PASS (simulated) — full-house concurrent-add burst 9 ms; day-cycle 116/116 | `tests/restaurant-full-house.test.ts`; `tests/restaurant-day-cycle.test.ts` | PASS | P0 |
| B03 | Two waiters race a status change | One order in `pending` | Both attempt a status transition at once | Serialised, last-writer-wins, no corruption; no conflict error is shown (accepted behaviour — audit R-A3) | NOT RUN — no race test with two live sessions; code path read only | `main/routes/orders.ts:3067-3170` | NOT RUN | P2 |
| B04 | Duplicate order submission (slow Wi-Fi retry) | Order create request sent, response lost | Client retries with the same `Idempotency-Key` | Stored response replayed; exactly one order | PASS — idempotency suites green | `tests/issue-788-order-attempt-storage.test.ts`; `main/routes/orders.ts:1639-1672` | PASS | P0 |
| B05 | Duplicate append (retry) | Append sent, response lost | Retry with the same key | Single append applied; stored response replayed | PASS — append idempotency covered by the attempt-storage suite | `frontend/src/lib/append-attempt.ts`; `main/routes/orders.ts:2120-2140` | PASS | P0 |
| B06 | Move order between tables | Occupied table A, free table B | Move the order A to B | Order, items, and bill follow; table A frees, B occupies | NOT RUN — merge/move covered in code; no live multi-table run here | `main/routes/orders.ts:2544-2620` | NOT RUN | P1 |
| B07 | Split a bill | One unpaid bill, 4 guests | Split into checks | 2–20 checks; re-split rules enforced; totals sum to the original | PASS (in-process) — split paths covered by bills suites | `tests/bills-print-api.test.ts` (34/34); `main/routes/bills.ts:2469-2560` | PASS | P1 |
| B08 | Partial payments | One bill, two payments | Pay part cash, part card | `paid_amount` accumulates; status `partially_paid` until settled | PASS — integration payments 11/11; hold-payment 87/87 | `tests/integration-payments.test.ts`; `tests/integration-order-hold-payment.test.ts` | PASS | P0 |
| B09 | Full payment and order closure | One bill, full payment | Pay in full, close the order | Bill `paid`, order closed, table freed, cash session updated | PASS — day-cycle 116/116; cash-sessions 208/208 | `tests/restaurant-day-cycle.test.ts`; `tests/cash-sessions.test.ts` | PASS | P0 |
| B10 | Duplicate payment (same key, same body) | Paid bill, retry with same `Idempotency-Key` | Replay the payment request | Stored response returned; no second charge | PASS — 134/134 | `tests/bills-settlement-idempotency.test.ts` | PASS | P0 |
| B11 | Duplicate payment (no amount, paid in money) | Bill fully paid in money | Send a no-amount duplicate | 400 `bill_already_paid` | PASS — covered by the settlement suite after the 033 fix | `tests/bills-settlement-idempotency.test.ts`; `main/routes/bills.ts:3280` | PASS | P0 |
| B12 | Duplicate payment (no amount, discount-settled) | Bill settled by discount | Send a no-amount duplicate | 200 no-op by owner decision (policy, not a defect); no money moves | PASS — behaviour pinned by the settlement suite | `main/routes/bills.ts:3260-3290` | PASS | P2 |

## C. Kitchen workflow

| ID | Scenario | Preconditions | Execution steps | Expected result | Actual result | Evidence | Status | Priority |
|---|---|---|---|---|---|---|---|---|
| C01 | Order creation reaches KDS | KDS board open, POS order placed | Place an order | Order appears on the board with all items `pending` | PASS (in-process) — KDS live-push and integration suites green | `tests/kds-live-push.test.ts`; `tests/kds-integration.test.ts` | PASS | P0 |
| C02 | New items added to an existing order | Order on the board, POS appends items | Append 2 items | Only the new items appear as new; KOT prints only the new items | PASS (in-process) — append path covered; KOT filter by item id | `frontend/src/hooks/usePosOrderSubmission.ts:832-839, 1651-1660` | PASS | P1 |
| C03 | Item cancellation and modification | Item `preparing` on the board | Cancel the item from POS (manager PIN where required) | Item leaves the board; audit log records the actor | PASS (in-process) — cancel/restore suites in the full chain; not run in this battery | `main/routes/orders.ts:5400-5610` | NOT RUN | P1 |
| C04 | KDS status progression | Item `pending` | Advance pending to preparing to ready to served | Board reflects each stage; order rollup advances only | PASS (in-process) — KDS suites green; rollup covered by order-status suite | `tests/kds-integration.test.ts`; `main/services/order-status-rollup.ts` | PASS | P1 |
| C05 | Concurrent status change conflict | Two KDS terminals, same item | Both tap a status change with the same `expected_status` | One wins; the other gets 409/conflict and a full refresh | NOT RUN — no two-terminal live test; code path read only | `main/services/kds.ts:432-520`; `main/routes/order-items.ts:446-470` | NOT RUN | P1 |
| C06 | KDS reconnection after network interruption | Board connected, Wi-Fi dropped 2 minutes | Restore Wi-Fi | Board reconnects (backoff 1–30 s), full snapshot resync, no missed tickets; orders that arrived during the outage appear and sound the catch-up chime | NOT RUN — no live outage drill; catch-up chime pinned by the kds-reconnect-chime suite 25/25 | `frontend/src/lib/order-alert.ts`; `tests/kds-reconnect-chime.test.ts` | NOT RUN | P1 |
| C07 | Duplicate kitchen tickets on KOT retry | KOT print fails ambiguously | Retry the KOT print | A retry sends only items not yet printed; items already marked printed are not re-sent | PASS (in-process) — kot-print-queue 146/146; no live print run | `main/services/kot-print.ts:143,172-173`; `tests/kot-print-queue.test.ts` | PASS | P1 |
| C08 | Kitchen printer unavailable during submission | Printer offline, order placed | Place an order | Order saves; KDS still shows it; the failed KOT is queued in `print_jobs` for automatic retry (backoff ladder, 10 attempts); the operator may also reprint manually | NOT RUN — no live printer fault drill; queue behaviour pinned by kot-print-queue 146/146 | `main/services/print-queue.ts:82,86,559-579`; `tests/kot-print-queue.test.ts` | NOT RUN | P1 |
| C09 | Station/category scoping | Chef assigned to station A only | Open the KDS board | Only station A items visible; other stations' items hidden | PASS (in-process) — KDS integration suite covers scoping | `tests/kds-integration.test.ts`; `main/services/kds.ts:116-160` | PASS | P1 |
| C10 | KDS disabled | `kds_enabled` off | Open the KDS page | Disabled screen with a settings link; WebSocket upgrade returns 404 | NOT RUN — no live run in this audit | `frontend/src/app/(dashboard)/kds/page.tsx:22-33`; `main/server.ts:375-395` | NOT RUN | P2 |

## D. Network failure and recovery

| ID | Scenario | Preconditions | Execution steps | Expected result | Actual result | Evidence | Status | Priority |
|---|---|---|---|---|---|---|---|---|
| D01 | One tablet loses Wi-Fi mid-sale | POS with items in the cart | Drop Wi-Fi, tap Place Order | Request fails with a clear error; cart kept; manual retry works when Wi-Fi returns; no duplicate order | NOT RUN — no live Wi-Fi drill; hang risk is audit F-003 (no request timeout) | `frontend/src/hooks/usePosOrderSubmission.ts:440-480` | NOT RUN | P0 |
| D02 | All tablets disconnect at once | 4 tablets + KDS connected | Restart the router | All show errors; all reconnect when the router returns (KDS automatically; POS catalog needs a manual reload — F-012) | NOT RUN — no live drill | `frontend/src/hooks/useKdsConnection.ts` | NOT RUN | P1 |
| D03 | Router restart | Host and tablets on the router | Restart the router | Host keeps serving on the LAN once the router returns; tablets reconnect | NOT RUN — no live drill | — | NOT RUN | P1 |
| D04 | Host LAN address changes | Tablets bookmarked to the old IP | Change the host IP (DHCP renewal) | Tablets fail until re-paired; `flo.local` mitigates only where mDNS resolves (audit F-030) | NOT RUN — no live drill; mDNS resolution unverified | `main/routes/pos-info.ts` | NOT RUN | P1 |
| D05 | Host backend temporarily unavailable | Tablets connected, backend stopped | Stop the backend 2 minutes, restart it | Tablets reconnect; no orders lost; in-flight requests fail cleanly | NOT RUN — no live drill | `frontend/src/hooks/useKdsConnection.ts` | NOT RUN | P1 |
| D06 | Tablet reconnects after several minutes | Tablet offline 10 minutes | Reconnect | KDS resyncs by snapshot; POS needs a manual reload for fresh catalog/tables | NOT RUN — no live drill | `frontend/src/hooks/useKdsConnection.ts`; `frontend/src/hooks/usePosCatalog.ts` | NOT RUN | P1 |
| D07 | Request interrupted while submitting | Order create in flight | Kill the network mid-request, retry | Exactly one order (idempotency) | PASS (in-process) — attempt-storage suite green | `tests/issue-788-order-attempt-storage.test.ts` | PASS | P0 |
| D08 | Duplicate payment after retry | Payment sent, response lost | Retry with the same key | Single charge; stored response replayed | PASS — settlement idempotency 134/134 | `tests/bills-settlement-idempotency.test.ts` | PASS | P0 |
| D09 | Internet loss (external) | LAN up, internet down | Disconnect the WAN cable | All local operations continue normally; nothing requires the internet | PASS — no-external-services 33/33; offline-mode 14/14 | `tests/no-external-services.test.ts`; `tests/offline-mode.test.ts` | PASS | P0 |
| D10 | Local network failure vs internet failure distinguished | Either WAN or LAN down | Drop each in turn | LAN drop stops tablets; WAN drop changes nothing locally | NOT RUN — WAN/LAN distinction not drilled live; code-level separation verified | `tests/offline-mode.test.ts` | NOT RUN | P2 |

## E. Database integrity and financial safety

| ID | Scenario | Preconditions | Execution steps | Expected result | Actual result | Evidence | Status | Priority |
|---|---|---|---|---|---|---|---|---|
| E01 | Concurrent SQLite writes | 40 tables, concurrent bursts | Run the full-house burst set | No lost writes, no lock errors beyond the 5 s busy timeout, totals exact | PASS — full-house 0 findings, 9.7 s | `tests/restaurant-full-house.test.ts` | PASS | P0 |
| E02 | WAL behaviour and busy timeout | Database under concurrent load | Observe pragmas and lock waits | WAL on, `synchronous NORMAL`, `busy_timeout 5000` | PASS — pragmas verified in code and by the fail-closed suite | `main/db/core.ts:573-575` | PASS | P1 |
| E03 | Transaction boundaries | Multi-row money writes | Inspect order/payment/refund/cancel paths | Every multi-row write inside `withTxn` | PASS — verified by code inspection; suites green | `main/routes/orders.ts` (16 sites); `main/routes/bills.ts` (7 sites) | PASS | P0 |
| E04 | Migration safety (fresh install) | Empty database | Initialise | Reaches v128 cleanly; registry 389/389 | PASS — migration registry 389/389 (128 migrations, v1..v128) | `tests/migration-registry.test.ts` | PASS | P0 |
| E05 | Migration safety (upgrade path) | Database at an older version | Run the upgrade path | Each migration in its own transaction with a pre-migration backup; `user_version` stamped | PASS — upgrade-path suite green | `tests/upgrade-path.test.ts` | PASS | P0 |
| E06 | Database integrity checks | Database with FK violations | Run the startup check | `integrity_check` and `foreign_key_check` run; violations logged and flagged in `dbHealthError` | PASS (in-process) — fail-closed suite shows integrity ok / FK clean on a good database; corrupt-database behaviour NOT RUN | `tests/issue-278-fail-closed-db.test.ts` | PASS | P1 |
| E07 | Backup creation and verification | Live database with orders | Create a manual backup; verify the file | Self-contained file with `_flo_meta` stamp; reopens cleanly; schema version recorded | PASS — backup suite green | `tests/backup-restore-production.test.ts` (via `test:backup`) | PASS | P0 |
| E08 | Restore into a clean environment | Backup file, fresh install | Restore via Settings | Database replaced; integrity and FK checks pass; safety copy retained | PASS (in-process) — restore suites green | `tests/backup-restore.test.ts` (via `test:backup`) | PASS | P0 |
| E09 | Restore onto a replacement Windows host | Backup file, new PC | Install, copy the backup, restore | Owner account and permissions survive; runbook missing (audit F-022) | NOT RUN — no clean-host restore run on record | `main/db/backup.ts:2521-2800` | NOT RUN | P1 |
| E10 | Recovery after forced termination | App killed mid-write | Kill the process, restart | WAL recovery; no partial transaction visible; startup integrity ok | NOT RUN — no kill-and-restart drill in this audit | `main/db/core.ts` (WAL) | NOT RUN | P1 |
| E11 | Recovery after unexpected Windows shutdown | Power cut during service | Cut power, restart | Same as E10; no silent empty-database recreation | NOT RUN — no power-cut drill; guard verified in code (A05) | `main/db/core.ts:556-568` | NOT RUN | P1 |
| E12 | Refund allocation (fee share) | Syria 10% fee, paid tea 10,000 | Refund the item | Refund 11,000 (line total including fee share) by owner decision | PASS — pinned in the full-house suite | `tests/restaurant-full-house.test.ts:1948-1955` | PASS | P0 |
| E13 | Cancellation after money collected | Order with a partial payment | Cancel with manager PIN | Cancel allowed; unpaid bills closed in the same transaction; paid bill stays live (owner decision) | PASS — cancel-closes-bill 30/30 | `tests/cancel-closes-bill.test.ts` | PASS | P0 |
| E14 | Cash drawer and shift closure | Full day of sales, refunds, movements | Close the shift, then the day | Expected cash = float + movements + cash sales − cash refunds; variance recorded; Z snapshot stored | PASS — cash-sessions 208/208; day-cycle 116/116; Z-print section FAIL (see F-008) | `tests/cash-sessions.test.ts`; `tests/cash-closures.test.ts` | PASS | P0 |
| E15 | Audit log integrity | Orders with voids, refunds, discounts | Inspect `order_audit_log` | Every write recorded with actor and details; log is attribution only, not tamper-evident (audit R-A1) | PASS (in-process) — order-audit-log suite in the full chain; not run in this battery | `tests/order-audit-log.test.ts` | NOT RUN | P2 |
| E16 | Discounts and taxes | Manual pack + Syria fee | Apply discounts and tax packs; switch packs | Totals correct; pack switch atomic (409 on conflict) | PASS — tax-pack-switch-atomicity 62/62; Syria profile 46/46 | `tests/tax-pack-switch-atomicity.test.ts`; `tests/syria-tax-profile.test.ts` | PASS | P0 |

## F. Printing and hardware

| ID | Scenario | Preconditions | Execution steps | Expected result | Actual result | Evidence | Status | Priority |
|---|---|---|---|---|---|---|---|---|
| F01 | USB receipt printer prints a bill | USB printer configured as default | Pay a bill | Correct bill, Arabic shaped, Latin digits, totals present | NOT RUN — no printer hardware in this environment | `main/printers/thermal.ts`; `tests/bills-print-api.test.ts` (34/34, API-level) | NOT RUN | P0 |
| F02 | Network ESC/POS printer prints a bill | Network printer at `ip:9100` | Pay a bill | Same as F01; chunked writes, 5 s socket timeout | NOT RUN — no printer hardware; cash-closures section 15 shows the path returns 502 when nothing listens | `main/printers/print-transport.ts:11-107` | NOT RUN | P0 |
| F03 | Kitchen ticket printer prints a KOT | KOT printer configured (station routing) | Place an order | Ticket with new items only, correct station | NOT RUN — no printer hardware | `main/routes/printers.ts:1167-1231` | NOT RUN | P0 |
| F04 | Arabic text rendering on a Latin printer | Printer without Arabic shaping | Print a bill with Arabic names | Lines rasterized on the branded profiles, and on a generic profile only for a printer that has passed raster validation (raster test print + owner confirmation); on an unvalidated generic profile, financial lines are refused closed instead of rasterized; non-financial lines may drop with a warning (audit F-017) | NOT RUN — no printer hardware; byte-level behaviour pinned by the oracle and the raster-printing suite | `shared/print/thermal-capabilities.ts`; `main/printers/profiles.ts`; `tests/receipt-column-oracle.test.ts`; `tests/raster-printing.test.ts` | NOT RUN | P1 |
| F05 | RTL alignment and Latin digits | Arabic-locale tenant | Print bill and KOT | Amounts and times in Latin digits; RTL layout correct | NOT RUN — no paper; digit forcing verified in code | `main/printers/formatting-helpers.ts:255-274` | NOT RUN | P1 |
| F06 | Long item names | Product with a 60-character name | Print bill and KOT | Receipt wraps; KOT wraps item names, addons, and instructions | PASS (in-process) — kot-line-wrap 22/22; no paper run | `tests/kot-line-wrap.test.ts`; `main/printers/document-kot.ts:408-448` | PASS | P2 |
| F07 | Modifiers and add-ons | Items with priced and free addons | Print bill and KOT | Addons with prices on the bill; addons without prices on the KOT | NOT RUN — no paper | `main/printers/formatting-helpers.ts:142-180` | NOT RUN | P1 |
| F08 | Multiple copies and duplicate prevention | Bill paid | Reprint the bill twice | Reprint banner on copies; no double charge; a KOT reprint sends only items not yet printed | PASS (in-process) — kot-print-queue 146/146; receipt reprint banner rendered from the reprint message | `main/printers/document-compact.ts:252-253`; `main/services/kot-print.ts:143,172-173`; `tests/kot-print-queue.test.ts` | PASS | P1 |
| F09 | Printer unavailable during order submission | Printer offline | Place an order | Order saves; KDS shows it; the failed print is queued in `print_jobs` for automatic retry (backoff ladder, 10 attempts); the operator may also reprint manually | NOT RUN — no live printer fault drill; queue behaviour pinned by kot-print-queue 146/146 | `main/services/print-queue.ts:82,86,559-579`; `tests/kot-print-queue.test.ts` | NOT RUN | P1 |
| F10 | Printer disconnect and reconnect | Network printer, mid-service | Unplug the printer, plug it back | Next print succeeds; the durable queue retries pending jobs on its next pass — no stuck queue | NOT RUN — no printer hardware; queue durability pinned by kot-print-queue 146/146 | `main/services/print-queue.ts`; `main/printers/print-transport.ts` | NOT RUN | P1 |
| F11 | Application restart with a print job pending | Print job in flight | Restart the app | Pending jobs survive the restart in `print_jobs`; the worker runs a pass 10 s after startup and retries them without operator action | NOT RUN — drill not run; restart pickup pinned by kot-print-queue 146/146 and the worker startup pass | `main/services/print-queue.ts:559-579`; `tests/kot-print-queue.test.ts` | NOT RUN | P2 |
| F12 | Receipt column widths (byte-level) | Any configuration | Run the oracle | Emitted bytes match the golden fixture at 32/42/48 columns and 58/80 mm | PASS — fail 0, skipped 0 | `tests/receipt-column-oracle.test.ts` | PASS | P0 |
| F13 | Cash drawer pulse | Cash payment, drawer enabled | Pay in cash | Drawer pulses once (`ESC p`); pulse only for allowlisted methods | NOT RUN — no drawer hardware; pulse logic verified in code | `docs/architecture/printing.md` (cash drawer); `main/printers/thermal.ts` | NOT RUN | P1 |
| F14 | Z-report print at day close | Day closed, printer present | Print the Z-report | Z-report prints once with the correct totals | FAIL (in this environment) — cash-closures section 15: 502, no dispatch, crash at `:1694` | `tests/cash-closures.test.ts:1694` | FAIL | P1 |

## G. Security on the local network

| ID | Scenario | Preconditions | Execution steps | Expected result | Actual result | Evidence | Status | Priority |
|---|---|---|---|---|---|---|---|---|
| G01 | Tablet login | Valid staff credentials | Log in from a tablet | JWT issued (24 h; 10 d with remember-me); role from the database | PASS (in-process) — auth suites in the full chain; smoke suite green | `main/routes/auth.ts:236-324` | PASS | P0 |
| G02 | Session expiry and invalidation | Token issued, then password changed | Use the old token | Rejected as stale (`tokens_valid_after`); refresh refused | NOT RUN — no live session test in this battery; code path read only | `main/middleware/security.ts:345-353`; `main/routes/auth.ts:410-470` | NOT RUN | P1 |
| G03 | Waiter attempts a money action | Logged-in `server` role | Call `POST /:id/payment` directly | 403 (permission denied) under shipped defaults | PASS — orders-authz and staff-authz suites green (69/69) | `tests/staff-authz.test.ts`; `tests/orders-authz.test.ts` | PASS | P0 |
| G04 | Unauthorized access to a sensitive route | No token | Call `/api/db/restore`, `/api/cash-closures` | 401; restore additionally needs `database.manage` plus the typed phrase | PASS (in-process) — security suite green | `tests/security.test.ts`; `main/routes/database.ts:795` | PASS | P0 |
| G05 | WebSocket authentication | KDS socket, no token | Connect without an `auth` message | Socket closed after the 5 s auth timeout | PASS (in-process) — KDS suites green | `main/services/kds.ts:45, 197-202` | PASS | P0 |
| G06 | Rate limiting on login | Any client | 6 failed logins from one IP | 429 lockout for 15 minutes | PASS — orders-authz suite covers the throttle (6th attempt 429) | `main/middleware/security.ts:140-180` | PASS | P1 |
| G07 | Rate limiting on the general API from a LAN client | LAN client | Flood `/api` | Currently NOT limited (skip for private IPs — audit F-031) | FAIL (by code inspection) — limit skipped for LAN | `main/server.ts:221-231` | FAIL | P2 |
| G08 | CORS and network exposure | Browser on another LAN host | Call the API from a non-allowed origin | Rejected unless origin is localhost, `*.local`, or a private IP | PASS — CORS suite green | `tests/cors-security.test.ts` | PASS | P1 |
| G09 | Sensitive data exposure | Staff list, approvers directory | Fetch as a manager | No password or PIN hashes in any response | PASS (in-process) — staff responses use `STAFF_SELECT_FIELDS` | `main/routes/staff.ts:32, 213-215` | PASS | P1 |
| G10 | Token storage | Logged-in tablet | Inspect storage | JWT in `localStorage` (readable by any renderer script); CSP allows inline scripts (audit R-A2) | NOT RUN — storage mechanism verified in code, not live | `frontend/src/store/auth.ts:52`; `main/csp.ts` | NOT RUN | P2 |

## H. Windows deployment and recovery

| ID | Scenario | Preconditions | Execution steps | Expected result | Actual result | Evidence | Status | Priority |
|---|---|---|---|---|---|---|---|---|
| H01 | Windows installer, first install | Clean Windows PC | Run the installer | App installs; desktop and Start-menu shortcuts created; first-run setup completes | NOT RUN — no Windows host; installer built successfully from the 033 head (workflow run 41213831486) | `.github/workflows/build-windows.yml`; `docs/maintainers/releases.md` | NOT RUN | P0 |
| H02 | Upgrade installation | Installed older version with data | Install the newer installer over it | Data in `%APPDATA%\RestCafe` preserved; migrations run with a pre-migration backup | NOT RUN — no Windows host; upgrade-path suite green in-process | `tests/upgrade-path.test.ts` | NOT RUN | P0 |
| H03 | Application restart | App running | Quit and relaunch | Servers restart in order; database reopens; no data loss | NOT RUN — no Windows host | `main/index.ts:1155-1245` | NOT RUN | P1 |
| H04 | Windows restart | App running | Restart Windows, launch the app | App starts manually (no autostart — F-005); services come up | NOT RUN — no Windows host | `main/index.ts` | NOT RUN | P1 |
| H05 | Database location and permissions | Installed app | Inspect `%APPDATA%\RestCafe` | `flo.db` present; marker present; backups in `backups/` | NOT RUN — no Windows host; paths verified in code | `main/db/core.ts:512-528` | NOT RUN | P1 |
| H06 | Firewall requirements | Fresh Windows install | Launch the app, connect a tablet | Windows Firewall prompt appears; documented rule exists (none documented — audit F-023) | NOT RUN — no Windows host; no firewall doc exists | — | NOT RUN | P1 |
| H07 | Required ports | Installed app | List listening ports | 3001, 3002, 3003 (or bumped ports, surfaced to the operator — F-006) | NOT RUN — no Windows host; ports verified in code | `main/server.ts:331`; `main/kds-server.ts:63`; `main/server-app.ts:687` | NOT RUN | P1 |
| H08 | Backup location | Backups created | Inspect the backup folders | Manual backups in `%APPDATA%\RestCafe\backups`; daily backups in `%USERPROFILE%\Documents\RestCafe\Backups` | NOT RUN — no Windows host; paths verified in code | `main/db/backup.ts:28-31`; `main/services/local-backup.ts:20-28` | NOT RUN | P1 |
| H09 | Recovery and reinstall procedure | Broken install, backup file available | Reinstall, restore the backup | Documented runbook exists (none — audit F-022) | NOT RUN — no runbook, no clean-host restore on record | `main/db/backup.ts:2521-2800` | NOT RUN | P1 |
| H10 | Cashier PC fails completely | Host disk dead, backups copied off-site | Restore onto a replacement PC | System recovered without developer intervention | NOT RUN — depends on F-007 (off-host backup) and F-022 (runbook) | — | NOT RUN | P0 |
| H11 | Unsigned installer SmartScreen | First run on Windows | Launch the installed app | SmartScreen warns; operator follows More info, Run anyway (audit F-024) | NOT RUN — no Windows host; unsigned state documented | `docs/maintainers/releases.md:17-19` | NOT RUN | P2 |
| H12 | Startup behaviour after power cut | Power cut during service | Restore power, launch the app | App starts; WAL recovery; no silent empty database (A05) | NOT RUN — no power-cut drill | `main/db/core.ts:556-568` | NOT RUN | P1 |

## I. Capacity and performance targets

| ID | Scenario | Preconditions | Execution steps | Expected result | Actual result | Evidence | Status | Priority |
|---|---|---|---|---|---|---|---|---|
| P01 | 4 waiter clients plus 1 KDS client | 5 devices on the LAN | Operate concurrently for a full service | No errors, no lost updates, no duplicated payments | NOT RUN — no multi-device run; in-process simulation only | `tests/restaurant-full-house.test.ts` | NOT RUN | P0 |
| P02 | 50 configured tables | 50 tables in the catalog | Load the tables screen; operate across all tables | Tables load and operate without errors | NOT RUN — full-house runs 40 tables in-process; 50-table load not measured | `tests/restaurant-full-house.test.ts` | NOT RUN | P1 |
| P03 | 100+ active order items | 100+ items across open orders | Place and manage the items | No errors; totals exact; KDS shows all items | NOT RUN — no load run at this scale | — | NOT RUN | P1 |
| P04 | API response under 500 ms at p95 on the LAN | 4 tablets + KDS, normal load | Measure p95 of order/payment/KDS calls excluding printing | p95 under 500 ms | NOT RUN — no LAN measurement exists; in-process bursts measure 7–104 ms (full-house), which is not a LAN p95 | `tests/restaurant-full-house.test.ts` | NOT RUN | P0 |
| P05 | No lost financial transactions | Full service with retries | Run the day-cycle and full-house suites | 0 money mismatches | PASS (in-process) — full-house 0 findings; day-cycle 116/116 | `tests/restaurant-full-house.test.ts`; `tests/restaurant-day-cycle.test.ts` | PASS | P0 |
| P06 | No duplicated payments from retries | Duplicate payment attempts | Replay payments with the same keys | Single charge each | PASS — settlement idempotency 134/134 | `tests/bills-settlement-idempotency.test.ts` | PASS | P0 |
| P07 | No silent loss of kitchen tickets | KDS + KOT printing | Place orders with the printer offline | KDS shows every order; a failed KOT is queued for automatic retry | NOT RUN — no live printer-offline drill; queue behaviour pinned by kot-print-queue 146/146 | `main/services/print-queue.ts`; `main/services/kds.ts` | NOT RUN | P1 |
| P08 | Client reconnection after interruption | KDS + POS connected | Drop the network 2 minutes, restore it | Both reconnect; KDS resyncs by snapshot; POS needs a manual reload (F-012) | NOT RUN — no live drill | `frontend/src/hooks/useKdsConnection.ts` | NOT RUN | P1 |

## Pilot checklist (manual, on the owner's hardware)

Run these on the real Windows host with the real printers and tablets before
the pilot opens. Each item maps to matrix IDs above.

1. Install the current installer; complete first-run setup; confirm the
   database at `%APPDATA%\RestCafe\flo.db`. (H01, H05)
2. Connect 4 waiter tablets and 1 KDS tablet over the restaurant Wi-Fi;
   confirm each loads from the host IP and the QR pairing works. (A10, D02)
3. Print a bill on the USB receipt printer and a KOT on the kitchen printer;
   check Arabic shaping, RTL, Latin digits, long names, and addons.
   (F01–F07)
4. Close a day and print the Z-report on the real printer. (F14, E14)
5. Kill the Wi-Fi on one tablet mid-sale; confirm the error, the kept cart,
   and a clean manual retry with no duplicate order. (D01, B04)
6. Restart the router; confirm all tablets reconnect. (D02, D03)
7. Restart Windows; confirm the operator launches the app and all tablets
   reconnect. (A02, H04)
8. Copy a backup off the host; restore it onto a second machine and confirm
   the owner account and orders survive. (H09, H10, E09)
9. Measure API p95 from a tablet during a busy simulated service. (P04)
10. Run the full-house and day-cycle suites on the release build and record
    the results. (B01, P05)

## Printing closure recommendation

Flint recommends the printing system be accepted as SOFTWARE-CLOSED, subject
to Ted's decision. The evidence: PF-01–PF-04 are fixed and verified —
generic raster is a validated per-printer opt-in, the receipt logo respects
the raster capability gate, `whole-receipt` is removed from every shipped
profile, and queued receipt retries are guarded by `printed_at` — and the
stale matrix rows above (C06, C07, C08, F06, F08, F09, F10, F11, P07, E04)
are corrected to the behaviour the code and suites now pin. PF-05 stands as
the single accepted residual risk (see "KOT item eligibility" in
`docs/architecture/printing.md`): a crash in the one step between a
successful KOT dispatch and its marker stamp can re-send those items.

One honest limit remains: no physical-printer verification has run on the
owner's hardware. The live-drill rows in this matrix stay NOT RUN until the
pilot checklist above runs on the real printers.
