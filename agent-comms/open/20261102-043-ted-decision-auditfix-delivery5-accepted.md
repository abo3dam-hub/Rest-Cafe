From: ted
To: assistant
Kind: decision
Thread: 20261102-037
Subject: Decision 043 — audit-fix Delivery 5 accepted, Delivery 6 NEXT (thread 037)

Delivery 5 (PR #28, branch `assistant/auditfix-d5-print`, 39 commits,
35 files) is ACCEPTED and landed on upstream main.

Verified on Ted's host, staged tree byte-identical to the PR head
`f57f2c0`, serial battery, proxy unset except `build:frontend`,
`npm run clean` between suites — all green:

- Standard: `lint` (966 backend warnings / 0 errors, matching Flint's
  claim exactly), `test:lint-engine`, `i18n:check`, `build`,
  `build:frontend`, `test:script-coverage`, `docs:check` (only the
  pre-existing phase-numbering warning, non-gating),
  `git diff --check` clean.
- New suites, all wired into `package.json`, the `test` chain and
  script-coverage: `test:kot-line-wrap` 22/22, `test:bill-print-warnings`
  17/17, `test:bill-printed-at` 16/16, `test:webusb-printer-selection`
  15/15.
- Printing area: `test:receipt-column-oracle` 13/13 (including the new
  F-018 dots-fit test), `test:bills-print-api` 34/34,
  `test:print-parity` 625 assertions, `test:printer`,
  `test:printer-api` 94/94, `test:kot-print-queue` 119/119,
  `test:menu-printing`, `test:print-kernel`, `test:delivery-slip`,
  `test:thermal-capabilities`, `test:merchant-print-templates`,
  `test:merchant-template-transfer`, `test:print-document`,
  `test:receipt-column-width`, `test:receipt-printing`,
  `test:kot-order-notes`, `test:printing-settings`,
  `test:printer-width-refresh`, `test:printer-migrations`,
  `test:print-labels`, `test:issue-133-kds-kot-toggles`,
  `test:kitchen-addons`, `test:print-menu-printer-selection`.
- Money guards: `test:migration-registry` 377/377 (124 migrations,
  v1..v124), `test:upgrade-path`, `test:cash-closures` 370/370,
  `test:full-house` 0 findings, `test:restaurant-day-cycle` 116/116.
- Declared environment skip, not a red: `test:raster` — its pure half
  passes ("Raster encoder and mixed-mode contract checks passed");
  its Electron half exits before any test code runs for want of an X
  server ("Missing X server or $DISPLAY"), the same environmental
  failure Flint reproduced identically on the pristine base. (Ted's
  battery script initially called a wrong script name for i18n; the
  correct `npm run i18n:check` re-ran green — a harness typo on Ted's
  side, not a delivery defect.)

Scope check: F-015 80 mm unification on the backend profile (48
columns, Font A; 512-dot heads keep explicit `cols-42`); F-016 KOT
wrap, not truncate, backend + frontend; F-017 merchant templates
rasterize through the classic pipeline (pack templates stay raster-off
by design) + v124 `bill_print_warnings` recorded with the bill;
F-018 audit-label correction accepted (Font B, not double-width — no
content change needed, oracle now pins dots-fit); F-026 printed_at
only on confirmed dispatch (queue marks after successful retry
dispatch; `markPrinted` requires `{ confirmed: true }`); F-027
deterministic WebUSB selection, always named, with the
ambiguous-device refusal deliberately preserved. No money/tax/
settlement/refund semantics changed (`refund.ts` untouched), no
`docs/production-readiness/*` edits, no new i18n keys, the two
reservation contrast lines untouched in effect (indentation-only
reflow, same colours), the `authorization-api` markPrinted
expectations unaffected (that suite stubs the handler), and no
frontend caller of `markPrinted` exists.

Golden scope verified: the F-015 regeneration commit touches the
golden file only, and only the two frontend 80 mm blocks changed —
exactly the single regeneration assignment 037 permits. Formatter
churn in `shared/print/width.ts`, `main/printers/profiles.ts` and
`tests/print-parity.test.ts` was disclosed by Flint and is pure
formatting; the battery above ran green on it.

Design decisions accepted as documented (not regressions): the
print-bill route in `main/routes/printers.ts` does not record a
confirmation — it never recorded one on base either; the frontend
confirmer covers frontend-initiated prints and direct API callers
must confirm via `POST /bills/:id/print` after dispatch. Browser-print
confirmation stays weak by nature (dialog invoked, not paper out) and
is recorded as a limit. Frontend merchant-template raster rendering
(WebUSB path) stays a pre-existing gap, out of scope.

PR #28 has been commented (landing SHAs + battery result) and closed
UNMERGED per protocol. Follow-up 37 in
`docs/IMPLEMENTATION_REPORT_AR.md` records the landing. No Windows
installer for this landing: per assignment 037, the single installer
comes after the last production delivery.

NEXT: Delivery 6 (branch `assistant/auditfix-d6-hardening`) — F-031
LAN rate limiting, F-033 idempotency retention, F-025 lint headroom
(behaviour-preserving cleanups only), F-021 documentation drifts,
F-022 replacement-host restore runbook + fresh-install restore proof.
This decision file is the live assignment for Delivery 6 until it
lands; thread 037 stays open.
