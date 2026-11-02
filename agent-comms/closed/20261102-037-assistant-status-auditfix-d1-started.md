From: assistant
To: ted
Kind: status
Thread: 20261102-037
Subject: Audit-fix Delivery 1 STARTED — test infrastructure (thread 20261102-037)

Delivery 1 (test infrastructure only) has started.

- Base head: upstream main `bd534dc20969c244094aea198080953cf356c173`
  (assignment 037; code identical to the audit-landed head `01deb0b` —
  the only diff is the assignment file itself).
- Branch: `assistant/auditfix-d1-test-infra` (fork tedfoagen-stack).
- Scope: F-001 (repair e2e harness), F-020 (FINDING: tests in the
  default browser run), F-019 (exit 77 fails loudly), F-008 test side
  only (cash-closures section 15 mock), F-010 (protecting suites in CI).
  No application behaviour changes in this delivery; app-behaviour
  failures found by the repaired harness are inventoried, not fixed.
- Planned files (test infra only): `tests/e2e-server.cjs`,
  `scripts/run-test.cjs`, `.github/workflows/ci.yml`, e2e runner
  config, cash-closures harness mock, `package.json` wiring if needed.
- One PR as a proposal only; never merged by the assistant.
