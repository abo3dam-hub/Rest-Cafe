From: ted
To: assistant
Kind: decision
Thread: 20261102-037
Subject: Decision 042 — audit-fix Delivery 4 accepted, Delivery 5 NEXT (thread 037)

Delivery 4 (PR #27, branch `assistant/auditfix-d4-host`, 30 commits,
30 files) is ACCEPTED and landed on upstream main.

Verified on Ted's host, staged tree byte-identical to the PR head
`c8c0d70`, serial battery, proxy unset except `build:frontend`,
`npm run clean` between suites — all green (19/19):

- Standard: `lint` (966 backend warnings / 0 errors, identical to base
  `b5b3b87`; frontend 1 warning / 0 errors, pre-existing in a file this
  delivery did not touch), `test:lint-engine`, `i18n:check`, `build`,
  `build:frontend`, `test:script-coverage`, `docs:check` (only the
  pre-existing phase-numbering warning, non-gating),
  `git diff --check` clean.
- Delivery 4 area: `test:server-port-collision`,
  `test:issue-278-fail-closed-db`, `test:smoke`, `test:backup`,
  `test:local-backup`, `test:migration-registry` 374/374 (123 migrations,
  v1..v123).
- New suites: `test:host-rediscovery` 21/21, `test:autostart` 23/23,
  `test:server-ports` 32/32, `test:wal-checkpoint` 8/8 — all wired into
  `package.json`, the `test` chain, script-coverage, and the CI
  protecting list.
- Extra: `test:receipt-column-oracle` 12/12, no byte change.

Scope check: F-005 autostart service + startup/same-run apply + Store-tab
toggle (Windows only, safe no-op elsewhere; actual login behaviour stays
a device-phase verification); F-006 port-bump recording + `GET
/api/server-ports` + persistent banner/chip + live ports on the three
pairing tabs (bump behaviour itself unchanged); F-030 host re-discovery
(`flo.local` first, then cached pairing hosts, single-flight, max 3
redirects/session, loopback excluded; pairing unchanged; page-must-load
limitation stated); R-01 persistent owner/manager-only integrity banner
(boot-with-warning design unchanged); R-02 WAL checkpoint on close, best
effort, never blocking close. No money/tax/settlement/refund semantics
changed, no golden files touched, `bills.printed_at` untouched (F-026
stays Delivery 5), no `docs/production-readiness/*` edits, new i18n keys
in `ar.json` + `en.json` only (9 each). Flint's local battery (19/19)
matched Ted's battery on every item; the EPERM write fault did not
return in this delivery.

Disclosure — landing-order error by Ted (not a tree defect): the staged
commit list was newest-first, so the 30 commits landed in reverse order
(status file first, start announcement last). The final tree on `main`
is byte-identical to the PR head `c8c0d70` (empty diff) and the battery
above ran on that exact tree, so the product is unaffected; but the
intermediate reversed trees do not build standalone (tests before the
code they cover). The push path is non-force fast-forward only, so the
published history cannot be rewritten to repair the order — this
disclosure is the available remedy, and future landing lists will be
checked oldest-first before any push.

PR #27 has been commented (landing SHAs + battery result) and closed
UNMERGED per protocol. Follow-up 36 in `docs/IMPLEMENTATION_REPORT_AR.md`
records the landing. No Windows installer for this landing: per
assignment 037, the single installer comes after the last production
delivery lands.

NEXT: Delivery 5 (print correctness: F-015 80 mm unification, F-016 KOT
wrap, F-017 non-financial line handling, F-018 compact 80 mm pin, F-026
`printed_at` on confirmed dispatch only, F-027 deterministic WebUSB
selection) on branch `assistant/auditfix-d5-print`, one PR, in order.
Assignment 037 stays in `open/` as the live queue.
