From: assistant
To: ted
Kind: status
Thread: 20261030-028
Subject: UI/UX fixes Delivery 1 (structure, names, semantics) — U1, U2, U3, U4, U12, U10, U11

Delivery 1 of assignment 028, from base upstream main
`1d0a3cbdb9847d75d1214b31c79bfe0496195339`. Branch
`assistant/uiux-fixes-structure`. One PR, no behaviour changes beyond the
defect semantics. Delivery 2 (contrast: U5–U9, U13–U15) follows after this
delivery lands.

## What changed, per defect

- U1 — viewport zoom disabled (`frontend/src/app/layout.tsx:44-48`):
  removed `maximumScale: 1` and `userScalable: false` from the `viewport`
  export; kept `width: 'device-width'` and `initialScale: 1`. Served HTML
  now emits `<meta name="viewport" content="width=device-width,
  initial-scale=1"/>` (verified on the live app and in the built output;
  zero occurrences of `maximum-scale`).
- U2 — KDS view switcher (`frontend/src/components/kds/KdsHeader.tsx:65`):
  honest toggle group, not a real tab pattern. Removed `role="tablist"`
  from the switcher container; the two buttons keep `aria-pressed`
  (tabs/kanban) and their existing behaviour. No new keyboard handling:
  as plain toggle buttons, arrow keys are not expected to move focus.
  Acceptance met: axe clean on the switcher (see gate output) and
  keyboard evidence below.
- U3 — business-name input
  (`frontend/src/components/settings/GeneralSettingsTab.tsx:180-183`):
  the visible label now has `htmlFor="business-name"` and the input has
  `id="business-name"`, following the pattern already used in this file
  (`business-day-start-time`). No other change to the field.
- U4 — the five unnamed settings selects, same file, same pattern
  (`htmlFor` on the visible label + `id` on the control):
  billing type (`billing-type`), tables required (`tables-required`),
  tax registered (`tax-registered`), sequence-reset period
  (`invoice-reset-period`), language (`language`; the visible "Languages"
  text was a `<p>`, now a `<label>` with the same classes). Also named
  the conditionally rendered printer-type select
  (`frontend/src/components/settings/PrintersSettingsTab.tsx:819-822`,
  `print-method`; its visible "طريقة الطباعة" text was a `<p>`, now a
  `<label>` with the same classes). No visible text changed.
- U12 — new-order alert buttons
  (`frontend/src/components/pos/PosOrderAlertBanners.tsx:35-46`,
  `frontend/src/components/kds/KdsWorkspace.tsx:66-77`): the live-region
  semantics moved from the button to a wrapper: the button is now a
  plain button (visible text is its accessible name) inside
  `<div role="status" class="fixed top-4 inset-x-0 mx-auto w-fit z-50">`.
  Positioning classes moved to the wrapper unchanged; the button keeps
  its visual classes and dismiss behaviour. The alert still announces
  through the wrapper's `role="status"`.
- U10 — sidebar brand-name clipping
  (`frontend/src/components/layout/Sidebar.tsx:228`): the brand span
  gained `leading-5` (20px line-height on 14px text; the parent had
  `leading-none`, so Arabic descenders were cut by 2px). The brand row
  sits in a fixed-height `SidebarMenuButton size="lg"`, so no sidebar
  layout shift beyond the clip fix; verified live (see below).
- U11 — reduced-motion policy (`frontend/src/app/globals.css:557-569`):
  widened the existing `@media (prefers-reduced-motion: reduce)` block
  beyond shake/shimmer with the standard rule covering all elements
  (`*`, `*::before`, `*::after`:
  `animation-duration: 0.01ms !important`,
  `animation-iteration-count: 1 !important`,
  `transition-duration: 0.01ms !important`). CSS-only. The rule is
  present in the built CSS
  (`out/_next/static/css/98aec009c4d7320d.css`).

Nothing else was touched. No i18n keys added (every fix reuses an
existing visible label). Brand orange untouched. §4 targets, advisory
lists and disputed D1–D6 untouched per the assignment.

Formatter note: the repo pre-commit hook reformatted three
never-formatted upstream lines in the files this delivery touched
(whitespace/line-breaks only, no semantic change): the connection-dot
`<span>` in `KdsHeader.tsx`, and the `KdsWorkspace` function signature
plus the `<KdsKanbanBoard … />` props. They are part of the fix
commit; the behaviour of those lines is unchanged.

## Local checks (base 1d0a3cb, then after the fixes — all green)

Baseline at base, then post-fix, same five commands:
`npm run lint`, `npm run test:lint-engine`, `npm run i18n:check`,
`npm run build`, `npm run build:frontend` — rc=0 for all five in both
runs. Post-fix lint: 1 warning, 0 errors (same as baseline). Logs:
`~/workspace/rest-cafe-docs/uiux-fixes-delivery1-2026-10-30/`
(`baseline-*.log`, `postfix-*.log`).

## Gate re-run (verbatim, affected screens, 1366x768)

Method: same as the 027 audit — app rebuilt from this branch, dev
server on :3001 with the isolated audit fixture DB, 8 snapshots
re-rendered (`snapshots-fixes-d1/`), kit gates run unmodified. One
environment repair was needed first: `/opt/google/chrome/chrome` was
missing, so the `verify_keyboard` / `verify_overflow` /
`verify_reduced_motion` scripts crashed on launch; Chrome 156
(`google-chrome-stable` 156.0.8078.79-1) was reinstalled from the
official .deb (environment only, no product code).

Axe (`axe_audit`, 8 snapshots):
- pos-ar: 1 violation, `color-contrast` node `.ms-1` only (U15, Delivery 2).
- pos-en: 1 violation, `color-contrast` 23 nodes only (Delivery 2
  contrast + locked brand). No `meta-viewport`, no `button-name`.
- kds-ar: 1 violation, `color-contrast` 3 nodes only: `.bg-brand`
  (locked brand), `.bg-green-50` (U13, Delivery 2), `.ltr-island >
  span` (U9, Delivery 2). No `aria-required-children`.
- settings-ar: EXIT=0. settings-en: 1 violation, `color-contrast`
  3 nodes only: sidebar active link (brand, locked), `.bg-brand/10`
  nav headings (brand 3.53, locked), `.ring-1 > span` (U8, Delivery
  2). No `label`, no `select-name`.
- settings-tax-ar: EXIT=0. settings-printers-ar: EXIT=0.
  tables-ar: EXIT=0.
- In short: every Delivery 1 axe finding (U1 meta-viewport, U2
  aria-required-children, U3 label, U4 select-name, U12 button-name)
  is gone from all 8 snapshots. Remaining axe violations are all
  contrast (Delivery 2) or locked brand.

Keyboard (`verify_keyboard`, kds-ar): EXIT=0 —
`verify_keyboard: OK: 1 file(s), 19 control(s) + 0 composite widget(s):
all reachable, Enter/Space and arrow keys answer`. The dead-arrows
finding is gone with the tablist.

Overflow (`verify_overflow`, @1366/@1920): tables-ar EXIT=0,
kds-ar EXIT=0, settings-ar EXIT=0. pos-ar EXIT=1 with one finding
only — the 1920px product-button / sound-banner overlap (26%/70%/
100%), which is the audit's disputed D4 (live measurement: 0
overlap at 1920x1080); out of scope per the assignment, no action.
The U10 sidebar-clip finding (`[A clipped] span.font-semibold`) is
gone from every screen.

Reduced motion (`verify_reduced_motion`): all three screens report
`[A no-policy]` only — the same known gate blind spot the audit
recorded as disputed D3: the gate greps the snapshot HTML for the
media-query text, but the policy lives in the external built CSS (see
above; the snapshot HTML contains no CSS text). The `[B not-reduced]`
finding is gone from all three screens.

## Live second measurement (10/10 PASS, `verify-fixes-d1.mjs`)

- U1: `meta="width=device-width, initial-scale=1"`.
- U2: `tablists=0`, switcher toggles `[{علامات التبويب, true},
  {كانبان, false}]`; ArrowRight leaves focus on the first toggle.
- U3: `business-name: labels=["اسم المنشأة"]`.
- U4: `billing-type: ["نوع الفوترة"]`, `tables-required:
  ["الطاولات مطلوبة"]`, `tax-registered: ["مسجل ضريبيًّا"]`,
  `invoice-reset-period: ["فترة إعادة تعيين التسلسل"]`, `language:
  ["اللغات"]`; printers tab `print-method: ["طريقة الطباعة"]
  value=escpos`.
- U12 (POS and KDS): banner present, `buttonRole=null`,
  `name="طلب جديد · طاولة T1"`, `wrapperRole="status"`.
- U10: brand span `scrollHeight=20 clientHeight=20 lineHeight=20px
  fontSize=14px`.
- U11: under emulated `prefers-reduced-motion: reduce`,
  `still-animating=0`, sidebar fixed `transition=1e-05s`.

Full logs: `~/workspace/rest-cafe-docs/uiux-fixes-delivery1-2026-10-30/`
(`render-fixes-d1.log`, `verify-fixes-d1.log`,
`verify-fixes-d1.json`) and
`~/workspace/rest-cafe-docs/uiux-audit-20261030/gates-fixes-d1/`.

## What is next

Please verify and land Delivery 1. Delivery 2 (contrast: U5–U9,
U13–U15) starts after this delivery lands.
