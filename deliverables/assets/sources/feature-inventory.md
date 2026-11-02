# Rest&Cafe — Ground-Truth Feature Inventory

**Purpose:** factual source for the Arabic user manual and marketing brochure. Every claim below is
grounded in the application sources at `~/workspace/rest-cafe` (upstream head `6f873f1`, 2026-11-02),
inspected read-only on 2026-11-03.

**Method:** frontend route tree (`frontend/src/app/**`), backend route mounts
(`main/routes/index.ts`, `main/server-app.ts`, `main/kds-server.ts`), settings components
(`frontend/src/components/settings/*`), the permission catalog docs
(`docs/reference/roles-and-permissions.md`, `shared/permissions.ts`), product invariants
(`docs/reference/product-invariants.md`), architecture docs (`docs/architecture/*`), Arabic strings
from `frontend/src/lib/i18n/messages/ar.json`, and the automated test-suite inventory
(`tests/*.test.ts` — 317 files; 282 `test:*` scripts in `package.json`).

**Classification legend**

- **Implemented and verified** — present in code/UI and pinned by a named automated suite (suites are
  wired into `package.json` and the CI protecting set; they were not re-executed during this
  investigation — see §F).
- **Implemented but not fully verified** — present in code with test coverage, but final proof needs
  real hardware / a real Windows device (the project's device phase is still pending with the owner).
- **Partially implemented** — works with a documented limitation.
- **Not implemented** — absent, hidden, or removed; must never be documented or advertised (§E).

**Platform facts (verified):** Windows desktop app (Electron), productName `Rest&Cafe`, appId
`com.alicoding.restcafe` (`package.json`). Local-only: one Electron process hosts SQLite
(better-sqlite3) and three HTTP servers — API + POS UI on **3001** (`main/server.ts`), Kitchen
Display on **3002** (`main/kds-server.ts`), Server App on **3003** (`main/server-app.ts`)
(`docs/architecture/overview.md`). Five fixed staff identities: **owner (المالك), manager (المدير),
cashier (الكاشير), server (النادل/السيرفر), chef (الطاهي)** — permissions configurable per role/user
by the owner (`docs/reference/roles-and-permissions.md`). Orders are never ownership-gated: any
staff member with order access sees and acts on all orders (`docs/reference/product-invariants.md`).

---

## A) Feature inventory

### A1. Access, setup, account recovery

| Feature (AR / EN) | What it does | Where accessed | Who | How it works | Prerequisites | Verification evidence | Classification |
|---|---|---|---|---|---|---|---|
| الإعداد الأول / First-run setup | Creates the store and the owner account on first launch | `/setup` (`frontend/src/app/setup/page.tsx`) | Owner (first run) | Multi-step wizard: language, store name, currency + timezone, owner account, Staff Approval PIN, Master PIN, optional demo data. Seeds defaults SYP / unit `SP` / `Asia/Damascus`; no country field and `POST /api/auth/setup` ignores any country | Fresh database | `tests/first-run-setup`, `test:phase7-setup-i18n`, `test:setup-failure-recovery`; invariants doc | Implemented and verified |
| تسجيل الدخول / Login | Staff sign-in with email + password; lockout after repeated failures | `/auth/login` | All roles | JWT session; login rate limits; landing page by role: owner+manager → `/dashboard`, cashier+waiter → `/tables` | Setup completed | `tests/auth-ui-deterministic`, `test:login-email-normalization`, `test:cross-server-login-rate-limits` | Implemented and verified |
| إنشاء حساب / Register | Creates an additional account from the auth area | `/auth/register` | Owner/manager context | Standard account creation form | Existing install | `frontend/src/app/auth/register/page.tsx` | Implemented but not fully verified (no dedicated suite found by name) |
| استعادة كلمة المرور / Password recovery | Recovers owner access without cloud services | `/auth/recover` | Owner | Two local methods: **Master PIN** (set during setup) or a local email-code path where available; recovery strings in `ar.json` (`auth.recoverMethodPin`, `auth.recoverNoOwner`) | Master PIN set at setup | `tests/issue-127-password-recovery`, `test:master-pin` | Implemented and verified |
| قفل الجلسة وتسجيل الخروج / Logout & session | Ends the session; tokens revocable | Sidebar (`nav.logout` «تسجيل الخروج») | All roles | JWT revocation on logout; revoked-token repair migration exists | — | `tests/jwt-logout-lifecycle`, `test:token-revocation-fail-closed`, `test:migration-v71-repair` | Implemented and verified |

### A2. Dashboard (لوحة التحكم)

| Feature (AR / EN) | What it does | Where accessed | Who | How it works | Prerequisites | Verification evidence | Classification |
|---|---|---|---|---|---|---|---|
| لوحة التحكم / Owner dashboard | Daily/monthly operating snapshot: today's sales, orders, running & pending orders, occupied tables, gross/net collections, average order value, average prep time, average table turn | `/dashboard` | Owner by default (permission `dashboard.view`-equivalent: matrix row "View the owner dashboard" = owner only) | Aggregates orders/payments for the selected day or month; date/month pickers | Orders exist | `tests/dashboard-business-date`, `test:reports-daily-stats-table-turn`; strings `ar.json: dashboard.*` | Implemented and verified |
| أفضل الأصناف والفئات / Top products & categories | Best sellers today and this month, top categories | `/dashboard` | Owner | Ranked from order items | Sales data | `tests/customer-top-items` (related), dashboard page source | Implemented and verified |
| أنماط الأعمال / Business patterns | Busiest/idlest hour and day over the last N days, top staff by order count, new customers | `/dashboard` | Owner | Computed from order history | History data | Dashboard page source; `ar.json: dashboard.businessPatterns` | Implemented but not fully verified (no suite named for patterns specifically) |
| نشاط الاسترداد / Refund activity | Refunds in the month of collection: count, amounts, approver, bill/order reference | `/dashboard` | Owner | Lists refund rows tied to payment month | Refunds exist | `tests/refunds`, `test:refund-completed-orders` | Implemented and verified |
| فتح/إغلاق الوردية من اللوحة / Shift open & close (dashboard shortcuts) | Open a cash shift (count drawer cash) and close the day/shift from the dashboard | `/dashboard` (`dashboard.openShift`, `dashboard.closeShift`) | Owner (cashier closes own shift from POS/cash flows) | Creates/closes `cash_sessions`; closure produces Z-style daily closure records | `payments` permissions | `tests/cash-sessions`, `test:cash-closures` (370 checks) | Implemented and verified |

### A3. Tables (الطاولات)

| Feature (AR / EN) | What it does | Where accessed | Who | How it works | Prerequisites | Verification evidence | Classification |
|---|---|---|---|---|---|---|---|
| خريطة الطاولات / Table map | Live floor map of all tables with status colors; the cashier's home screen | `/tables` | Cashier, waiter (landing page), owner, manager | Statuses: `available` متوفرة, `reserved` محجوزة, `occupied` مشغولة, `held` (cart held), `bill_requested` طُلب الحساب. Opened-at clock shown; no countdown timers | Tables configured | `tests/tables-string-ids`, `test:cashier-workspace-backend`; tables page source | Implemented and verified |
| إدارة الطاولات والصالات / Table & hall management | Add/edit/deactivate tables, capacity (seats), sections, halls («الصالات» — never «طوابق» in UI) | `/tables` (manage mode) | Owner, manager (`tables.manage`) | CRUD via `/api/tables`; hall rename/merge/remove operations apply across tables | — | `tests/issue-646-floor-management`, `test:tables-bulk-create` | Implemented and verified |
| إضافة جماعية / Bulk table creation | Creates a numbered range of tables at once (max 200 per batch), skips existing names and reports them | `/tables` → «إضافة جماعية» | Owner, manager | Prefix + from/to range with live preview | — | `tests/tables-bulk-create`; `ar.json: tables.bulk*` | Implemented and verified |
| حجز طاولة / Table reservation | Reserves a table for a customer with arrival time; today's reservations list | `/tables` → «حجز» | Cashier, owner, manager | Sets status `reserved` with `reservation_customer_id` + `reservation_at` (`main/routes/tables.ts`) | Customer optional | Tables routes source; `ar.json: tables.reserve*`, `tables.todaysReservations` | Implemented and verified |
| دورة حياة الطاولة / Table lifecycle | متوفرة/محجوزة ← مشغولة ← طُلب الحساب ← دفع ومغادرة ← متوفرة | `/tables`, POS | Cashier, waiter | Opening an order marks the table `occupied`; requesting the bill sets `bill_requested`; settling the last unpaid bill completes the order and releases the table | — | `docs/architecture/order-lifecycle.md`; `tests/restaurant-day-cycle` (116 checks) | Implemented and verified |
| نقل طلب بين الطاولات / Move order to another table | Moves an open order to a different table | `/tables`, POS | Owner, manager, cashier, waiter (`tables.orders.move`) | `POST /api/tables/:id/move-order`; refused (409) if target is reserved | Target table free | `tests/table-move-ui` | Implemented and verified |
| دمج الطلبات/الطاولات / Merge tables (merge orders) | Merges one table's open order into another table's order | `/tables` (merge flow, also via `?mergeFrom=<orderId>` from the POS workspace) | Cashier, owner, manager | Pick source then target («دمج مع…», «اختر الطاولة التي سيُدمج إليها هذا الطلب» in `ar.json`) | Both tables have orders | Tables page source (`mergeSource/mergeTarget` state) | Implemented and verified |

### A4. POS and orders (نقطة البيع والطلبات)

| Feature (AR / EN) | What it does | Where accessed | Who | How it works | Prerequisites | Verification evidence | Classification |
|---|---|---|---|---|---|---|---|
| نقطة البيع / POS terminal | The selling screen: catalog, cart, checkout | `/pos` | Owner, manager, cashier, waiter (`pos.use`) | Two-face cashier flow with `/tables`: pick a table on the map → workspace → order. All money math is resolved server-side (`POST /api/orders`); client-sent prices are never trusted | Products exist | `tests/pos-wifi-drop`, `test:pos-catalog-sort`, `test:cart-variant-identity`, `test:pos-keyboard-shortcuts` | Implemented and verified |
| أنواع الطلبات / Order types | Dine-in (على الطاولة), takeaway (سفري), delivery (توصيل) | `/pos`, `/orders` | Order creators | `type` ∈ `dine_in`, `takeaway`, `delivery`, `online`; the **Online type is hidden in the UI** (see §E). Delivery orders carry delivery fields and can print a courier slip | — | `docs/architecture/order-lifecycle.md`; `tests/delivery-slip-printing` | Implemented and verified (dine-in/takeaway/delivery) |
| سلة محفوظة / Held orders (تعليق الطلب) | Parks a cart on a table without creating an order; resume later | `/pos` | Owner, manager, cashier, waiter | `POST /api/held-orders` snapshots the cart and marks the table `held`; nothing is priced, no stock moves, no kitchen ticket. Resume deletes the hold and restores the cart | — | `tests/held-orders-store`, `test:held-orders`; lifecycle doc | Implemented and verified |
| حفظ السلة عند انقطاع الاتصال / Cart draft persistence + offline indicator | A Wi-Fi drop mid-sale does not lose the cart; a persistent offline banner shows connection loss; unsent (stale) postpaid attempts are surfaced instead of silently failing | `/pos` | Cashier, waiter | Cart draft persisted locally; catalog reload retries with backoff; shared HTTP client has timeouts | — | `tests/pos-wifi-drop` (audit fix D2, F-003/F-011/F-012/F-014/F-028) | Implemented and verified |
| إنشاء طلب وإضافة أصناف / Create order & append items | Creates orders (1–200 items) and appends items to an open order | `/pos`, `/orders`, Server App | Order creators | One server transaction: catalog pricing, stock + recipe depletion, per-line tax snapshot, charges resolution, order number allocation, idempotency keys protect retries | Shift rules may apply | `tests/integration-happy-path`, `test:issue-255-append-idempotency`, `test:order-totals-recompute` | Implemented and verified |
| تعديل أصناف الطلب / Edit order items | Change quantity, replace pending items, edit notes | `/orders` (EditOrderItemModal) | Owner only for item edit/replace per matrix (`orders.item.edit` = owner); quantity rules enforced | Pending lines are editable; started (preparing+) lines cannot be replaced — reductions count as waste (no stock restore) | — | `tests/order-item-edit` | Implemented and verified |
| إلغاء/إبطال صنف واستعادته / Cancel, void, restore item | Cancels a pending item (restores stock), voids a started item (waste, no restore), restores a cancelled item | `/orders` | Cancel pending: owner/manager; void: owner/manager (manager PIN may be required); restore: owner/manager | Pending cancel restores inventory + recipe snapshot exactly; void after preparation restores nothing | PIN rules for advanced states | `tests/order-item-cancel-restore`, `test:cancel-override`, `test:async-pin-event-loop` | Implemented and verified |
| تجاوز سعر صنف / Item price override | Sells one line at a manual price (incl. 0 = complimentary) with a mandatory reason | `/orders` (PriceOverrideDialog) | **Owner only** (`orders.item.price_override`, non-configurable) | `PATCH /api/orders/:id/items/:itemId/price`; 403 for other roles; audit-logged | — | `tests/item-price-override`, `test:cart-price-override` | Implemented and verified |
| خصومات / Discounts | Percentage or flat discount on an order, one item, or a bill | `/pos`, `/orders`, bill payment | Owner, manager (bill discount also owner/manager; cashier has none by default) | Settings-driven: `discount_mode` (percentage/flat/none/both), max % (default 25%), max amount, optional manager-PIN approval; never below collected payments (409); audit-logged | Settings → discounts | `tests/discount-system`, `test:integration-discount`, `test:integration-discount-settings`, `test:discount-kitchen-approver-identity` | Implemented and verified |
| إلغاء طلب كامل / Cancel whole order | Cancels an order; cancelling also closes its never-paid unpaid bill | `/orders` | Owner/manager PIN when items advanced or money collected | Free cancel only while order + items are `pending` and no bill holds collected funds; otherwise active owner/manager `override_pin` required | — | `tests/cancel-closes-bill`, `test:issue-24` (cancel item checkout) | Implemented and verified |
| إتمام طلب / Complete order | Closes an order once settled | `/orders`, POS | Owner, manager, cashier (payments) | Blocked while unsettled payable bills, unbilled positive total, or undelivered kitchen items (when `require_kitchen_delivered_before_settlement` is on) — override needs owner/manager PIN | Bills settled | Lifecycle + roles docs | Implemented and verified |
| بحث الطلبات وسجل التدقيق / Orders search & audit log | Searches orders and shows who did what on an order | `/orders` | Owner, manager, cashier, waiter | Server-side search API; every write attributed in `order_audit_log` | — | `tests/orders-search`, `test:orders-search-api`, `test:order-audit-log` | Implemented and verified |
| ملاحظات الطلب والأصناف / Order & item notes | Kitchen-visible notes on orders and lines | `/pos`, `/orders`, KDS | Order creators | Notes validated server-side; KOT notes print and show on KDS | — | `tests/order-notes-validation`, `test:kot-order-notes` | Implemented and verified |

### A5. Kitchen (المطبخ)

| Feature (AR / EN) | What it does | Where accessed | Who | How it works | Prerequisites | Verification evidence | Classification |
|---|---|---|---|---|---|---|---|
| شاشة عرض المطبخ / Kitchen Display System (KDS) | Live ticket board: new orders appear instantly, grouped and prioritised | `/kds` (in-app) and `/kds-standalone` on :3002 | Chef, manager, owner (`kitchen.use`) | WebSocket push at path `/kds` on both :3001 and :3002 (`main/services/kds.ts`); views: kanban or tabs (setting `kdsDefaultView`) | KDS enabled in Settings | `tests/kds-integration`, `test:kds-live-push`, `test:kds-contract`, `test:kds-broadcast-grouping` | Implemented and verified |
| حالات أصناف المطبخ / Item status progression | pending ← preparing ← ready ← served, fully flexible forward/backward moves for authorised staff (locked product decision F-013: flexibility is intended) | KDS, `/orders` | Chef/manager/owner (`kitchen.status.update`), narrowed by chef's station + categories | Status changes re-validate station/category scope inside the transaction | Station assignment for chefs | `tests/kds-integration`, `test:issue-133-kds-kot-toggles`; decision 038 | Implemented and verified |
| محطات المطبخ / Kitchen stations | Stations (e.g. grill, drinks) with assigned categories, a printer, and assigned chefs | Settings → Kitchen stations (`/api/kitchen-stations`) | Owner, manager | Tickets route/print per station; a station chef sees only their scope | Categories exist | `tests/issue-134-station-management`, `test:issue-134-station-routing` | Implemented and verified |
| تذاكر المطبخ المطبوعة / Kitchen order tickets (KOT) | Printed kitchen tickets per station with wrapped (never truncated) item names, add-ons and notes | Printers (auto or manual) | Cashier/owner/manager (`printing.execute`) | Each KOT line carries a printed marker so a ticket is never duplicated; a durable pending-print queue retries failed prints — tickets are never lost | Printer configured | `tests/kot-print-queue` (119 checks), `test:kot-line-wrap`, audit fix D3 (F-004/F-009) | Implemented and verified |
| تنبيه إعادة الاتصال / KDS reconnect catch-up chime | One catch-up sound when a kitchen screen reconnects, so missed tickets are noticed | KDS screens | Kitchen staff | Single chime per reconnect (not per ticket) | KDS enabled | `tests/kds-reconnect-chime` (D3, F-029) | Implemented and verified |
| إقران شاشة مطبخ / KDS pairing | Pairs a second screen/tablet to the kitchen display via QR/info endpoint | Settings → KDS (`/api/kds-info`), KDS server login | Owner, manager (`kitchen.pair`) | KDS server (:3002) has its own login; pairing info shown in Settings | LAN device | `main/routes/kds-info.ts` (info endpoint), Settings KDS pairing strings (`settings.kdsPairing`, `settings.kdsQrAlt`); no dedicated pairing suite found by name | Implemented but not fully verified (real second-screen pairing is part of the pending device phase) |

### A6. Bills, payments, cash (الفواتير والمدفوعات والصندوق)

| Feature (AR / EN) | What it does | Where accessed | Who | How it works | Prerequisites | Verification evidence | Classification |
|---|---|---|---|---|---|---|---|
| توليد الفاتورة / Bill generation | Turns an order into a payable bill | `/pos`, `/orders` | Owner, manager, cashier | `POST /api/bills/generate`; bill starts `unpaid`; totals recomputed server-side | Order open | `tests/bills-settlement-idempotency` (134 checks), `test:integration-bill-reconciliation` | Implemented and verified |
| الدفع / Payments | Takes payment by configured methods (cash, card, …); card payments can require a transaction id (setting) | Payment modal in `/pos` | Owner, manager, cashier (`payments.take`); **waiters cannot take payments** | Partial payments allowed; bill moves unpaid → partial → paid; duplicate no-amount payment on a money-paid bill is refused (400 `bill_already_paid`) | Open shift may be required by settings | `tests/integration-payments`, `test:issue-689-cashier-payments`, `test:card-transaction-id` | Implemented and verified |
| تقسيم الفاتورة / Split checks | Splits a check so a leaving guest's items are billed separately | Payment modal (`splitChecks` setting) | Owner, manager, cashier | Bills share a `split_group_id`; each split settles independently | Setting enabled | `tests/payment-methods-split-checks` (split checks coverage), bills routes source | Implemented and verified |
| طرق الدفع / Payment methods management | Defines payment methods; methods can be merged (history moves with them, irreversible) | Settings → Payment methods | Owner (manage), manager (view/manage per matrix) | CRUD + merge via `/api/payment-methods` | — | `tests/payment-methods-split-checks`; `ar.json: settings.paymentMethods` | Implemented and verified |
| ورديات الصندوق / Cash sessions (shifts) | Open/close cash shifts with opening count; a cashier closes only their own shift; owner/manager can close any | `/pos`, `/dashboard`, reports | Owner, manager, cashier | `POST /api/cash-sessions/:id/close`; closer recorded on the closure row | — | `tests/cash-sessions` | Implemented and verified |
| إغلاق اليوم / Daily cash closure (Z report) | End-of-day closure reconciling sessions, payments and refunds; printable Z report (receipt-language settings apply) | Reports → Cash tab; dashboard close | Owner, manager | `main/routes/cash-closures.ts`; closure print test exists after D1 fix (F-008 test-side) | Sessions closed | `tests/cash-closures` (370 checks) | Implemented and verified |
| نبضة درج النقد / Cash drawer pulse | Sends an open-drawer pulse on chosen payment methods | Settings → Printers (cash drawer pulse options) | Owner, manager | ESC/POS pulse via printer; migration v80 covers the setting | Compatible printer/drawer | `tests/migration-v80-cash-drawer-pulse` | Implemented but not fully verified (physical drawer needs the device phase) |
| الاسترداد / Refunds | Refunds a paid bill: full, partial, or single-item; in a different method than the original, or as store credit | `/orders` (RefundModal) | Initiate: owner/manager; approval by Staff Approval PIN with time tiers | Ceiling = paid − prior refunds. Tiers: within 1h of order creation → owner or manager PIN; later the same business day → owner PIN only; after business day ends → refused (409). Item refunds include the item's consumption-fee share (locked correct behaviour F-R2-2). Refunds never restock inventory | Staff Approval PIN set at setup; store credit needs a customer on the bill (loyalty ledger mechanism — see §E note) | `tests/refunds`, `test:refund-completed-orders`, `test:async-refund-pin-event-loop`; invariants doc | Implemented and verified |
| منع الدفع المكرر / Payment idempotency | Network retries can never double-charge or double-create | All payment/order flows | — (system) | Idempotency keys on orders/payments/refunds; records pruned after 90 days (`pruneIdempotencyRecords`, D6/F-033) | — | `tests/idempotency-retention` (20 checks), `test:bills-settlement-idempotency`, `test:issue-255-*` | Implemented and verified |

### A7. Catalog (الأصناف والتصنيفات والإضافات)

| Feature (AR / EN) | What it does | Where accessed | Who | How it works | Prerequisites | Verification evidence | Classification |
|---|---|---|---|---|---|---|---|
| التصنيفات / Categories | Menu categories that organise products (and drive KDS station routing + tax category defaults) | `/products` | Owner, manager (`menu.manage`) | CRUD via `/api/categories`; categories carry add-on group links | — | `tests/category-addon-groups`, `test:issue-247-catalog-invariants` | Implemented and verified |
| الأصناف / Products | Menu items with price, cost, image, barcode, sold-out state | `/products` → «إضافة صنف» | Owner, manager | CRUD via `/api/products`; sold-out items are refused at order time (400 `product_sold_out`) and flagged in POS. **Seven legacy form fields are hidden in the current form** (see §E) | — | `tests/sold-out-backend` (27 checks), `test:product-images`, `test:issue-137-barcode` | Implemented and verified |
| الأحجام والمتغيرات / Product variants | Size/variant options per product with own price, recipe portion multiplier, and linked-stock deduction quantity | `/products` (variant editor), POS | Owner, manager | Variant resolved server-side at order time (price + portion); cart identity includes the variant | — | `tests/product-variants-orders`, `test:product-variants-api`, `test:variant-pos-surface`, `test:cart-variant-identity` | Implemented and verified |
| مجموعات الإضافات / Add-on groups & add-ons | Option groups (e.g. extras, sauces) with min/max selection rules, linked to categories/products | `/addon-groups` («مجموعات الإضافات»), product editor | Owner, manager | CRUD via `/api/addon-groups`; quantities and price integrity enforced server-side; add-on prices re-read from DB for customer orders | — | `tests/addon-price-integrity`, `test:issue-122-addon-quantities`, `test:issue-244-product-addon-links`, `test:issue-245-246-addon-groups` | Implemented and verified |
| استيراد/تصدير القائمة CSV / Menu CSV import & export | Moves categories/products/add-ons in and out as CSV | `/products` (menu CSV tools) | Owner, manager (`menu.import_export`) | `/api/menu-csv`; exports carry a `flo_csv_encoding=quote-v1` marker so re-import is lossless (formula-leading names and leading apostrophes survive round-trips); unmarked legacy files handled by proof-based decoding | — | `tests/issue-248-csv`, `test:menu-csv-formula-export`, `test:csv-encoding`, `test:product-tax-category-and-menu-csv` | Implemented and verified |
| طباعة القائمة / Menu printing | Prints the menu document with «Powered by Ali.J» footer | Printers / print flows | Owner, manager, cashier | `main/printers/document-menu.ts` builds the menu print document | Printer configured | `tests/menu-printing` | Implemented and verified |

### A8. Customers (العملاء)

| Feature (AR / EN) | What it does | Where accessed | Who | How it works | Prerequisites | Verification evidence | Classification |
|---|---|---|---|---|---|---|---|
| إدارة العملاء / Customer records | Customer list with phone + address, search by phone, pagination | `/customers` («العملاء») | View/search/create: owner, manager, cashier, waiter; edit: owner/manager/cashier; cleanup: owner only | CRUD via `/api/customers`; soft-deleted customers can be reactivated and re-bound; phone search normalised | — | `tests/customer-pagination`, `test:customer-phone-search`, `test:phone-search-integration`, `test:customer-soft-reactivate-bindings`, `test:customer-auth` | Implemented and verified |
| أصناف العميل المفضلة / Customer top items | Shows a customer's most-ordered items | `/customers` | Owner, manager, cashier | Aggregated from order history | Order history | `tests/customer-top-items`, `test:customer-top-items-ui` | Implemented and verified |
| ربط عميل بطلب/طاولة / Attach customer | Links a customer to an order or a table reservation; walk-in («عميل مباشر») otherwise | `/pos`, `/tables`, `/orders` | Order creators | Customer id stored on order/table; enables delivery details and store-credit refunds | — | Orders/tables sources | Implemented and verified |

### A9. Staff & permissions (الموظفون والصلاحيات)

| Feature (AR / EN) | What it does | Where accessed | Who | How it works | Prerequisites | Verification evidence | Classification |
|---|---|---|---|---|---|---|---|
| حسابات الموظفين / Staff accounts | Creates/edits/deactivates staff with one of the five roles | `/staff` («الموظفون») | Owner; manager can manage cashier/server/chef only | Managers cannot touch owner/manager accounts (protected `staff.privileged.manage`); the last full administrator cannot be demoted/deactivated | — | `tests/staff-authz`, `test:staff-approvers-directory` | Implemented and verified |
| محرر الصلاحيات / Permission editor | Owner edits role defaults and per-user allow/deny exceptions (Inherit/Allow/Deny) for ~60 capabilities | `/staff` → Role permissions (PermissionMatrix component) | **Owner only** (`authorization.manage`, protected) | Effective = protected owner rule → user override → role override → shipped default, resolved live from DB on every request (no re-login needed); stale saves return 409 with current state | — | `tests/authorization-permissions`, `test:authorization-api`, `test:authorization-static-audit`, `test:permission-matrix-self-access`; `docs/reference/roles-and-permissions.md` | Implemented and verified |
| سجل تغييرات الصلاحيات / Permission change history | Audit list of every permission change (actor, target, before/after) | `/staff` → Permission change history | Owner | Rows from `authorization_audit_log` (migration v93), rendered by the `PermissionAuditLog` component; `GET /api/authorization/audit` | — | `tests/authorization-api`, `test:authorization-permissions` (audit endpoint in the same owner-only API) | Implemented and verified |
| رمز اعتماد الموظفين / Staff Approval PIN | 4–6 digit PIN, separate from the device Master PIN, used to approve refunds and overrides | Set at setup; managed per user | Owner (own PIN); approvers = owner/manager | bcrypt-hashed on the user record; the Master PIN never authorises a refund | Setup | `tests/manager-pin-verification`, `test:manager-pin-rate-limit-bypass`; invariants doc | Implemented and verified |
| تجاوزات برمز المدير / Manager-PIN overrides | Sensitive actions (void started items, cancel advanced orders, complete unsettled orders, large discounts) require an active owner/manager PIN | POS/orders prompts | Owner, manager as approvers | PIN checked against the selected approver only; rate-limited; actor + approver recorded in audit log, PIN never stored | Approver PIN set | `tests/discount-kitchen-approver-identity`, `test:async-pin-event-loop` | Implemented and verified |

### A10. Inventory, supplies, recipes (المخزون والمواد والوصفات)

| Feature (AR / EN) | What it does | Where accessed | Who | How it works | Prerequisites | Verification evidence | Classification |
|---|---|---|---|---|---|---|---|
| مخزون الأصناف / Product stock ledger | Tracks product stock with a signed movement ledger; selling deducts, pending-cancel restores | `/inventory` («المخزون») | Owner, manager (`menu.supplies` / inventory permissions) | Movements written in the same transaction as the order; variant sales can deduct from a linked product pool (`inventory_product_id`) | Stock tracking on products | `tests/inventory-ledger`, `test:addon-inventory-lifecycle`, `test:addon-inventory-db`, `test:issue-252-order-lifecycle-inventory` | Implemented and verified |
| المواد / Supplies | Ingredients & packaging stock with its own ledger (`supplies`, `supply_movements`), units incl. weight/volume | `/inventory` → Supplies tab | Owner, manager | **Negative stock is allowed and never blocks selling**; negative balances are flagged for physical count. Purchase costs use weighted average cost per base unit | — | `tests/supplies-service`, `test:units`, `test:volume-units-inventory-links`; invariants doc | Implemented and verified |
| الوصفات / Recipes | Per-product recipes that deplete supplies when a line is sold | `/inventory` → Recipes tab | Owner, manager | Depletion happens when a pending line is inserted, scaled by variant portion (`recipe_multiplier`); a frozen `recipe_snapshot` + ingredient cost is stored on the order line, so later recipe edits never rewrite history; only pending cancels restore | Supplies defined | `tests/recipe-order-lifecycle`, `test:ingredient-cost` (`ingredient-cost-lifecycle`) | Implemented and verified |
| تكلفة المكونات والربحية / Ingredient cost & margin | Frozen per-line ingredient cost feeds dish profitability; lines with any unpriced component report "cost unknown" — never a fake 100% margin | Reports → Profitability | Owner (financial view) | `ingredient_cost` frozen at sale time; profit computed only over known-cost lines | Recipes + priced supplies | `tests/ingredient-cost-lifecycle`; invariants doc | Implemented and verified |

### A11. Expenses (المصروفات)

| Feature (AR / EN) | What it does | Where accessed | Who | How it works | Prerequisites | Verification evidence | Classification |
|---|---|---|---|---|---|---|---|
| سجل المصروفات / Expense records | Store-wide expense records: create, correct, void, replace | `/expenses` («المصروفات») | View: owner/manager; manage: owner/manager (`expenses.view` gates the page) | Store-wide (no per-expense ownership); every mutation attributed to the actor | — | `tests/expense-records`, `test:expense-api`, `test:expense-attempt` | Implemented and verified |
| دفع المصروف وعكسه / Expense payments & reversals | Pays an expense (cash payments write a linked drawer movement) and reverses payments | `/expenses` | Owner, manager (`expenses.pay`, `expenses.reverse` — separate grants) | Cash payment/reversal requires `cash.movements.manage` and a real open shift, deliberately not bypassed by settings | Open shift for cash | `tests/expense-payments`; roles doc | Implemented and verified |

### A12. Printing (الطباعة)

| Feature (AR / EN) | What it does | Where accessed | Who | How it works | Prerequisites | Verification evidence | Classification |
|---|---|---|---|---|---|---|---|
| طابعات ESC/POS / Thermal printers | Configures printers (USB/network/browser-WebUSB), paper 58mm/80mm, per-printer role (receipts, kitchen stations, default) | Settings → Printers (`PrintersSettingsTab`) | Owner, manager (`printing.manage`-equivalent: matrix "Manage printers") | 80mm unified on the backend profile width (48 columns); deterministic named WebUSB selection (configured default first, else stable name/id order — never a silent empty pick) | Printer hardware | `tests/printer-api` (94 checks), `test:printer`, `test:webusb-printer-selection`, audit fix D5 | Implemented but not fully verified (real printers = pending device phase) |
| فاتورة العميل / Receipt printing | Arabic-first receipt; the owner's stored currency unit wins over system symbols; footer «Powered by Ali.J»; templates: Classic / Compact / Detailed + merchant templates | POS payment, `/orders`, `/print-test` | Owner, manager, cashier (`printing.execute`) | ESC/POS builder is **fail-closed**: a financial line that cannot be represented yields an empty buffer — never a bill without totals. Non-financial unrepresentable lines are rasterised or warned (warnings stored on the bill, shown on reprint) | Printer configured | `tests/receipt-column-oracle` (byte-pinned golden), `test:receipt-printing`, `test:bill-print-warnings` (17 checks), `test:issue-266-currency-symbol-print`, `test:merchant-print-templates` | Implemented and verified (byte-level oracle); physical output pending device phase |
| تأكيد الطباعة / printed_at discipline | A bill is marked printed only when dispatch is confirmed | Print flows | — (system) | `bills.printed_at` set on confirmed dispatch / manual mark requires `{confirmed: true}`; the durable print queue marks it only after a successful resend | — | `tests/bill-printed-at` (16 checks), D5 (F-026) | Implemented and verified |
| إيصال التوصيل / Delivery (courier) slip | Slip with the customer's full phone + address for the courier | Print flows for delivery orders | Owner, manager, cashier | Separate document kind (never routed through the receipt builder); phone shown when either delivery phone setting allows it; over-long legacy addresses are bounded and the truncation is printed, never silent | Delivery order with customer | `tests/delivery-slip-printing` (`test:delivery-slip`); invariants doc | Implemented and verified |
| قوالب طباعة التاجر / Merchant print templates | Custom receipt templates (import/export), validated against the `escpos-line-template-v1` contract | Settings → Printers / bill template tab | Owner (manage), owner+manager (view) | Templates render through the classic pipeline so financial lines stay fail-closed; pack (bundle) templates stay raster-off | — | `tests/merchant-print-templates`, `test:merchant-template-import-export`, `docs/reference/merchant-print-templates.md` | Implemented and verified |
| صفحة اختبار الطباعة / Print test page | Builds test tenants/orders/bills to verify printer setup without real sales | `/print-test` | Owner, manager | Uses `frontend/src/lib/printer/test-data.ts` fixtures | Printer configured | Print-test page source; `tests/printing-settings` | Implemented but not fully verified (hardware-dependent) |
| إعدادات محتوى الفاتورة / Bill content settings | Toggles: store name/address/phone, logo, customer name/phone, table number, tax breakdown, tax id, footer message, auto-print bill/KOT, print-on-payment/print-on-place | Settings → Printers (Bill Content) | Owner, manager | Stored settings consumed by all renderers (backend thermal, browser HTML, frontend encoder) | — | `tests/printing-settings`, `test:print-language-settings`, `test:receipt-settings-hydration` | Implemented and verified |

### A13. Settings & tax (الإعدادات والضرائب)

| Feature (AR / EN) | What it does | Where accessed | Who | How it works | Prerequisites | Verification evidence | Classification |
|---|---|---|---|---|---|---|---|
| بيانات المتجر والهوية / Store details & branding | Store name, address, phone, email, tax id, store logo upload/remove, receipt logo toggle | Settings → General (`GeneralSettingsTab`) | Owner, manager (`settings.manage`) | Logo stored locally and used on receipts/menu prints | — | `tests/receipt-logo-printing`; settings page source | Implemented and verified |
| العملة ووحدة العملة / Currency & currency unit | Business currency (picker restricted to **SYP / USD**; a stored or previously recommended value stays listed) and a merchant-editable currency unit (e.g. `SP`) | Settings → General | Owner, manager | Defaults SYP + `SP`; amounts render whole for SYP (ISO fraction digits via `Intl`), Latin digits always. **Post-setup currency change is destructive**: owner-only, Master-PIN-gated reset flow that backs up, recreates the DB, keeps only the catalog, zeroes prices/stock | — | `tests/currency`, `test:currency-split-checks`, `test:currency-reset`, `test:currency-payments-refunds-minor-units`; invariants doc | Implemented and verified |
| اللغة والمظهر / Language & appearance | UI language picker offers **Arabic and English only** (`selectable: true` for `ar`/`en`; 22 other catalogues stay registered for print labels/saved prefs but are frozen), theme light/dark/system, locale display preferences (digits/calendar display options where applicable) | Settings → General/Appearance (`LocalePreferencesPanel`) | Owner, manager; personal language preference per user | `frontend/src/lib/i18n/languages.ts` is the single source of truth; dates always render DD/MM/YYYY Gregorian numeric | — | `tests/language-default`, `test:locale-chunks`, `test:issue-390-locale-preference-invariants`, `test:business-date-format`, `test:theme-mode-settings` | Implemented and verified |
| المنطقة الزمنية وبداية يوم العمل / Timezone & business day | Store timezone (default `Asia/Damascus`) and business-day start time drive day boundaries, reports and refund tiers | Settings → General | Owner, manager | Business timestamps stored UTC, presented business-local | — | `tests/business-date`, `test:dashboard-business-date`, `test:timezone-report-boundaries`, `test:issue-389-timezone-override` | Implemented and verified |
| الضريبة اليدوية / Manual tax configuration | Owner enables taxes and defines rates directly — the normal Rest&Cafe tax mode (Off / Manual) | Settings → Tax (`TaxConfigurationPanel`) | Owner, manager (`tax.config`); pack install/activate = owner only | Single authoritative engine `TaxEngine.calculate()` (decimal.js, backend-only); per-category rates, inclusive/exclusive behaviour; a production bug in manual mode under real settings was found and fixed with a dedicated regression suite | — | `tests/manual-tax-config`, `test:manual-tax-production` (12 checks), `test:tax-engine`, `test:tax-components`, `test:integration-tax`, `test:integration-inclusive-tax` | Implemented and verified |
| رسم الإنفاق الاستهلاكي / Syria consumption fee | Syrian consumption fee applied to the whole bill as its own bill line | Settings → Tax → «رسم الإنفاق الاستهلاكي» (`tax.modeSyria`) | Owner, manager | One classification question: unrated/popular **0%**, 2–3 stars **5%**, 4–5 stars **10%**, nightclub **20%**; the rate stays editable; implemented as the bundled `syria-consumption` profile on the generic pack framework; item refunds return the item's fee share | Tax mode = Syria consumption | `tests/syria-tax-profile` (46 checks), `test:e2e-syria-default-flow` (`test:e2e-syria-default`) | Implemented and verified |
| ضريبة المبيعات المعلنة 2027 / Announced sales tax | The announced early-2027 Syrian sales tax as a user-selectable profile (default 5%) | Settings → Tax (`syriaProfile: 'sales'`, `syria-sales` pack id) | Owner, manager | Owner chooses consumption fee **or** sales tax profile; switching the active tax pack is atomic — a conflicting switch is refused (409 `active_pack_conflict`) and the old pack stays active; packs can be deactivated via `POST /api/tax-packs/:packId/deactivate` | — | `tests/syria-tax-profile`, `test:tax-pack-switch-atomicity`, `test:tax-pack-catalog` | Implemented and verified |
| الرسوم الإضافية / Charges & surcharges | Configurable order-level charges (service, packaging, custom %/fixed, waivable, auto-apply, per order type) | Settings → Charges (`ChargesSettingsCard`) | Owner, manager (`settings.manage`); read also for order creators | Applied charges snapshot onto the order: disabling a definition later never rewrites existing orders; retained snapshots without an active definition stay visible but read-only | — | `tests/charges-engine-api` (`charges-engine`), `test:charges-calculation`, `test:charges`; invariants doc | Implemented and verified |
| ترقيم الطلبات والفواتير / Order & invoice numbering | Prefixes, date inclusion, reset periods (daily/monthly/financial-year/never) for order and invoice numbers | Settings → General | Owner, manager | Sequence generation inside the order transaction; repair path exists for sequence drift | — | `tests/order-numbering-settings`, `test:sequence-generation`, `test:sequence-repair-performance` | Implemented and verified |
| التشغيل التلقائي مع ويندوز / Windows autostart | App starts with Windows sign-in; owner toggle, **on by default** | Settings → General (`settings.autostartEnabled`) | Owner, manager | `main/services/autostart.ts` applied at startup (`main/index.ts`) and on settings save | Windows install | `tests/autostart` (23 checks), D4 (F-005) | Implemented but not fully verified (real Windows-login behaviour = device phase) |
| المنافذ وإعادة الاكتشاف / Port-bump notice & host re-discovery | If 3001–3003 are taken, the app moves ports and tells the operator the live ports; LAN clients re-discover the host via `flo.local` fallback | Startup banner; Settings info endpoints (`/api/server-ports`, `/api/pos-info`, `/api/server-app-info`) | All staff (info) | Port collision handling + mDNS-style re-discovery so tablets/KDS keep finding the host after a bump | — | `tests/server-ports` (32 checks), `test:server-port-collision`, `test:host-rediscovery` (21 checks), D4 (F-006/F-030) | Implemented and verified |
| وضع عدم الاتصال / Offline mode | Owner switch that disables the one optional outbound connection; on by default (i.e. offline posture default), restore-protected | Settings → Privacy (`OfflineModeCard`, `PUT /api/settings/offline-mode`) | Owner only (`offline-mode.manage`, non-configurable) | Local-only product: the build's outbound URL allowlist is empty | — | `tests/offline-mode`, `test:no-external-services`, `test:url-allowlist`; cloud-integrations doc | Implemented and verified |
| قاعدة البيانات: نسخ واستعادة / Database backup & restore | Manual backup download, local scheduled backups, restore from file, DB health check, initialise/reset database | Settings → Backup & Data (`DatabaseSettingsTab`, `LocalBackupCard`) | **Owner only** (`database.tools`) | Backup files named **`rest-cafe-backup-*.db`** (`main/services/local-backup.ts`); restore replaces data but keeps device/security state, takes a safety copy first, and on a clean install no longer deactivates the restored owner (D6/F-022 fix + runbook in `docs/maintainers/upgrade-testing.md`); destructive actions are Master-PIN gated | Master PIN for destructive ops | `tests/backup`, `test:local-backup`, `test:backup-restore`, `test:backup-restore-production`, `test:restore-fresh-install` (20 checks), `test:restore-from-file-api`, `test:restore-safety-copy`, `test:database-tools-api` | Implemented and verified |
| سلامة قاعدة البيانات عند الإقلاع / Startup DB-integrity warning | If the database fails its integrity check at startup, a warning banner tells the operator instead of failing silently; WAL is checkpointed on close | App shell (`common.dbIntegrityWarning`) | All staff (banner) | Startup health check + `wal_checkpoint` on shutdown | — | `tests/wal-checkpoint` (8 checks), `test:db-audit`, `test:schema-health`, D4 (R-01/R-02) | Implemented and verified |

### A14. Standalone & customer-facing surfaces

| Feature (AR / EN) | What it does | Where accessed | Who | How it works | Prerequisites | Verification evidence | Classification |
|---|---|---|---|---|---|---|---|
| تطبيق السيرفر / Server App (waiter handheld) | A narrow ordering surface for waiters on phones/tablets over the LAN: tables, catalog, create/append orders, customer search/create, forward KOT/bill prints | `/server-standalone` on **:3003** | Waiter (`server`), manager, owner (`server-app.use`) | Filtered proxy to :3001 with its own login; disabled feature ⇒ routes return 404 (not discoverable). **No money actions**: no payments/refunds for the server role; after placing an order the waiter returns to the table map | Server App enabled in Settings → Server App | `tests/server-app-server-role`, `test:server-app-maintenance-handoff`; `main/server-app.ts` | Implemented and verified |
| الطلب الذاتي للعميل / Customer self-order | Customers scan a per-table QR and order from their phone; the order lands in the normal staff pipeline | `/self-order?t=<token>` on :3003 | Customers (no login) | Token = HMAC of table id + per-table salt under a store secret; owner enables and regenerates codes in Settings → Server App (`SelfOrderSettingsCard`, `/api/self-order-admin`). Server rebuilds the cart from the DB (payload prices/discounts/charges are impossible), forces the token's table + dine-in, marks the order `online_platform='self_order'`, fires the same KDS notification + KOT print; disabled ⇒ 404 | Server App + self-order enabled | `tests/self-order`; invariants doc | Implemented and verified |
| شاشة عرض العميل / Customer display | A second screen facing the customer showing the current bill/order feed; pairing + display configuration | `/customer-display` | Customers (view), owner/manager configure | Feed API `/api/customer-display`; pairing flow; settings card `CustomerDisplayCard` | Second screen | `tests/customer-display-feed`, `test:customer-display-pairing`, `test:customer-display-config`, `test:customer-display-settings-route` | Implemented but not fully verified (real second-screen use = device phase) |
| شاشة المطبخ المستقلة / Standalone KDS screen | Full-screen kitchen display served on :3002 for a dedicated screen/tablet, with its own login | `/kds-standalone` on :3002 | Chef, manager, owner | `main/kds-server.ts` serves the page + `/api/kds/orders`; same WebSocket handler as the in-app KDS | KDS enabled | `tests/kds-window-hardening`, `test:kds-integration` | Implemented and verified |

### A15. Support & diagnostics (الدعم)

| Feature (AR / EN) | What it does | Where accessed | Who | How it works | Prerequisites | Verification evidence | Classification |
|---|---|---|---|---|---|---|---|
| التشخيصات / Diagnostics | Local log of operation failures + a copyable support bundle (with optional log tail) for troubleshooting | `/support` («الدعم», DiagnosticsPanel) | All roles (`support` permission ships to all five roles) | Records are **local-only** (`main/services/operation-diagnostics.ts`); nothing is sent anywhere automatically. The old cloud ticket-submission flow was removed (see §E) | — | `tests/diagnostics-event`, `test:diagnostics-screen`, `test:diagnostic-signature`, `test:diagnostics-feature-coverage` | Implemented and verified |
| حدود المعدل على الشبكة / LAN rate limiting | API abuse/loop protection that still allows a busy LAN: 100 req/min per external IP, 600/min on the LAN (static routes 600/3600) | — (system) | — | `generalApiRateLimit()` in `main/server.ts`; auth/PIN/order-write limiters stay strict for everyone (D6/F-031) | — | `tests/cors-security` (updated), `test:order-write-rate-limits`, `test:cross-server-login-rate-limits` | Implemented and verified |

---

## B) End-to-end restaurant workflows the app supports

1. **Dine-in service (the core day cycle)** — Waiter/cashier opens `/tables` → picks a table → POS
   workspace → adds items (variants/add-ons/notes) → order created (table becomes مشغولة, KOT prints
   per station, KDS lights up) → kitchen advances items pending → preparing → ready → served →
   «طُلب الحساب» → bill generated → payment (cash/card, partial allowed) → order completes → table
   returns to متوفرة. Pinned by `tests/restaurant-day-cycle` (116 checks) and
   `tests/restaurant-full-house` (40-table rush, 1,291 assertions, zero money findings).
   Screens: `/tables`, `/pos`, `/kds`, `/orders`.
2. **Held cart** — Cashier builds a cart, holds it on the table (table shows held), serves someone
   else, resumes the held cart and checks out. Screens: `/pos`, `/tables`. (`tests/held-orders*`)
3. **Waiter handheld flow** — Waiter signs into the Server App (:3003) → table map → order → items
   go to kitchen; the waiter cannot take money and lands back on the table map. Screens:
   `/server-standalone`, `/tables`. (`tests/server-app-server-role`)
4. **Customer self-order** — Customer scans the table QR → `/self-order` → orders; the order appears
   on KDS and prints a KOT like any waiter order; staff bill and take payment normally.
   (`tests/self-order`)
5. **Takeaway** — POS order of type takeaway (no table), kitchen flow identical, bill + payment at
   the counter. Screens: `/pos`, `/kds`.
6. **Delivery** — POS order of type delivery with a linked customer → kitchen → bill → payment →
   courier slip printed with full phone + address. (`tests/delivery-slip-printing`)
7. **Split check at payment** — A guest leaves early: cashier splits their items into a separate
   check in the payment modal, settles it, and the rest of the table continues. (`split_group_id`
   bills; `tests/payment-methods-split-checks`)
8. **Table move & merge** — Guests move: order moved to another table (`move-order`); two tables
   join: orders merged from `/tables`. (`tests/table-move-ui`)
9. **Discount with approval** — Manager applies a % discount within caps; above the configured
   behaviour a manager PIN approval is requested and logged. (`tests/discount-system`)
10. **Refund after payment** — Owner/manager opens the paid bill's order → RefundModal → full /
    partial / single-item refund approved with the approver's Staff Approval PIN (tier rules by age)
    → money returned in cash/card or as store credit. (`tests/refunds`,
    `test:refund-completed-orders`)
11. **Kitchen rush with stations** — Orders route by category to stations (grill/drinks); each
    station's chef sees only their items; station printers emit their own KOTs; a dropped print is
    retried from the durable queue; a reconnected screen chimes once. (`tests/issue-134-*`,
    `test:kot-print-queue`, `test:kds-reconnect-chime`)
12. **Day opening & closing** — Open shift with counted float → trade all day → close own shift →
    daily cash closure (Z) reconciles sessions/payments/refunds → owner reviews Reports → Cash.
    (`tests/cash-sessions`, `test:cash-closures`)
13. **Menu maintenance** — Manager edits categories/products/add-ons, marks an item sold out (POS
    and order API refuse it), bulk-updates the menu via CSV export → edit → import round-trip.
    (`tests/sold-out-backend`, `test:issue-248-csv`)
14. **Recipe-driven stock** — A product with a recipe depletes supplies per sale (scaled by variant
    portion); cancelling a pending item restores exactly what was taken; profitability report shows
    real margins only where costs are known. (`tests/recipe-order-lifecycle`,
    `test:ingredient-cost-lifecycle`)
15. **Owner administration** — Owner creates staff, tunes a role's permissions (e.g. lets a trusted
    cashier view reports), reviews the permission change history, configures taxes (manual or Syria
    consumption fee), printers, and backups. (`tests/authorization-permissions`, `test:staff-authz`)

---

## C) Reports & dashboards inventory

**Owner dashboard (`/dashboard`)** — today/month toggle: مبيعات اليوم (today's sales), الطلبات
(orders), الطلبات الجارية (running), الطلبات المعلقة (pending), الطاولات المشغولة (occupied tables),
إجمالي الإيرادات (gross collections), إجمالي التحصيلات الصافية (net collections), الفواتير المحصلة
(bills collected), متوسط قيمة الطلب (AOV), متوسط وقت التحضير (avg prep time), متوسط مدة الخدمة لكل
طاولة (avg table turn), أفضل الأصناف (top products today/month), أهم الفئات (top categories), طرق
الدفع (payment-method mix), أنشط الموظفين (top staff), العملاء الجدد (new customers), أنماط الأعمال
(busiest/idlest hour & day), نشاط الاسترداد (refund activity), الطلبات الأخيرة (recent orders).
Evidence: dashboard page source + `ar.json: dashboard.*`; `tests/dashboard-business-date`.

**Reports page (`/reports` — «التقارير», subtitle: «تقارير اليومية والمبيعات والصندوق من دفتر
المبيعات»)** — tabs: المبيعات (Sales), الصندوق (Cash), ربحية الأطباق (Profitability).

- **Sales tab:** الدفعات حسب الوسيلة (payments by method), حسب الصنف (by product), حسب التصنيف (by
  category), حسب نوع الطلب (by order type), حسب الساعة (by hour). Evidence: reports page source;
  `tests/reports-insights`, `test:reports-reconciliation`, `test:reports-tabs-live`,
  `test:reports-export`, `test:timezone-report-boundaries`.
- **Cash tab:** التحصيل اليومي (daily collections), جلسات الصندوق (sessions), إغلاقات اليوم
  (closures). Evidence: `tests/cash-closures`, `test:cash-sessions`.
- **Profitability tab:** per-dish revenue/cost/margin over known-cost lines only (see A10).
  Evidence: `tests/ingredient-cost-lifecycle`; reports page `tabProfitability` section.
- **Daily sales export (تصدير المبيعات اليومية):** owner-only accounting export with
  reconciliation identities, CSV/JSON formats (`docs/reference/daily-sales-export.md`), gated by
  `reports.financial.view` + `reports.daily-sales.export`. Evidence: `tests/daily-sales-export`.
- **Financial figures** (revenue, refunds, payment mix) are permission-gated to the owner by
  default (`reports.financial.view` = owner only in the shipped matrix); managers see sales and
  operations reports without financial figures unless the owner grants it.

---

## D) Troubleshooting facts (grounded in code/docs only)

1. **Ports 3001–3003 busy at startup** — another process (or a previous app instance) holds a port.
   The app detects collisions, can bump to free ports and shows the live ports; repo tooling uses
   `npm run clean` (`node kill-ports.js 3001 3002 3003`). Evidence: repo-root `AGENTS.md` sharp edges;
   `tests/server-port-collision`, `test:server-ports`; Settings shows `portMovedFrom` / live port.
2. **Tablets/KDS can't find the host after a port change** — use the re-discovery surface: the host
   advertises `flo.local` as a stable fallback and Settings exposes live connection info/QR for POS,
   KDS and Server App (`/api/pos-info`, `/api/kds-info`, `/api/server-app-info`).
   Evidence: `tests/host-rediscovery`, D4 (F-030).
3. **"Offline" banner / orders not sending from a tablet** — the POS shows a persistent offline
   indicator when the LAN connection drops; the cart is preserved as a local draft and catalogue
   loading retries automatically; stale postpaid attempts are listed rather than lost. Check the
   host PC is on and on the same LAN. Evidence: `tests/pos-wifi-drop`, D2.
4. **Kitchen ticket didn't print** — failed prints sit in a durable pending-print queue and are
   retried; a bill is only marked printed after confirmed dispatch. Check the station's printer
   assignment and run `/print-test`. Evidence: `tests/kot-print-queue`, `test:bill-printed-at`.
5. **Wrong printer chosen (WebUSB)** — selection is deterministic: the configured default wins,
   otherwise a stable name/id order; two devices with the same product name are deliberately
   refused as ambiguous. Name printers distinctly in Settings → Printers. Evidence:
   `tests/webusb-printer-selection`, D5 (F-027).
6. **Receipt missing totals / blank print** — by design this cannot happen silently: the ESC/POS
   builder is fail-closed (an unrepresentable financial line yields no bill at all rather than a
   bill without totals); non-financial line problems are stored as print warnings on the bill and
   shown when reprinting. Evidence: `tests/bill-print-warnings`, `test:receipt-column-oracle`.
7. **Forgot owner password** — use `/auth/recover` with the Master PIN set during setup. If both
   the password and the Master PIN are lost, recovery requires the database initialise/reset flow
   (Settings → Database tools), which forces a backup first and erases local data — per the setup
   recovery note in `ar.json: setup.cloudRecoveryNoteDisabled`. Evidence:
   `tests/issue-127-password-recovery`, `test:master-pin`.
8. **Restore brought back a disabled owner (old builds)** — fixed in D6 (F-022): restoring onto a
   user-less clean install keeps the restored owner active; the supported on-device path is:
   complete first-run setup with your own owner, sign in, then restore from Settings → Database —
   backup-only accounts stay disabled until the owner re-enables them in Staff. Runbook:
   `docs/maintainers/upgrade-testing.md`. Evidence: `tests/restore-fresh-install`.
9. **Database warning banner at startup** — the app runs an integrity check at startup and shows
   `common.dbIntegrityWarning` instead of starting silently on a damaged DB; restore the latest
   `rest-cafe-backup-*.db` from Settings → Backup & Data. Evidence: `tests/db-audit`,
   `test:schema-health`, D4 (R-01).
10. **App didn't start with Windows** — check Settings → General → autostart toggle (on by
    default); the toggle applies at next sign-in. Evidence: `tests/autostart`, D4 (F-005).
11. **Currency looks wrong / amounts show decimals** — SYP is a whole-unit currency: amounts render
    with no fraction digits and Latin digits by design; the printed unit is the owner's stored
    currency unit (e.g. `SP`), which wins over system symbols. Evidence: `tests/currency`,
    `test:issue-266-currency-symbol-print`; invariants doc.
12. **A suite/screen says a feature is "not available on this device"** — several owner tools are
    desktop-only surfaces (database tools, mobile-access screens in legacy builds); run them on the
    host PC. Evidence: `ar.json: settings.notAvailableOnDevice`; settings page gating.

---

## E) NOT features — hidden, removed, or dormant (never document or advertise)

Authoritative source: `docs/architecture/cloud-integrations.md` ("Removed in this fork") plus the
locked product decisions. Several of these still have **dormant database tables, permission
catalog rows, or translation strings** — presence in `ar.json`/`shared/permissions.ts` is not
availability.

| Item | Status | Evidence |
|---|---|---|
| WhatsApp receipt delivery / WhatsApp settings | **Removed end-to-end** (service, routes, IPC, UI). Dormant DB tables remain only so migrations stay valid. `nav.whatsapp` and `settings.enableWhatsapp*` strings are leftovers | cloud-integrations.md |
| Google Drive backup | **Removed end-to-end** (service, OAuth, routes, UI). Legacy `google_drive_*` rows in old DBs are inert and scrubbed on import/reset. Local backup only | cloud-integrations.md; A13 backup row |
| FloAdmin cloud sync, cloud account, RevFlo mobile pairing, OrderFlow online-order polling | **Removed end-to-end**; no cloud identity is minted for new installs. Dormant settings rows/outbox tables are inert data | cloud-integrations.md |
| Anonymous telemetry / PostHog product analytics | **Removed end-to-end**; no anonymous id is created | cloud-integrations.md |
| Automatic software updates (updater) | **Removed end-to-end**; new builds are produced from the repo and installed by hand. `settings.tabUpdates`/`update.*` strings are leftovers | cloud-integrations.md |
| Cloud support-ticket submission | **Removed** (it queued tickets to a vendor cloud). The local Diagnostics screen remains (§A15) | cloud-integrations.md |
| Country tax-pack downloads / bundled country packs & country profiles | **Removed**: no country picker in setup or Settings, no downloadable catalog. Only the empty generic pack framework (`local-generic`) + the Syria profiles shipped as product configuration; taxes are manual otherwise | invariants doc; `main/tax-packs/` |
| Loyalty program UI (نقاط/كاش باك) | **UI removed** — no loyalty screens, no `enableLoyalty` surface in the shipped settings. The backend ledger (`loyalty_ledger`) is dormant and is used only as the accounting mechanism for store-credit refunds when a customer is attached; do not present loyalty/cashback as a feature | Locked decision; invariants doc (refund rule 6) |
| Online order type in POS | **Hidden** — the `online` order type exists in the data model but is not offered in the POS UI | Locked decision; order-lifecycle doc lists the type, UI does not expose it |
| POS Workflow settings card | **Removed from Settings UI** (the `settings.posWorkflow` string remains in the catalogue) | Locked decision; settings components inventory |
| Seven product-form fields | **Hidden** in the current product form (legacy catalog fields not presented for editing) | Locked decision; products UI simplification record (`docs/IMPLEMENTATION_REPORT_AR.md`) |
| Cleaning table status («تنظيف») | **Banned from the UI** — not part of the table lifecycle | Locked decision; `main/routes/tables.ts` status list |
| Per-order ownership restrictions | **Do not exist by design** — no "my orders only" mode | invariants doc |
| Multi-branch / cloud multi-device sync, online ordering platforms, delivery-app integrations | **Not implemented** — no code paths found | Repo-wide inspection |
| Iran/Persian calendar & Toman display options | Dormant legacy settings strings (`settings.iran*`) — not an offered Rest&Cafe configuration; currency choice is SYP/USD and dates are DD/MM/YYYY Gregorian | Locked decisions; `ar.json` leftovers |

---

## F) What could NOT be verified in this investigation (flagged plainly)

1. **Test suites were not re-executed.** "Implemented and verified" rests on: the suite exists in
   `tests/`, is wired as a `test:*` script in `package.json`, belongs to the CI protecting set, and
   the project's landing records (decisions 039–044, follow-ups in
   `docs/IMPLEMENTATION_REPORT_AR.md`) report it green at head `921140c`/`6f873f1`. A fresh full
   run was outside this task's read-only scope.
2. **Windows runtime behaviour is unproven on real hardware** — the owner's device phase is still
   pending: actual installer run (installer build 41473517475 exists for head `921140c`), touch
   input, sound, Windows-login autostart in the wild, real thermal printers, cash-drawer pulse,
   and second-screen KDS/customer-display pairing. Anything depending on these is classified
   "Implemented but not fully verified" above.
3. **The live application was not run** (per task constraints: no servers started), so no claim
   here rests on clicking through the UI; screen purposes come from route/page source, components,
   and `ar.json` strings.
4. **`/auth/register`'s exact role in the shipped flow** (standalone sign-up vs. owner-created
   account path) was not traced end-to-end; it is classified conservatively.
5. **Dashboard "Business patterns"** has no dedicated named suite found; the widgets exist in the
   page source and strings, hence "not fully verified".
6. **Split-check behaviour** is evidenced by bill `split_group_id` handling, the POS PaymentModal
   split flow, the `splitChecks` setting, and the split-checks test file name; its assertions were
   not read line-by-line.
7. **Exact set of the seven hidden product-form fields** was not enumerated field-by-field; the
   hiding itself is a locked, recorded decision.
8. **Printer model compatibility** (specific ESC/POS models) is not enumerated anywhere in the
   sources inspected; only generic profiles (58/80mm, USB/network/WebUSB) are documented.
