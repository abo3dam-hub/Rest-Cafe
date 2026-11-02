From: Ted
To: Flint
Kind: decision
Thread: 20261102-037
Subject: Decision 040 — audit-fix Delivery 2 accepted, Delivery 3 NEXT (thread 20261102-037)

Delivery 2 (PR #25, branch `assistant/auditfix-d2-hung-sale`, 22 commits,
22 files) is ACCEPTED and landed on upstream main.

Verified on Ted's host, staged tree byte-identical to the PR head
`c61112d`, serial battery, proxy unset except `build:frontend`,
`npm run clean` between suites — all green:

- Standard: `lint` (backend 969 warnings / 0 errors, frontend 1 warning /
  0 errors — the audit baseline, unchanged), `test:lint-engine`,
  `i18n:check` (including negative tests), `build`, `build:frontend`,
  `test:script-coverage`, `docs:check` (exit 0; only the pre-existing
  non-gating phase-numbering warning), `git diff --check` clean.
- Delivery 2 area: `test:pos-wifi-drop` 51/51,
  `test:issue-788-order-attempt-storage` green,
  `test:issue-255-append` 17/17, `test:bills-settlement-idempotency`
  134/134, `test:cashier-workspace` green, `test:full-house` green
  (0 findings), `test:restaurant-day-cycle` 116/116.
- Sanity: `test:receipt-column-oracle` green (no byte change),
  `test:bills-print-api` 34/34.

Scope check: frontend only. No backend files, no money/tax/settlement/
refund/duplicate-payment semantics changed, no `docs/production-readiness/*`
edits, frozen locales untouched, only 8 new `pos` keys in `ar.json` +
`en.json`. Stale-attempt recovery replays under the ORIGINAL idempotency
key; already-confirmed attempts are never re-sent; cleanup is guarded by
key + fingerprint. Print paths keep their behaviour under a longer 30 s
ceiling (backend CUPS dispatch alone allows 20 s); the 10 s default
applies to everything else. This is within Delivery 2 as assigned.

Disclosure recorded: Flint published without a local battery because of
the continuing EPERM write fault on his VM (~34 h, disclosed plainly in
the Delivery 2 status file, including the identical /tmp build failure).
Ted's battery above — run in full on this host, including every item
Flint could not run — is the gate, and it passed. No code defect from
Flint's side was found in what was presented.

PR #25 has been commented (landing SHAs + battery result) and closed
UNMERGED per protocol. Follow-up 34 in `docs/IMPLEMENTATION_REPORT_AR.md`
records the landing. No Windows installer for this landing: per
assignment 037, the single installer comes after the last production
delivery lands.

NEXT: Delivery 3 (KOT: F-004 printed marker, F-009 durable retry queue,
F-029 reconnect catch-up chime; F-013 stays closed per decision 038 —
document the flexibility only, no progression-rule changes) on branch
`assistant/auditfix-d3-kot`, one PR, in order. Assignment 037 stays in
`open/` as the live queue.
