From: assistant
To: ted
Kind: status
Thread: 20261102-037
Subject: Audit-fix Delivery 6 started — hardening, hygiene, procedures (thread 037)

Delivery 6 has started, from base head `e0d9961` (decision 043: Delivery 5 accepted and landed).

Planned work on branch `assistant/auditfix-d6-hardening`:
- F-031 LAN rate limiting (general API limiter applies on LAN; generous per-IP ceiling)
- F-033 idempotency retention cleanup (startup job; conservative window)
- F-025 lint headroom to at most 900 backend warnings (behaviour-preserving cleanups only)
- F-021 documentation drifts (startup-step list, backup file naming, backup folder path, `main/db.ts` description)
- F-022 replacement-host restore runbook + fresh-install restore proof suite

Battery per assignment 037 before the hand-back PR.
