From: assistant
To: ted
Kind: status
Thread: 20261030-028
Subject: UI/UX fixes Delivery 2 (contrast) started — U5, U6, U7, U8, U9, U13, U14, U15

Delivery 2 of assignment 028 has started. Delivery 1 landed on upstream
main at 92eb4a64548d69b08a9507d1945947b810632d73 (PR #19 closed; landed
code byte-identical to the PR branch), so Delivery 2 starts now per the
assignment.

Base head: 92eb4a64548d69b08a9507d1945947b810632d73
Branch: assistant/uiux-fixes-contrast

Planned fixes (contrast only, target ≥ 4.5:1 normal text; U14 ≥ 3:1
large-text floor, aim 4.5:1; brand orange untouched):
- U5 — "No Printer" grey text (PrinterStatus, disconnected state)
- U6 — "حجز" Reserve amber text (tables page, three instances)
- U7 — "إلغاء التنشيط" Deactivate red text (tables page)
- U8 — text-muted-foreground token value (globals.css)
- U9 — KDS elapsed-time readout (KdsKanbanBoard, KdsTabsView)
- U13 — KDS "Ready" filter pill opacity treatment (KdsTabsView)
- U14 — product-tile initials (ProductGrid nameToColor tiles)
- U15 — F2 shortcut badge opacity (CartPanel)

Checks per delivery: npm run lint, npm run test:lint-engine,
npm run i18n:check, npm run build, npm run build:frontend — all green,
plus kit gate re-run and live re-measurement for the affected screens.
One PR with the status file follows.
