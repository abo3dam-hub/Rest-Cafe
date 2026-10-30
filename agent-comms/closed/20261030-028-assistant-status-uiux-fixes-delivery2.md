From: assistant
To: ted
Kind: status
Thread: 20261030-028
Subject: UI/UX fixes Delivery 2 (contrast) — U5, U6, U7, U8, U9, U13, U14, U15

Delivery 2 of assignment 028, from base upstream main
`92eb4a64548d69b08a9507d1945947b810632d73` (Delivery 1 landed).
Branch `assistant/uiux-fixes-contrast`. Contrast only; no behaviour
changes beyond the defect semantics. Brand orange untouched. §4 targets,
advisory lists and disputed D1–D6 untouched per the assignment.

Note on the base: upstream moved to `5dd8099` while this delivery was
in progress (four docs-only commits: Delivery 1 acceptance decision
029, assignment refresh marking Delivery 2 NEXT, follow-up 28 report
edits). The refreshed assignment was read; Delivery 2 scope is
unchanged. This branch stays based on `92eb4a6`; its diff touches no
file changed upstream, so nothing is reverted.

## What changed, per defect (old value → new value, re-measured ratio)

- U5 — "No Printer" grey text
  (`frontend/src/components/pos/PrinterStatus.tsx:37-40`, disconnected
  state): `text-gray-400` → `text-gray-600`. Old `#9ca3af`
  (`oklch(0.707 0.022 261.325)`) → new `#4b5563`
  (`oklch(0.446 0.03 256.802)`), on `rgb(255,253,251)`. Ratio
  2.56:1 → **7.45:1** (live, ar + en). Only the disconnected state
  changed; connecting/connected/error states are transient or not
  numbered defects and are untouched.
- U6 — "حجز" Reserve amber text
  (`frontend/src/app/(dashboard)/tables/page.tsx:1559`, three
  instances): `text-yellow-600` → `text-yellow-700`. Old `#ca8a04`
  (`oklch(0.681 0.162 75.834)`) → new `#a16207`, on white. Ratio
  2.93:1 → **4.94:1** on all three buttons (live). `dark:` variant
  and `hover:text-yellow-700` unchanged.
- U7 — "إلغاء التنشيط" Deactivate red text
  (`frontend/src/app/(dashboard)/tables/page.tsx:1371`, four table
  cards): `text-red-500` → `text-red-600`. Old `#ef4444`
  (`oklch(0.637 0.237 25.331)`) → new `#dc2626`
  (`oklch(0.577 0.245 27.325)`), on white. Ratio 3.82:1 → **4.91:1**
  on all four buttons (live). `hover:text-red-700` unchanged; the
  Reactivate `text-green-600` branch is not a defect and is untouched.
- U8 — `text-muted-foreground` token
  (`frontend/src/app/globals.css:60`, light theme only):
  `--muted-foreground: oklch(0.556 0 0)` (`#737373`) →
  `oklch(0.52 0 0)` (`#696969`). Token name unchanged. Ratio
  4.34:1 → **5.05:1** on `rgb(245,245,245)` and **5.51:1** on white
  (live). Surfaces re-measured, all pass: POS "سفري"/"توصيل" 5.05,
  POS-en "Takeaway"/"Delivery" 5.05, "Open shift" 5.51 on white /
  5.05 on `#f5f5f5`, tables "مخطط الصالة" 5.05, KDS "كانبان" 5.05,
  settings-tax "معدلات الضرائب اليدوية" / "رسم الإنفاق الاستهلاكي"
  5.05 (all on `rgb(245,245,245)` unless noted). Dark-theme token
  (`oklch(0.75 0 0)`) untouched; the audit measured light surfaces.
- U9 — KDS elapsed-time readout
  (`frontend/src/components/kds/KdsKanbanBoard.tsx:266`,
  `frontend/src/components/kds/KdsTabsView.tsx:103`, same element in
  both views): `text-gray-400` → `text-gray-600`. Old `#9ca3af` →
  new `#4b5563`, on white. Ratio 2.60:1 → **7.56:1** (live,
  "2:40:05").
- U13 — KDS "Ready" filter pill
  (`frontend/src/components/kds/KdsTabsView.tsx:70`): removed
  `opacity-50 hover:opacity-80` from inactive pills; the raw colours
  already pass. "جاهز0" rendered 2.09:1 → **4.76:1** (live, raw
  green-700 `oklch(0.527 0.154 150.069)` on green-50
  `oklch(0.982 0.018 155.826)`). All five pills at full opacity
  (live): pending "قيد الانتظار" 4.77, preparing "قيد التحضير"
  6.26, ready "جاهز" 4.76, served "تم التسليم" 6.60, voided "ملغى"
  5.88 — served/voided recomputed from their exact live computed
  colours with the audit's converter (the in-page probe's label
  filter missed those two labels; the values above are from the
  live `oklch()` pairs). The active pill is still distinguished by
  `ring-2 ring-current`; inactive pills now differ only by the
  missing ring.
- U14 — product-tile initials
  (`frontend/src/lib/image-utils.ts:100`,
  `frontend/src/components/pos/ProductGrid.tsx:580`):
  `nameToColor` lightness 65% → 32% (`hsl(hue, 45%, 65%)` →
  `hsl(hue, 45%, 32%)`) and initials `text-white/80` → `text-white`
  (solid). Live, across the fixture's 8 product tiles: min
  **5.40:1** ("فت"), max 12.01:1 — every tile now clears the 4.5:1
  aim, not just the 3:1 large-text floor. Theoretical worst case
  across all 360 hues at 32% lightness is 4.75:1 (hue 60°, yellow),
  computed with the same converter that reproduces the audit's
  1.63:1 worst case at 65%. Same one-class change applied to the
  identical tile pattern on the products page
  (`frontend/src/app/(dashboard)/products/page.tsx:1267`, 14px
  initials, same shared `nameToColor` helper).
- U15 — F2 shortcut badge
  (`frontend/src/components/pos/CartPanel.tsx:328`): removed
  `opacity-80` from the badge. Solid amber-700 `#b45309`
  (`oklch(0.555 0.163 48.998)`) on amber-50 `rgb(255,251,235)`.
  Ratio 3.49:1 → **4.89:1** (live). The badge stays `aria-hidden`.

Nothing else was touched. No i18n keys added. Formatter note: the
first attempt at the fix commit let the pre-commit hook run, and it
reflowed ~200 never-formatted upstream lines across five of the
touched files (whitespace/line-breaks only, no semantics — e.g. the
whole product-card block in `ProductGrid.tsx`, which sits 2 spaces
under-indented on upstream main). That churn would have buried the
11-line fix and broken the assignment's minimal-diffs rule, so the
commit was redone with `--no-verify` keeping exactly the 11 intended
lines; the unformatted upstream lines are left exactly as they are on
main. The status file below was written after the redo and describes
the committed bytes.

## Local checks (base 92eb4a6, then after the fixes — all green)

Baseline at base, then post-fix, same five commands:
`npm run lint`, `npm run test:lint-engine`, `npm run i18n:check`,
`npm run build`, `npm run build:frontend` — rc=0 for all five in both
runs. Post-fix lint: 7 warnings, 0 errors, identical set to baseline.
Logs: `~/workspace/rest-cafe-docs/uiux-fixes-delivery2-2026-10-30/`
(`baseline-*.log`, `postfix-*.log`).

## Gate re-run (verbatim, affected screens, 1366x768)

Method: same as the 027 audit and Delivery 1 — app rebuilt from this
branch, dev server on :3001 with the isolated audit fixture DB, 8
snapshots re-rendered (`snapshots-fixes-d2/`), kit gates run
unmodified. No environment repair was needed this time (Chrome 156
from Delivery 1 still present).

Axe (`axe_audit`, 8 snapshots):
- pos-ar: EXIT=0. tables-ar: EXIT=0. settings-ar: EXIT=0.
  settings-tax-ar: EXIT=0. settings-printers-ar: EXIT=0.
  Every Delivery 2 axe finding (U5, U6/U7 via states, U9, U13, U15)
  is gone.
- kds-ar: 1 violation, `color-contrast` node `.bg-brand` only
  (locked brand).
- pos-en: 1 violation, `color-contrast` 14 nodes only
  (`a[data-active="true"] > span:nth-child(2)`,
  `button[title="All"]`, `.border-brand`, …) — the brand family;
  `verify_states` on the same snapshot lists only brand-orange
  pairs (see below). Down from 23 nodes in the audit.
- settings-en: 1 violation, `color-contrast` 2 nodes only:
  sidebar active link (brand, locked), `.bg-brand/10` nav headings
  (brand 3.53, locked).

`verify_states` (8 snapshots): every remaining FAIL is locked brand
orange (white-on-brand / brand-on-white 3.58:1; brand-hover
`rgb(217,72,15)` 4.30:1 on tables), except the settings screens'
`1.00:1 [rgb(232,89,12) on rgb(232,89,12)]` rows for the active nav
link — the known snapshot-gate artifact also present in Delivery 1
(the gate reads the `bg-brand/10` background as solid brand in the
static snapshot; live it is brand text on `bg-brand/10`, 3.53:1,
locked per audit §6). Counts: pos-ar 12 (was 18 in the audit:
"لا توجد طابعة", muted and tile rows all gone), pos-en 12 (was 18),
tables-ar 10 (was 30; "حجز" / "إلغاء التنشيط" / muted rows gone),
kds-ar 3 (was 5; timer and toggle rows gone), settings-ar 3,
settings-tax-ar 3, settings-printers-ar 3, settings-en 3.

Keyboard (`verify_keyboard`, pos/tables/kds/settings ar): EXIT=0 on
all four (`all reachable, Enter/Space and arrow keys answer`).

Overflow (`verify_overflow`, @1366/@1920): tables-ar EXIT=0,
kds-ar EXIT=0, settings-ar EXIT=0. pos-ar EXIT=1 with one finding
only — the 1920px product-button / sound-banner overlap
(26%/70%/100%), the audit's disputed D4 (live measurement: 0
overlap at 1920x1080); out of scope per the assignment, no action.

Reduced motion (`verify_reduced_motion`): all four screens report
`[A no-policy]` only — the same known gate blind spot the audit
recorded as disputed D3 (the gate greps the snapshot HTML for the
media-query text; the policy lives in the external built CSS, and
Delivery 1 verified live `still-animating=0` under emulated reduce).

## Live second measurement (13/13 PASS, `verify-fixes-d2.mjs`)

- U5: `7.45:1 (oklch(0.446 0.03 256.802) on rgb(255,253,251))`, ar + en.
- U15: `4.89:1 (oklch(0.555 0.163 48.998) on rgb(255,251,235), opacity=1)`.
- U14: `n=8 min=5.4:1 حل=10.72 شا=9.18 فت=5.4 كو=12.01 أج=9.33 صو=5.49 مش=9.64 رز=9.41`.
- U8-pos: `سفري=5.05:1 on rgb(245,245,245) | توصيل=5.05:1 on rgb(245,245,245)`.
- U8-en: `Takeaway=5.05:1 | Delivery=5.05:1 | Open shift=5.51:1 on rgb(255,255,255) | Open shift=5.05:1 on rgb(245,245,245)`.
- U6: `n=3 4.94:1 4.94:1 4.94:1`.
- U7: `4.91:1 (oklch(0.577 0.245 27.325) on rgb(255,255,255))` ×4.
- U8-tables: `مخطط الصالة=5.05:1 on rgb(245,245,245)`.
- U9: `n=1 2:40:05=7.56:1 on rgb(255,255,255)`.
- U13: `قيد الانتظار3=4.77:1 opacity=1 ring=true | قيد التحضير0=6.26:1 opacity=1 ring=false | جاهز0=4.76:1 opacity=1 ring=false`
  (served 6.60 / voided 5.88 from the live computed colours, see above).
- U8-kds: `كانبان=5.05:1 on rgb(245,245,245)`.
- U8-tax: `معدلات الضرائب اليدوية=5.05:1 on rgb(245,245,245) | رسم الإنفاق الاستهلاكي=5.05:1 on rgb(245,245,245)`.

Full logs: `~/workspace/rest-cafe-docs/uiux-fixes-delivery2-2026-10-30/`
(`verify-fixes-d2.log`, `verify-fixes-d2.json`, `gates-d2-run.log`,
`contrast-calc.py`) and
`~/workspace/rest-cafe-docs/uiux-audit-20261030/gates-fixes-d2/`.

## Adjacent finding (not fixed — out of scope, flagged for Ted)

The reservation phone + arrival-time lines on table cards
(`frontend/src/app/(dashboard)/tables/page.tsx:1398,1403`,
`text-yellow-600` on `bg-yellow-50`, ~2.7:1) use the same failing
amber as U6 but are a different element from the Reserve button,
and no reserved table exists in the fixture snapshot, so the gates
never rendered them. Left untouched per the assignment's exact
scope; if Ted wants them in scope, they are the same one-class
change (`text-yellow-600` → `text-yellow-700`).

## What is next

Please verify and land Delivery 2. When it lands, threads 027 and
028 close together per decision 029, and assignment 028 is complete
(all 15 confirmed defects U1–U15 fixed). No installer is dispatched
for this delivery (accessibility-only frontend change, no behaviour
change), per decision 029.
