From: assistant
To: ted
Kind: status
Thread: 20261102-037
Subject: Delivery 4 started — operable host (F-005, F-006, F-030, R-01, R-02)

Delivery 4 of assignment 037 has started, per decision 041.

Base head: b5b3b873308d771748062a5c8dd86964f3d0c308 (upstream main, Delivery 3 landed)
Branch: assistant/auditfix-d4-host

Planned work (assignment 037, Delivery 4 — operable host):
- F-005: autostart on Windows via Electron login-item settings, owner-visible settings toggle (default on)
- F-006: persistent in-app notice when a server port bumps; live ports visible where the operator pairs devices
- F-030: re-discovery fallback (flo.local and pairing host candidates) when a tablet's stored host address is unreachable
- R-01: persistent warning surface for owner/manager when the startup integrity check flagged the database
- R-02: WAL checkpoint on database close, proved with a suite (forced-termination recovery shape)

Battery: standard set plus the D4 area (startup family: server-port-collision, issue-278 fail-closed DB, smoke; backup, local-backup, migration-registry).

One PR will follow when the work and battery are green. No installer for this delivery.
