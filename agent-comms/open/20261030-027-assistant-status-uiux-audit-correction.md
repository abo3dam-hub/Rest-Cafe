From: assistant
To: ted
Kind: status
Thread: 20261030-027
Subject: UI/UX audit report correction — corrected findings missed the landing by seconds (REPORT ONLY, no fixes)

## What happened

PR #17 (head `7fdaa1b`) is closed; upstream main `8963f06` carries the audit
announce and the report. But the landed report is the ORIGINAL version
(`e1fb386`, 441 lines, defects U1–U11). The correction commit (`7fdaa1b`,
562 lines) reached the fork at 22:25:02 +03 — about 26 seconds AFTER the
landing commit `8963f06` (22:24:36 +03). The correction therefore never
landed. This PR carries only that correction: no new findings, no code
changes, report only.

## What the correction changes (all second-measured live)

- Defect count 11 → 15 (U1–U15); §3 renumbered accordingly.
- Target-size table: the gate passes via the WCAG spacing exception
  (EXIT=0), it does NOT mean every target is >= 24x24. Live sub-24px
  targets are listed in the new §4 (advisory 24–44px list unchanged).
- Disputed list renumbered D2/D3 (overlap / reduced motion) and D4
  (responsive inconclusive); §5 cross-references fixed.
- Live axe second measurement added: tables-ar finds 3 contrast nodes the
  snapshot gate missed (view toggle 4.34:1, two table action buttons
  3.58:1); POS-en finds 24 contrast nodes (snapshot: 23). See §3 U8/U14
  and §5 D6.
- Method note added: the dev server stopped once mid-audit and was
  restarted with the same `FLO_DEV_USER_DATA`; the stored owner token then
  stopped validating (signed with a superseded JWT secret), so the fixture
  owner's password was reset in the isolated audit database and a fresh
  token minted via `POST /api/auth/login`. No product code changed.

## Verification

- Corrected file byte-identical to PR #17 head `7fdaa1b`
  (`agent-comms/open/20261030-027-assistant-status-uiux-audit.md`, 562
  lines, sha256 `24aa1de6fa36df9ef66d74d87de6392e93fff0d053517868087ff0e86198ff79`).
- Base: upstream main `8963f06`. Diff scope: this status file + the report
  file only. Zero production files touched; nothing else in the tree
  changed.

## What is next

Please verify and land the corrected report; assignment 027 stays open
until a Ted decision accepts the audit (corrected version).
