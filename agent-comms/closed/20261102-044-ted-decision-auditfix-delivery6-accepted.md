From: ted
To: assistant
Kind: decision
Thread: 20261102-037
Subject: Decision 044 — audit-fix Delivery 6 accepted, thread 037 COMPLETE

Delivery 6 (PR #29, branch `assistant/auditfix-d6-hardening`, 45 commits,
45 files) is ACCEPTED and landed on upstream main.

Verified on Ted's host, staged tree byte-identical to the PR head
`f94a342`, serial battery, proxy unset except `build:frontend`,
`npm run clean` between suites — 30/30 green, matching Flint's claims
suite by suite:

- Standard: `lint` (822 backend warnings / 0 errors, matching Flint's
  966 -> 822 claim exactly; 1 pre-existing frontend warning),
  `test:lint-engine`, `i18n:check`, `build`, `build:frontend`,
  `test:script-coverage`, `docs:check` (only the pre-existing
  phase-numbering warning, non-gating), `git diff --check` clean.
- New suites, all wired into `package.json`, the `test` chain and
  script-coverage: `test:idempotency-retention` 20/20,
  `test:restore-fresh-install` 20/20 (proven to fail on the unfixed
  merge first: owner active flag `expected 1, got 0`).
- Security / authz: `test:cors`, `test:csp-lan`, `test:security`,
  `test:staff-authz`, `test:orders-authz`,
  `test:cross-server-login-rate-limits`, `test:authorization-permissions`.
- Money guards, all untouched by this delivery: `test:migration-registry`
  377/377 (124 migrations, v1..v124), `test:upgrade-path`,
  `test:cash-closures` 370/370, `test:full-house` 0 findings,
  `test:restaurant-day-cycle` 116/116, `test:bills-print-api` 34/34,
  `test:receipt-column-oracle` 13/13 byte-identical,
  `test:bills-settlement-idempotency` 134/134, `test:backup`,
  `test:local-backup`, `test:kds-integration`, `test:kds-live-push`,
  `test:printer`, `test:issue-788-order-attempt-storage`.
- Diff review before the battery: no change to `refund.ts`, no golden
  files, no frontend files, no new i18n keys, no edits under
  `docs/production-readiness/*`. F-025 changes are catch-annotation
  removals plus formatter reflow only, except the single equivalent
  spread-plus-delete swap in `main/routes/bills.ts` (original object
  untouched in both versions). F-031, F-033 and F-022 match the
  assignment 037 scope exactly.

Disclosed, no code effect: Flint's status text says "7 commits" while
the PR carries 45 per-file commits, and the PR body names local heads
`85b88942` / `b4bd6edf` against the published branch head `f94a342`.
The verified and landed artifact is the published branch itself, whose
tree matches the landed tree byte for byte. The diagnostics-write
limiter's private-IP skip (`main/routes/diagnostics.ts:22`) stays out
of scope and flagged, as Flint reported — not silently fixed.

Thread 037 is COMPLETE with this decision: all six audit-fix deliveries
(D1 test/CI, D2 hung sale, D3 kitchen tickets, D4 operable host, D5
print correctness, D6 hardening) are on upstream main. The single
Windows installer for the round is dispatched from the new main after
this landing; physical-printer verification and the real Windows-login
autostart test on the owner's machine remain outstanding, as always —
a verification limit, not an approval gate.

No authorized work remains in the queue: assignment 037 is closed with
this decision. Subsequent loop runs should find nothing pending and
end silently; no new work is to be invented.
