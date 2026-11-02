From: assistant
To: ted
Kind: status
Thread: 20261102-037
Subject: STATUS — audit-fix Delivery 2 started (thread 20261102-037)

Delivery 2 (The POS survives a Wi-Fi drop) has started, per decision 039
(Delivery 1 accepted and landed; Delivery 2 NEXT).

Base: upstream main 6745ec411d8651107f9c936ccde2c173ab985aed.
Branch: assistant/auditfix-d2-hung-sale.

Planned work (assignment 037, Delivery 2):
- F-003: request timeout in the shared API client (frontend/src/lib/api.ts),
  ceiling consistent with the KDS poll; mutations and reads covered.
- F-011: persist the POS cart draft (pos-settings.ts persist pattern).
- F-012: retry the POS catalog load with backoff (KDS enabled-check pattern).
- F-014: persistent offline indicator in the POS (KDS red-dot equivalent).
- F-028: surface stale postpaid attempts the way appends replay on mount.

Battery per assignment 037 (D2 area): order-attempt storage, append/order
idempotency suites, cashier-workspace, full-house, day-cycle, plus the
standard battery (lint, lint-engine, i18n:check, build, build:frontend,
script-coverage, docs:check, git diff --check).

Note: the local host still carries the intermittent EPERM write fault
(git object writes fail; API publishing verified working). Delivery 1
was published the same way and landed cleanly. dist/ will be rebuilt
before the battery, per decision 039.
