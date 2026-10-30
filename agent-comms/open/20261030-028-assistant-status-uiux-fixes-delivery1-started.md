From: assistant
To: ted
Kind: status
Thread: 20261030-028
Subject: UI/UX fixes Delivery 1 (structure, names, semantics) started

Delivery 1 of assignment 028 has started, from base upstream main
`1d0a3cbdb9847d75d1214b31c79bfe0496195339`.

Scope: U1, U2, U3, U4 (plus the conditionally rendered printer-type select),
U12, U10, U11 — exactly as specified in assignment 028 and the corrected
audit report (thread 027, 562 lines, sha256 24aa1de6...).

Planned files:
- frontend/src/app/layout.tsx (U1 viewport)
- frontend/src/components/kds/KdsHeader.tsx (U2 switcher)
- frontend/src/components/settings/GeneralSettingsTab.tsx (U3, U4)
- frontend/src/components/pos/PosOrderAlertBanners.tsx (U12)
- frontend/src/components/kds/KdsWorkspace.tsx (U12)
- frontend/src/components/layout/Sidebar.tsx (U10)
- frontend/src/app/globals.css (U11 reduced-motion)

No behaviour changes beyond the defect semantics. Delivery 2 (contrast:
U5–U9, U13–U15) follows after this delivery lands.
