From: ted
To: assistant
Kind: decision
Thread: 20261102-037
Subject: DECISION — audit-fix Delivery 1 accepted and landed (thread 20261102-037); Delivery 2 NEXT

Delivery 1 (test infrastructure: F-001, F-020, F-019, F-008 test side, F-010)
from PR #24 is accepted and landed on upstream main: 29 commits in original
order, server heads d9ca2c7 through c3af178, plus follow-up 33 in
docs/IMPLEMENTATION_REPORT_AR.md. PR #24 commented and closed unmerged per
protocol. No Windows installer for this landing (test/CI only).

Verification on a clean staged tree in this run: diff-check, lint (969 backend
warnings + 1 frontend warning, 0 errors — the unchanged baseline), lint-engine,
i18n, build, build:frontend, script-coverage, docs:check, cash-closures
370/370, run-test-wrapper 91/91 — all green; electron tier 7 passed / 4
declared skips / 0 failed. Tier1: 2/3 — the third test expects the English-only
KDS-disabled heading against the Arabic-first UI (same known-rot class, not a
Delivery 1 effect; pristine main cannot run tier1 at all, F-001). Tier2: 28/69
passed, up from your pre-fix 15/69; all three FINDING: tests and the refund
test now RUN (F-020 verified); zero failures on login selectors. The remaining
41 tier2 failures classify as page-level English strings, locale-assumption
expectations (the ฿/Subtotal regex, 'John Doe' vs the seeded 'Omar Haddad'),
one test-payload bug (dine_in without a table_id correctly returns 400), and
one transient browser-context loss. No failure is attributable to Delivery 1.

Recorded for the round:
- The tier1 third test and the tier2 page-level English-string failures are
  the same known test-side rot class. They are NOT regressions from Delivery 1
  and NOT application-behaviour failures.
- Recommended follow-up assignment (NOT started by this decision): re-localize
  the browser suite's page-level English strings (~1,151 occurrences) so the
  FINDING: tests, the refund test, and the rest of tier 2 can execute their
  assertions. Owner approval is needed before that assignment is filed.
- The environment write fault on your host (EPERM) did not affect this
  verification host; the battery above was re-run in full here. Rebuild dist/
  on a healthy host before your next delivery's battery, as your status file
  recommends.

Delivery 2 (branch assistant/auditfix-d2-hung-sale, assignment 037) is NEXT.
It starts from the new upstream main head. F-013 stays closed per decision
038: KDS progression flexibility is intended; Delivery 3 documents it only.
