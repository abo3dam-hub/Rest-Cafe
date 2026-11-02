From: ted
To: assistant
Kind: decision
Thread: 20261102-037
Subject: Decision 041 — audit-fix Delivery 3 accepted, Delivery 4 NEXT (thread 037)

Delivery 3 (PR #26, branch `assistant/auditfix-d3-kot`, 22 commits,
22 files) is ACCEPTED and landed on upstream main.

Verified on Ted's host, staged tree byte-identical to the PR head
`0991bef`, serial battery, proxy unset except `build:frontend`,
`npm run clean` between suites — all green:

- Standard: `lint`, `test:lint-engine`, `i18n:check`, `build`,
  `build:frontend`, `test:script-coverage`, `docs:check`,
  `git diff --check` clean.
- Delivery 3 area: `test:printer`, `test:printer-api`,
  `test:bills-print-api` 34/34, `test:menu-printing`,
  `test:print-kernel`, `test:kot-print-queue` 119/119,
  `test:kds-reconnect-chime` 25/25, `test:kds-integration`,
  `test:kds-live-push`, `test:issue-133-kds-kot-toggles`,
  `test:migration-registry` 374/374 (123 migrations, v1..v123),
  `test:full-house` 0 findings, `test:restaurant-day-cycle` 116/116,
  `test:receipt-column-oracle` fail 0 (no byte change).

Scope check: F-004 per-item KOT printed marker (migration v123
`order_items.kot_printed_at`, new `main/services/kot-print.ts`, new
`POST /printers/kot-printed`, marker filter in backend and frontend
KOT paths, append new-id filter unchanged); F-009 durable print queue
(new `print_jobs` table, new `main/services/print-queue.ts` worker
with 30 s–15 m backoff and 10-attempt cap, shared receipt dispatch,
frontend localStorage queue + POS drain; print-bill queued on 502
only for a real bill id, print-kot queued on no-printer 400 and 502;
browser-print failures not queued, outcome unknowable); F-029 KDS
reconnect catch-up chime once per reconnect (per-surface persisted
seen set, 500-id cap, brand-new board still seeds silently); F-013
documentation only per decision 038 (no progression-rule code
changed). No money/tax/settlement/refund semantics changed, no
golden files touched, no new i18n keys, no `docs/production-readiness/*`
edits. Flint's local battery (21/21) matched Ted's battery on every
item; the EPERM write fault did not return in this delivery.
Correction noted: Flint's status file attributes F-026 to Delivery 4,
but assignment 037 places it in Delivery 5 — the code is correct
(`printed_at` untouched here); F-026 stays a Delivery 5 item.

PR #26 has been commented (landing SHAs + battery result) and closed
UNMERGED per protocol. Follow-up 35 in `docs/IMPLEMENTATION_REPORT_AR.md`
records the landing. No Windows installer for this landing: per
assignment 037, the single installer comes after the last production
delivery lands.

NEXT: Delivery 4 (operable host: F-005 autostart, F-006 port-bump
notice, F-030 re-discovery fallback, R-01 startup-integrity warning
surface, R-02 WAL checkpoint on close) on branch
`assistant/auditfix-d4-host`, one PR, in order. Assignment 037 stays in
`open/` as the live queue.
