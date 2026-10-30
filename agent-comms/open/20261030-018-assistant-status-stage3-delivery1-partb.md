From: assistant
To: ted
Kind: status
Thread: 20261030-018
Subject: Stage 3 Delivery 1 Part B — formatAmount evidence report (ZERO variants unify; complete as evidence)

## Verdict up front

Part B is complete as the evidence report alone: **zero of the five
`formatAmount` variants unify safely**. Each variant was compared
variant-by-variant against its unification target under the
receipt-column oracle, using the real encoder code (not re-implementations).
Two variants are proven different on the store's own default path (SYP);
one differs on a reachable option; one is already a pure delegate; one
moves with its Stage C seam. Per assignment 018, a variant that genuinely
differs stays as-is, documented with the evidence — that is a successful
outcome for that variant, not a failure. **No production code was changed
in this delivery** — the branch carries only the announce file and this
report. No golden was regenerated (forbidden in this stage).

Base head: upstream main beb33285ef7458257e01adbcae62e1e938fb477a (repair
landed). Branch: assistant/stage3-delivery1-partb-formatamount.
Note: upstream moved beb3328 -> ec1ac2d during this run (decision 022
accepting the repair + assignment 018 refresh + follow-up 21 report;
docs-only, 4 files, zero code). The branch base stands at beb3328; the
diff against current main is unaffected.

Physical-printer verification on the owner's machine remains outstanding
for every printing stage — nothing in this report claims it.

## 1. Stage 3 battery baseline (new base beb3328)

Run 2026-10-30 ~14:05–14:15 Asia/Damascus, serially, `npm run clean`
between suites, proxy unset except `build:frontend` (proxy on). Per-suite
logs are kept with the delivery record. Result: **29/30 green in the
plain run; 30/30 effective** (test:raster green under xvfb-run, as in
Part A).

| Suite | Result |
|---|---|
| lint | GREEN — backend 964 warnings / budget 1000, 0 errors; frontend 0/0 |
| test:lint-engine | GREEN |
| i18n:check | GREEN |
| build | GREEN |
| build:frontend | GREEN (proxy on) |
| test:receipt-column-oracle | GREEN — 12/12, golden byte-identical |
| test:bills-print-api | GREEN — 34/34 |
| test:printer | GREEN |
| test:printing-settings | GREEN |
| test:printer-api | GREEN |
| test:print-menu-printer-selection | GREEN — declared skip notice: raster-dependent assertions skipped off-Windows |
| test:printer-ipc | GREEN |
| test:receipt-printing | GREEN |
| test:receipt-settings-hydration | GREEN |
| test:print-parity | GREEN |
| test:merchant-print-templates | GREEN |
| test:print-document | GREEN |
| test:print-kernel | GREEN |
| test:thermal-capabilities | GREEN |
| test:raster | RED in plain run — ENVIRONMENTAL, same as Part A (no X server/DISPLAY); re-run under `xvfb-run -a` PASSES (rc 0) |
| test:receipt-column-width | GREEN |
| test:printer-width-refresh | GREEN |
| test:printer-migrations | GREEN |
| test:issue-printing-and-kds-resilience | GREEN |
| test:issue-266-currency-symbol-print | GREEN |
| test:menu-printing | GREEN — 10/10 at this base (the repair landed; was 9/10 at the Part A base) |
| test:print-labels | GREEN |
| test:migration-registry | GREEN — 371/371 (122 migrations, v1..v122) |
| test:backup | GREEN |
| test:e2e-syria-default | GREEN |

No new red vs the Part A baseline; the one Part A red (menu-printing)
is fixed at this base by the landed repair. The oracle is byte-identical.

## 2. Method

Line numbers below are from base beb3328 (unchanged from Part A).
Each variant's body was read in full, its call sites enumerated by grep,
and the decisive comparisons were executed through the real code: a
temporary ts-node probe (tests/tmp-partb-probe.test.ts, run then deleted,
never committed) that builds one bill (SYP and USD tenants, amount
10,000) and renders it through `buildClassicReceiptBytes` (V2),
`buildTaxBillBytes` (V3, rawEscPos: true) and `generateBillHtml` (V4,
trimDecimals false/true). Its output is saved with the delivery record
(`stage3-delivery1-partb-2026-10-30/probe/real-code-probe-output.txt`).
A standalone Intl probe was superseded by the real-code probe and removed.

## 3. Per-variant findings

### V1 — thermal.ts:3117 — STAYS (moves with Stage C seam 5)

Input is integer minor units (cents); `centsToAmount` divides by
10^fractionDigits (thermal.ts:3116); delegates to `formatCurrency`
(formatting-helpers.ts:255) with the resolved symbol prefix. Only use
site is `buildZReportBody` (11 call sites, every argument a `.cents`
field). It is the only cents-converting variant and the only one in
`main/`. It must move with its use site in Stage C seam 5
(document-z-report), not be unified here. No unification target exists
in its domain.

### V2 vs V3 — PROVEN DIFFERENT on the default SYP path — both STAY

- V2 (frontend/src/lib/printer/receipt-encoder.ts:1804):
  `formatAmount(value, currency, locale, trimDecimals = false,
  fractionDigits = 2)`. Fraction digits come from the parameter; all
  three builders compute it as `getCurrencyFractionDigits(currencyCode)`
  (receipt-encoder.ts:534, :1059, detailed builder) and all 34 call
  sites pass it. Forces `-u-nu-latn` internally via `getSafeLatnLocale`
  (:331). Always strips NBSP/narrow NBSP. Prefix-style
  `${currency}${formattedNum}`.
- V3 (frontend/src/lib/printer/tax-bill-encoder.ts:719):
  `formatAmount(value, currency, locale, trimDecimals = false,
  rawEscPos = true)`. Fraction digits are derived INSIDE — from the
  `currency` argument, which is the resolved display prefix, NOT the
  currency code. The 5th parameter is `rawEscPos`, not fraction digits.
  Uses the locale as passed; the caller pre-forces it
  (`amountLocale = rawEscPos ? getSafeLatnLocale(locale) : locale`,
  tax-bill-encoder.ts:238). NBSP stripped only when rawEscPos is true.
  `getSafeLatnLocale` is byte-identical in both files.

Real-code probe, same bill, amount 10,000, SYP tenant, same prefix:

| Renderer | Output |
|---|---|
| V2 classic receipt | `GBP10,000` |
| V3 tax bill | `GBP10,000.00` |

Root cause: the SYP prefix resolves to `GBP` on the thermal path
(`getCurrencySymbol('SYP')` = `£`; `normalizeCurrencyToAscii('£')` =
`GBP` per shared/print/currency.ts:12; ASCII fallback wins when
useUnicode is false). V2 takes its digits from the code —
`getCurrencyFractionDigits('SYP')` = 0 — while V3 takes its digits from
the prefix — `getCurrencyFractionDigits('GBP')` = 2. USD agrees
(`$10,000.00` on both) only because both paths yield 2 digits there;
agreement on one currency does not make the semantics identical.
COP diverges the same way (V2: 0 via the COP special case in
getCurrencyFractionDigits; V3: 2 via the `$` prefix fallback), as does
SYP/JPY whenever useUnicode is true. No caller in the repo passes
`rawEscPos: false` (production usePrinter.ts:630 passes true; the
default is true), but `rawEscPos: false` is a documented public option
(`TaxBillOptions`, "false preserves locale formatting"), so V3's
contract differs from V2's even where current callers coincide.

Unifying V2 and V3 would change printed bytes on the SYP tax bill
(`10,000` vs `10,000.00`) — forbidden. Both stay as-is.

Finding for Ted (not fixed here — Part B makes no behavior changes):
V3 deriving fraction digits from the display prefix instead of the
currency code looks like a latent quirk: the tax bill prints SYP
amounts with two decimals while the classic receipt prints whole
units, for the same bill. Whether that is intended or a fix for a
later stage is Ted's call.

### V4 — web-print.ts:601 — STAYS (differs from formatMoney on a reachable option)

`formatAmount(value, tenant, trimDecimals = false)`. Currency-derived
fraction digits (:604). Otherwise delegates to
`formatCurrencyForTenant` → `formatMoney` (countries.ts:592, 472) —
except for its own trimDecimals branch (:612–627: `Intl.NumberFormat`
with minimum/maximumFractionDigits 0), which runs when
`trimDecimals && !hasDecimals && !isToman`. That branch is reachable
in production (`printerTrimDecimals` flows from usePrinter into
`generateBillHtml`).

Real-code probe, USD tenant, amount 10,000:

| Path | Output |
|---|---|
| V4 trimDecimals=false (formatMoney) | `$10,000.00` |
| V4 trimDecimals=true (trim branch) | `$10,000` |

The trim branch is load-bearing for any currency with fraction digits
(USD is a supported store currency); replacing V4 with a plain
`formatMoney` delegate would change those bytes. SYP coincides (both
whole units). V4 also resolves its symbol differently from V2/V3: the
browser-HTML path prints `£10,000` (Intl narrow symbol via
formatMoney) where the thermal paths print `GBP10,000` (ESC/POS ASCII
fallback) — a second, independent semantic difference. The Toman
handling itself already lives inside `formatMoney`; V4's own Toman
branch is only the guard that skips the trim path. Stays as-is.

### V5 — main/printers/document-delivery-slip.ts:168 — STAYS (already a pure delegate)

`formatAmount` is a 4-line adapter that calls `formatMoney(amount,
String(options.currency ?? ''), options.locale ?? 'en-US', {
currencyDisplay, digits })` — all semantics (including the Toman
÷10 and the IRR 0-fraction-digits rule) already come from
`formatMoney`. There is nothing to unify it into; it is already
unified in effect. 2 call sites (:176, :177). Stays as-is.

## 4. What is next

Delivery 1 is complete with this report (Part A classification + this
Part B evidence report; zero production files changed across Part B).
Delivery 2 (Stage C seams 1–3: escpos-preview, windows-print,
print-transport) starts when Ted lands this delivery and refreshes
assignment 018. Physical-printer verification on the owner's machine
remains outstanding for every printing stage — not claimed here.
