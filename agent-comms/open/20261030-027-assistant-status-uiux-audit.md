From: assistant
To: ted
Kind: status
Thread: 20261030-027
Subject: UI/UX audit report — POS, tables, KDS, settings (REPORT ONLY, no fixes)

## 0. What this is

Report-only UI/UX + accessibility audit of the running Rest&Cafe app,
assignment 027. ZERO production changes: no code, config, test, golden, or
docs edits. No fixes. Fix ideas live in §7 as recommendations, each marked
NOT DONE. The kit is a measurement instrument only, never an unquestioned
pass/fail authority: every defect claim below carries its screen, gate name,
verbatim measured output, the element (visible label and file:line where
known), the snapshot method, and a confidence of
`verified-by-second-measurement` or `gate-only`. Where a gate and a direct
live measurement disagree, both are reported and the claim is marked
DISPUTED. Brand orange is a LOCKED decision: its contrast numbers are
reported as measurements only, never as numbered defects.

## 1. Environment

- Upstream head measured: `6ed628a8de7de635f0083a3aedb95c02591efef5`
  (commit "docs(agent-comms): assignment 027 — report-only UI/UX audit
  (owner-authorized)").
- Kit: `plugin87/ux-ui-agent-skills`, v3.0.0, commit `def84a70`,
  cloned outside the repo. No kit files committed here.
- Browsers: kit Playwright 1.63.0 bundled Chromium (`chromium-1243`) for
  renders and all live second measurements; Google Chrome stable
  (`/opt/google/chrome`) for the five re-run gate families (see below).
- App: built from the head (`build:frontend` + `npm run build`, both exit
  0); dev server `http://127.0.0.1:3001` with isolated appdata. Seeded
  through the real setup wizard in the production Syrian shape: ar,
  SYP / symbol SP, Asia/Damascus, finedine + demo (4 categories,
  8 products, 4 tables). Live dine-in order `ORD-20261030-0001` on T1
  (3 items) created for KDS / tables / POS content.
- Snapshots: 24 captures — POS / tables / KDS / settings / settings-tax
  in ar; POS / settings / settings-tax in en; at 1366x768, 1920x1080,
  and 1366x768 @125% display scale. Snapshot method per screen: rendered
  in real Chromium, saved as static DOM + CSS via `<base>`, app scripts
  stripped; gates measure the captured DOM. Language was restored to ar
  after the EN captures.
- Gates: 88 invocations, 0 SKIPPED, every log ends with an `EXIT=` line.
  Kit convention: exit 1 = findings found, exit 0 = pass. First pass:
  `axe_audit` and `verify_states` ran (16 logs, real results); the other
  five families crashed on `browserType.launch: Chromium distribution
  'chrome' is not found at /opt/google/chrome/chrome` (the scripts launch
  `channel: 'chrome'`). After Chrome was confirmed present, all five
  families were re-run to completion (72 invocations); one invocation
  (`verify_responsive` settings-ar scale125) died mid-run with
  `browser.newPage: Target page, context or browser has been closed`
  during a parallel run and was re-run singly: `EXIT=0`.
- Second measurements: three live Playwright rounds against the running
  app (not snapshots): computed styles with OKLCH→sRGB conversion
  (Tailwind v4 emits `oklch()` in computed styles), effective-background
  walk up the ancestor chain, leaf-first text matching (falls back to the
  shortest containing element for labels split across spans). Language
  was switched to en for two checks and restored to ar each time.

## 2. Per-screen gate table

Counts are verbatim gate output. "fails" = gate exit 1 with findings.

| Screen | axe (WCAG 2.2 A/AA) | states (contrast) | target size | keyboard | overflow | responsive | reduced motion |
|---|---|---|---|---|---|---|---|
| POS ar 1366x768 | 3 violations | 18 fail / 183 checked | 116 targets @1366/1920, all >= 24x24 (EXIT=0) | pass (EXIT=0) | FAIL (see §3 U10, §5 D4) | pass (EXIT=0) | FAIL (see §3 U11, §5 D5) |
| POS en 1366x768 | 3 violations | 18 fail / 183 checked | 116 targets, all >= 24x24 (EXIT=0) | pass (EXIT=0) | FAIL (same as POS ar) | pass (EXIT=0) | FAIL (same) |
| Tables ar 1366x768 | 1 violation | 30 fail / 143 checked | 82 targets @1366/1920, all >= 24x24 (EXIT=0) | pass (EXIT=0) | FAIL (see §3 U10) | pass (EXIT=0) | FAIL (see §3 U11) |
| KDS ar 1366x768 | 4 violations | 5 fail / 65 checked | 40 targets @1366/1920, all >= 24x24 (EXIT=0) | FAIL (see §3 U2) | FAIL (see §3 U10) | pass (EXIT=0) | FAIL (see §3 U11) |
| Settings ar 1366x768 | 3 violations | 3 fail / 174 checked | 102 targets @1366/1920, all >= 24x24 (EXIT=0) | pass (EXIT=0) | FAIL (see §3 U10) | pass (EXIT=0) | FAIL (see §3 U11) |
| Settings en 1366x768 | 4 violations | 3 fail / 174 checked | 102 targets, all >= 24x24 (EXIT=0) | pass (EXIT=0) | FAIL (see §3 U10) | pass (EXIT=0) | FAIL (see §3 U11) |
| Settings-tax ar 1366x768 | 1 violation | 7 fail / 142 checked | 76 targets @1366/1920, all >= 24x24 (EXIT=0) | pass (EXIT=0) | FAIL (see §3 U10) | pass (EXIT=0) | FAIL (see §3 U11) |
| Settings-tax en 1366x768 | 2 violations | 7 fail / 142 checked | 76 targets, all >= 24x24 (EXIT=0) | pass (EXIT=0) | FAIL (see §3 U10) | pass (EXIT=0) | FAIL (see §3 U11) |

Width-faithful 1920 runs (overflow / target size / responsive on the
1920 captures): target size all pass (POS 58, tables 41, KDS 20,
settings 51, settings-tax 38 targets @1920px); overflow same findings
as the 1366 runs plus the POS 1920 overlap (§5 D4); responsive 23/24
pass, 1 inconclusive (§5 D6).

Axe violation detail (verbatim, per snapshot):
- POS ar: `CRITICAL button-name .top-4`; `SERIOUS color-contrast .ms-1`;
  `CRITICAL meta-viewport meta[name="viewport"]`.
- POS en: `CRITICAL button-name .top-4`;
  `SERIOUS color-contrast` 23 nodes (`a[data-active="true"] > span:nth-child(2)`,
  `.max-w-[140px]`, `button[title="All"]`, …);
  `CRITICAL meta-viewport`.
- Tables ar: `CRITICAL meta-viewport` only.
- KDS ar: `CRITICAL aria-required-children .p-0.5`;
  `CRITICAL button-name .top-4`;
  `SERIOUS color-contrast` 3 nodes (`.top-4`, `.bg-green-50`,
  `.ltr-island[dir="ltr"] > span`); `CRITICAL meta-viewport`.
- Settings ar: `CRITICAL label input[value="مطعم التدقيق"]`;
  `CRITICAL meta-viewport`; `CRITICAL select-name` 5 nodes.
- Settings en: `SERIOUS color-contrast` 3 nodes
  (`a[data-active="true"] > span:nth-child(2)`,
  `.bg-brand\/10 > .truncate.min-w-0`, `.ring-1 > span`);
  `CRITICAL label`; `CRITICAL meta-viewport`;
  `CRITICAL select-name` 5 nodes.
- Settings-tax ar: `CRITICAL meta-viewport` only.
- Settings-tax en: `SERIOUS color-contrast` 5 nodes
  (`a[data-active="true"] > span:nth-child(2)`,
  `.bg-brand\/10 > .truncate.min-w-0`,
  `.disabled\:opacity-40.hover\:text-foreground.py-1\.5:nth-child(2)`, …);
  `CRITICAL meta-viewport`.

## 3. Defects

### U1 — Zooming and scaling disabled app-wide (meta-viewport)
- Screen: all (every snapshot). Gate: `axe_audit`, CRITICAL.
- Verbatim gate output: `CRITICAL meta-viewport: Zooming and scaling must
  not be disabled (1 node) meta[name="viewport"]` — on all 8 snapshots.
- Element: `<meta name="viewport">`. File:line:
  `frontend/src/app/layout.tsx:45-51`:
  `export const viewport: Viewport = { themeColor: '#3248FF',
  width: 'device-width', initialScale: 1, maximumScale: 1,
  userScalable: false }`.
- Snapshot method: axe on the 8 static snapshots; live DOM on POS
  confirms `metaViewport: "width=device-width, initial-scale=1,
  maximum-scale=1, user-scalable=no"`.
- Confidence: `verified-by-second-measurement` (live DOM + source).

### U2 — KDS view switcher is a fake tablist; arrow keys do nothing
- Screen: KDS ar. Gates: `axe_audit` (CRITICAL aria-required-children)
  + `verify_keyboard` (FAIL WCAG 2.1.1 Keyboard).
- Verbatim gate output (axe): `CRITICAL aria-required-children: Certain
  ARIA roles must contain particular children (1 node) .p-0\.5`.
  Verbatim gate output (keyboard):
  `verify_keyboard: FAIL: WCAG 2.1.1 Keyboard` /
  `x kds-ar-1366x768.html [D dead-arrows] div.flex "علامات التبويبكانبان"
  (tablist) uses roving tabindex but ArrowDown/ArrowRight never move focus`.
- Element: the KDS view switcher ("علامات التبويب" / "كانبان" toggle).
  File:line: `frontend/src/components/kds/KdsHeader.tsx:65`:
  `<div className="flex items-center bg-muted rounded-lg p-0.5 ms-2"
  role="tablist">`.
- Live second measurement: the element is `DIV role="tablist"` with
  children `[BUTTON, BUTTON]` — no `role="tab"` on either child; the
  buttons use `aria-pressed` (toggles), not tabs. A tablist must own
  `tab` elements; a toggle pair must not carry `role="tablist"`.
- Snapshot method: axe + keyboard gates on the KDS ar snapshot; live DOM
  on `/kds`.
- Confidence: `verified-by-second-measurement`.

### U3 — Settings business-name input has no accessible name
- Screen: Settings ar + en. Gate: `axe_audit`, CRITICAL label.
- Verbatim gate output: `CRITICAL label: Form elements must have labels
  (1 node) input[value="مطعم التدقيق"]` — on both ar and en snapshots.
- Element: the business-name text input, current value "مطعم التدقيق"
  (`frontend/src/components/settings/GeneralSettingsTab.tsx` area).
- Live second measurement: `INPUT type=text, id: null, value: "مطعم التدقيق",
  ariaLabel: null, ariaLabelledBy: null, labels: [], title: null,
  placeholder: null` — no programmatic label of any kind. (A sighted
  user sees nearby heading text; a screen reader gets nothing.)
- Snapshot method: axe on the settings snapshots; live DOM on `/settings`.
- Confidence: `verified-by-second-measurement`.

### U4 — Five visible selects in Settings have no accessible name
- Screen: Settings ar + en. Gate: `axe_audit`, CRITICAL select-name.
- Verbatim gate output: `CRITICAL select-name: Select element must have
  an accessible name (5 nodes)` — on both ar and en snapshots.
- Elements (live, all visible on the default Settings tab):
  - billing type, current value `postpaid` — visible label nearby:
    "نوع الفوترة";
  - tables required, current value `yes` — visible label: "الطاولات مطلوبة";
  - tax registered, current value `no` — visible label: "مسجل ضريبيًّا";
  - sequence-reset period, current value `daily` — visible label:
    "فترة إعادة تعيين التسلسل";
  - language, current value `ar` — no adjacent visible label found.
  Each has `aria-label: null`, `aria-labelledby: null`, `labels: []`,
  `title: null`. The visible label texts above exist as headings, but
  are not programmatically associated.
- Live second measurement: 14 selects on the page, 8 named, 6 unnamed;
  5 of the unnamed are visible (the five above); the 6th (printer type,
  value `escpos`) is `visible: false` (rect 0x0) on the default tab, so
  axe does not count it — this reconciles axe's 5 with the live 6. The
  hidden printer select will be unlabelled when its section is shown;
  see §6.
- Snapshot method: axe on the settings snapshots; live DOM on `/settings`.
- Confidence: `verified-by-second-measurement`.

### U5 — "No Printer" / "لا توجد طابعة" grey text at 2.56:1
- Screen: POS ar + en. Gates: `axe_audit` (SERIOUS color-contrast,
  node `.ms-1` / `.max-w-[140px]`) + `verify_states`.
- Verbatim gate output: `x default "لا توجد طابعة" 2.56:1 (need 3)
  [rgb(153,161,175) on rgb(255,253,251)]` (and the same for
  `"No Printer"` in en).
- Element: the printer-status span, `SPAN.hidden.sm:inline.text-xs.
  font-medium.truncate.max-w-[140px]`, 12px / font-weight 500.
- Live second measurement (leaf-first): color `oklch(0.707 0.022
  261.325)`, background `rgb(255,253,251)`, ratio **2.56** — identical
  to the gate, ar and en. Fails 4.5:1 for text (and the gate's 3:1 bar).
- Snapshot method: axe + states on the POS snapshots; live DOM on `/pos`.
- Confidence: `verified-by-second-measurement`.

### U6 — "حجز" (Reserve) amber text at 2.95:1, three instances
- Screen: Tables ar. Gate: `verify_states`.
- Verbatim gate output: `x default "حجز" 2.94:1 (need 4.5)
  [rgb(208,135,0) on rgb(255,255,255)]` (repeated for default/focus).
- Element: the Reserve button on each table card,
  `BUTTON.text-xs.text-yellow-600`, 12px / 500.
- Live second measurement: three "حجز" buttons, all color
  `oklch(0.681 0.162 75.834)` on white, ratio **2.95** each.
- Snapshot method: states gate on the tables ar snapshot; live DOM on
  `/tables`.
- Confidence: `verified-by-second-measurement`.

### U7 — "إلغاء التنشيط" (Deactivate) red text at 3.82:1
- Screen: Tables ar. Gate: `verify_states`.
- Verbatim gate output: `x default "إلغاء التنشيط" 3.81:1 (need 4.5)
  [rgb(251,44,54) on rgb(255,255,255)]`.
- Element: the Deactivate button,
  `BUTTON.text-xs.text-red-500.hover:text-red-700`, 12px / 500.
- Live second measurement: color `oklch(0.637 0.237 25.331)` on white,
  ratio **3.82**.
- Snapshot method: states gate on the tables ar snapshot; live DOM on
  `/tables`.
- Confidence: `verified-by-second-measurement`.

### U8 — Muted-foreground text at 4.34:1 (just under 4.5), one token, many surfaces
- Screens: KDS, Tables, Settings-tax, POS. Gate: `verify_states`.
- Verbatim gate output (samples):
  `x default "كانبان" 4.35:1 (need 4.5) [rgb(115,115,115) on rgb(245,245,245)]`;
  `x default "مخطط الصالة" 4.35:1 (need 4.5) [rgb(115,115,115) on rgb(245,245,245)]`;
  `x default "معدلات الضرائب الي" 4.35:1 (need 4.5) [rgb(115,115,115) on rgb(245,245,245)]`;
  `x default "سفري" 4.35:1 (need 4.5) [rgb(115,115,115) on rgb(245,245,245)]`.
- Elements: the `text-muted-foreground` token (`oklch(0.556 0 0)` on
  `rgb(245,245,245)`), 12–14px / 500.
- Live second measurement, all **4.34**: KDS "كانبان" (BUTTON);
  Tables "مخطط الصالة" (BUTTON); Settings-tax "معدلات الضرائب اليدوية"
  (BUTTON) and "رسم الإنفاق الاستهلاكي" (BUTTON). Same token also
  covers the gate's "جميع الصالات" / "إضافة صالة" (tables),
  "سفري" / "توصيل" / "Takeaway" / "Delivery" (POS) and
  "Manual Tax Rates" / "Consumption Fee" (settings-tax en) — gate-only
  for those instances, same token.
- Snapshot method: states gate on the snapshots; live DOM on
  `/kds`, `/tables`, `/settings?tab=tax`.
- Confidence: `verified-by-second-measurement` (four surfaces);
  `gate-only` for the remaining same-token instances.

### U9 — KDS elapsed-time readout at 2.60:1
- Screen: KDS ar. Gate: `axe_audit` (SERIOUS color-contrast, node
  `.ltr-island[dir="ltr"] > span`).
- Element: the order elapsed timer, e.g. SPAN text `"1:08:32"`,
  14px / 400, inside `.ltr-island`.
- Live second measurement: color `oklch(0.707 0.022 261.325)` (the same
  grey as U5) on white, ratio **2.60**.
- Snapshot method: axe on the KDS ar snapshot; live DOM on `/kds`.
- Confidence: `verified-by-second-measurement`.

### U10 — Sidebar brand name clipped 2px vertically, app-wide
- Screens: all (same sidebar on every screen). Gate: `verify_overflow`.
- Verbatim gate output: `x pos-ar-1366x768.html @1366px [A clipped]
  span.font-semibold "مطعم التدقيق": 2px of text cut off vertically`
  (same finding on all 16 overflow runs; KDS reads `"Rest&Cafe"`).
- Element: the sidebar brand span. File:line:
  `frontend/src/components/layout/Sidebar.tsx:228`:
  `<span className="font-semibold truncate">`.
- Live second measurement: `scrollHeight: 16, clientHeight: 14,
  offsetHeight: 14, lineHeight: 14px, fontSize: 14px, overflow: hidden`
  → clipped **2px**, exactly as the gate said. The 14px line-height
  equals the 14px font size, so Arabic descenders are cut.
- Snapshot method: overflow gate on all snapshots; live DOM on `/pos`.
- Confidence: `verified-by-second-measurement`.

### U11 — Reduced-motion policy exists but is narrow; UI transitions still run under reduce
- Screens: all (global CSS). Gate: `verify_reduced_motion`.
- Verbatim gate output: `x pos-ar-1366x768.html [B not-reduced]
  27 element(s) still animate under reduce` (per screen: POS 27,
  settings 20, settings-tax 18, KDS 15, tables 23) /
  `[5] div.fixed "مطعم التدقيقلوحة التحكمالتقاري": transition
  inset-inline-start, inset-inline-end, width 0.2s` /
  `[10] a.peer/menu-button "مطعم التدقيق": transition width, height,
  padding 0.15s`.
- The gate's companion claim "[A no-policy] page animates but has no
  @media (prefers-reduced-motion: reduce)" is FALSE — see §5 D5. What
  stands: the policy at `frontend/src/app/globals.css:557` only disables
  `.animate-shake`, `.animate-shake-centered` (and `.shimmer` in the
  built CSS); the 0.15–0.2s sidebar/menu transitions are not covered.
  Severity is low: these are short UI transitions, not auto-playing
  animation; no content depends on animation to appear.
- Snapshot method: reduced-motion gate on the 8 snapshots; source + built
  CSS read directly (`globals.css:557`, built
  `out/_next/static/css/bf08f2f0ac659a1b.css`).
- Confidence: `verified-by-second-measurement` for the narrow-policy fact;
  `gate-only` for the per-screen element counts.

## 4. Advisory list — interactive targets 24–44px (operational screens)

No target under 24px exists anywhere (WCAG 2.5.8 minimum): all 16
`verify_target_size` runs pass, e.g. `verify_target_size: OK: 1 file(s),
116 targets @1366/1920px, all >= 24x24 or exception-covered` (POS ar).
The items below are 24–44px, live-measured at 1366x768, listed so the
owner can judge them for a cashier in a rush. Heights are the short side.

- POS (35 items): 12 sidebar nav links 183x32 (لوحة التحكم، التقارير،
  نقطة البيع، الطلبات، الأصناف، العملاء، المخزون، المصروفات، المطبخ،
  الموظفون، الطاولات، الإعدادات); size buttons صغير 44x27 / متوسط 53x27 /
  كبير 37x27; category pills 56x36–122x38 (الكل، الأطباق الرئيسية،
  الحلويات، المشروبات، المقبلات); sound-enable button 299x38; new-order
  toast 176x36; "الصوت يعمل" 94x27; printer button "لا توجد طابعة"
  128x40; search input 208x40; "عدد الأشخاص" 48x24; close 24x24;
  "التشخيص والسجلات" 122x24; "طباعة تجريبية" 119x36; "اختر طاولة F2"
  133x38; "اتمام الطلب" 286x40; theme "السمة النظام" 183x32; owner
  "علي المالك" 183x36; sold-out badge 28x28; unnamed search input 766x38.
- Tables (26 items): the same 12 sidebar nav links 183x32; "إضافة صالة"
  107x34; "إضافة طاولة" 120x36; "إضافة جماعية" 129x36; "جميع الصالات(4)"
  123x34; "غير مخصص(4)" 113x34; "مخطط الصالة" 118x32; "قائمة" 74x32;
  "طلب توصيل جديد" 134x36; "طلب سفري جديد" 130x36; "طباعة تجريبية"
  119x36; close 24x24; "التشخيص والسجلات" 122x24; theme 183x32; owner
  183x36.
- KDS (11 items): theme "السمة النظام" 183x32; user "المستخدم" 183x36;
  status pills "قيد الانتظار3" 121x32 / "قيد التحضير0" 127x32 /
  "جاهز0" 92x32 / "تم التسليم0" 122x32 / "ملغى0" 94x32; new-order toast
  176x36; sound-enable button 1134x38; close 24x24; "التشخيص والسجلات"
  122x24.

## 5. Disputed / likely-false-positive list

- D1 — axe `button-name` on `.top-4` (POS ar/en, KDS ar). Gate:
  `CRITICAL button-name: Buttons must have discernible text (1 node)
  .top-4`. Live: the element is the new-order toast button,
  `BUTTON.fixed.top-4… role="status"`, with visible text
  "طلب جديد · طاولة T1" — `textContent` and `innerText` both return the
  full label; only the bell SVG icon is `aria-hidden`. Files:
  `frontend/src/components/pos/PosOrderAlertBanners.tsx:38`,
  `frontend/src/components/kds/KdsWorkspace.tsx:70`. The toast is
  transient (a `role="status"` live region that appears and dismisses),
  which is the likely reason the snapshot and the live app disagree.
  DISPUTED — do not fix on the gate alone.
- D2 — states-gate 1.00:1 on the settings nav headings. Gate:
  `x default "تفاصيل المطعم" 1.00:1 (need 3) [rgb(232,89,12) on
  rgb(232,89,12)]` (same for "Store Details", "إعدادات الضرائب",
  "Tax Config"). Live: the element is a nav BUTTON with
  `bg-brand/10` (brand at 10% opacity) and brand-orange text; measured
  against the effective page background `rgb(255,253,251)` the ratio is
  **3.53:1** (14px / 600, ar and en). The gate read the translucent tint
  as solid brand. Corrected to 3.53:1 — still below 4.5:1, but the
  combination is brand orange, i.e. locked (see §6), so it is a
  measurement, not a defect.
- D3 — axe `color-contrast` node `.bg-green-50` (KDS ar). Live: the only
  element with that class carrying text is the "جاهز0" (Ready) button,
  text-green-700 on `rgb(240,253,244)`, ratio **4.76:1** — a pass.
  DISPUTED.
- D4 — overflow-gate 1920px product-button overlap (POS ar/en). Gate:
  `x pos-ar-1366x768.html @1920px [B overlap] button.w-full
  "مشمشاوي مشكلة£220" overlaps button.fixed "اضغط هنا لتفعيل صوت تنبيه "
  by 70%` (also 26% "صوصودا الليمون£70", 100% "رزرز بشعيرية£150").
  Live at 1920x1080: the fixed sound button
  ("اضغط هنا لتفعيل صوت تنبيه الطلبات الجديدة", rect x811 y1022 w299
  h38, visible) overlaps **0** product buttons. The static snapshot
  lays the fixed button out differently from the live scrolling grid.
  DISPUTED.
- D5 — reduced-motion "[A no-policy]" (all 8 screens). Gate:
  `x pos-ar-1366x768.html [A no-policy] page animates but has no @media
  (prefers-reduced-motion: reduce)`. False: the policy exists at
  `frontend/src/app/globals.css:557` and in the built CSS
  (`out/_next/static/css/bf08f2f0ac659a1b.css`). What is true is §3 U11
  (the policy is narrow).
- D6 — responsive `settings-en-1366x768-scale125` "folded". Gate:
  `verify_responsive: FAIL (1366/1920px @ 1.25x root font)` /
  `x settings-en-1366x768.html folded: the flat layout differs between
  two identical loads, so whether the page answers the fold could not be
  judged`. The gate itself could not judge: NOT MEASURED for that
  invocation, not a defect. (All other 23 responsive runs pass,
  including the 125% runs; the fold check at 951px concerns a phone
  hinge, not this Windows desktop app.)

## 6. Locked-decision measurements (numbers only, NOT defects)

Brand orange `rgb(232,89,12)` is a locked decision, so the combinations
below are measured and reported, not numbered as defects. All ratios
verified live:

- White text on brand orange, 3.58:1 — active category pill "الكل" /
  "All" (14px/500); size "كبير" / "Large" (11px/500); new-order toast
  "طلب جديد · طاولة T1" (14px/600).
- Brand-orange text on white, 3.58:1 — "في المطعم" / "Dine in" (12px/500);
  "عرض الطلب" / "نقل الطاولة" / "تعيين كمتوفرة" (12px/500, tables).
- Brand-orange nav text on `bg-brand/10`, 3.53:1 — "تفاصيل المطعم" /
  "Store Details" and "إعدادات الضرائب" / "Tax Config" (14px/600).
- The POS-en axe listing of 23 contrast nodes is the same family
  (active pills, active nav, No Printer) — the non-brand member
  ("No Printer", 2.56:1) is defect U5.

## 7. Subjective observations (opinions, not gate results)

1. (Subjective) The sound-enable prompt is a wide fixed button pinned
   to the bottom centre; it reads as a banner, not a control. Its fixed
   placement is what produced the (disputed) overlap reading — a
   dismissible inline placement would end the question.
2. (Subjective) The KDS view switcher looks like tabs but behaves like
   toggles; the control should pick one pattern (see U2).
3. (Subjective) Settings packs 14 selects on one page. The visible
   headings already describe them; only the programmatic association
   is missing (see U4).
4. (Subjective) The 2px brand clip is invisible at a glance; it only
   shows because the sidebar's 14px line-height equals its font size
   (see U10).

## 8. Recommendations (each NOT DONE, ordered by impact on a cashier/waiter during service)

1. Restore pinch-zoom (remove `maximum-scale: 1, user-scalable: no`
   from the viewport) — U1. NOT DONE.
2. Fix the KDS view switcher: either a real tab pattern with arrow-key
   navigation, or drop `role="tablist"` and keep plain toggle buttons —
   U2. NOT DONE.
3. Associate labels with the Settings business-name input and the five
   visible selects (label `for`/`id` or `aria-label`) — U3, U4. NOT DONE.
4. Darken the failing non-brand text to >= 4.5:1: "No Printer" grey
   (2.56), "حجز" amber (2.95), "إلغاء التنشيط" red (3.82), the
   muted-foreground token (4.34), the KDS timer grey (2.60) — U5–U9.
   Brand orange is untouched (locked). NOT DONE.
5. Give the sidebar brand span room (line-height above the 14px font
   size) so the 2px clip disappears — U10. NOT DONE.
6. Widen the reduced-motion policy to cover the sidebar/menu transitions
   (0.15–0.2s), not just shake/shimmer — U11. NOT DONE.
7. Re-verify the disputed items (toast button-name D1, 1920 overlap D4)
   before acting on them; do not fix on the gate alone. NOT DONE.

## 9. Method notes and limits

- No screen failed to render in this environment. All 8 snapshot sets
  were captured and gated; nothing was substituted with static-code
  guesses. `accuracy_report.mjs` was not run (kit self-test, per the
  assignment).
- Snapshot gates can disagree with the live app (see §5): every
  defect above U1–U11 was second-measured live except the same-token
  instances of U8, which are marked `gate-only`.
- Out of scope, not reported as defects: kit house rules (no-emoji ban,
  native `<select>` ban, mobile-first gate, dark-mode checks via the
  kit's `data-theme` convention, em-dash / "AI tell" copy checks,
  token/hardcode lints, one-accent-colour and other taste rules) and
  locked product decisions (ar/en only, SYP/USD only, DD/MM/YYYY
  Gregorian dates, hall «صالة» terminology, brand orange + Al Malaki
  logo + "Powered by Ali.J" footer, Syria-only visible identity,
  hidden-but-present features).
- Honest limits: this audit ran in Linux Chromium/Chrome, not on the
  Windows desktop the app ships on, and not on a physical touch screen;
  the 125% display-scale runs are emulated (`deviceScaleFactor: 1.25`
  / `--scale=1.25`), not a real Windows 125% display. Touch-target
  findings are therefore about size only, not about real touch feel.
