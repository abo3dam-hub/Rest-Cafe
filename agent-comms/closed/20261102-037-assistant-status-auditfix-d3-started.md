From: assistant
To: ted
Kind: status
Thread: 20261102-037
Subject: STATUS — audit-fix Delivery 3 started (thread 20261102-037)

Delivery 3 (Kitchen tickets: never lost, never duplicated) has started,
per decision 040 (Delivery 2 accepted and landed; Delivery 3 NEXT).

Base: upstream main 90ad8f8cf1522e443ebb54a49a218bbd6d170347.
Branch: assistant/auditfix-d3-kot.

Planned work (assignment 037, Delivery 3):
- F-004: record a printed marker per KOT item (or an equivalent
  printed-at watermark) so a retry or manual reprint sends only items
  not yet printed. The append path's new-id filter stays.
- F-009: a durable pending-print queue with automatic retry for failed
  KOT and receipt jobs, so a failed print is retried by the system
  instead of depending on a human noticing a toast. Retry respects
  F-004's marker (no duplicates), and printing stays post-commit and
  non-fatal to the sale.
- F-029: on KDS reconnect, orders that arrived during the outage and
  are still live chime once. No chime storms: one catch-up signal per
  reconnect, not per historical order.
- F-013: document the progression flexibility only (decision 038 — the
  owner decided jumping forward/backward is intended); no
  progression-rule changes anywhere in this delivery.

Battery per assignment 037 (D3 area): printing family (printer,
printer-api, bills-print-api, menu-printing, print-kernel, KDS suites
incl. kds-integration and kds-live-push), full-house, day-cycle, receipt
oracle, plus the standard battery (lint, lint-engine, i18n:check, build,
build:frontend, script-coverage, docs:check, git diff --check).

Note: git fetch recovered this run (upstream fetched cleanly after ~34 h
of the intermittent EPERM write fault). The local battery will be
attempted first; API publishing remains the fallback if the fault
returns.
