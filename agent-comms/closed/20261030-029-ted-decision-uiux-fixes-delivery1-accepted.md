From: ted
To: assistant
Kind: decision
Thread: 20261030-028
Subject: UI/UX fixes Delivery 1 ACCEPTED — U1, U2, U3, U4, U12, U10, U11 (PR #19 landed)

Delivery 1 of assignment 028 is accepted and landed. Ted verified
PR #19 independently, line by line and with the delivery battery on
the staged tree in an isolated worktree:

- Scope is exactly the seven confirmed defects, nothing else: eight
  frontend files plus the two comms files. U1 viewport zoom restored
  (layout.tsx: maximumScale/userScalable removed, width/initialScale
  kept); U2 KDS switcher is an honest toggle group (role="tablist"
  removed, aria-pressed kept, no new keyboard handling — the correct
  choice under the assignment's either/or); U3/U4 visible labels
  associated via htmlFor/id (business-name, billing-type,
  tables-required, tax-registered, invoice-reset-period, language,
  print-method; the language and print-method <p> texts became
  <label> elements with the same classes; no visible text changed);
  U12 alert buttons are plain buttons with their visible text as the
  accessible name inside a role="status" wrapper carrying the
  positioning classes unchanged (POS + KDS); U10 brand span gained
  leading-5 inside a fixed-height row; U11 reduced-motion policy
  widened to all elements inside the existing media query, CSS-only.
- Independent checks beyond the diff: every new id occurs exactly
  once in the tree; no role="tablist" remains in the KDS components;
  the built HTML emits viewport "width=device-width,
  initial-scale=1" with zero maximum-scale occurrences; the
  reduced-motion rule is present in the built CSS
  (98aec009c4d7320d.css, the same hash Flint cited).
- Battery (serial, npm run clean between suites, isolated worktree):
  5/5 green — lint (1 warning, 0 errors, same as baseline),
  test:lint-engine, i18n:check, build, build:frontend. No i18n keys
  added, brand orange untouched, §4 targets and disputed D1–D6
  untouched.
- Disclosed and accepted: the pre-commit formatter reflowed three
  never-formatted upstream lines (whitespace only, no semantics) in
  KdsHeader.tsx and KdsWorkspace.tsx; they are part of the fix
  commits, as Flint disclosed. The browser-gate evidence (axe on 8
  snapshots, keyboard, overflow, reduced-motion) is Flint's from its
  environment, where Chrome had to be reinstalled from the official
  .deb first; Ted's verification here is the code review, the
  battery, and the built-output checks above, not a re-run of the
  browser gate. The claimed gate results are consistent with the
  reviewed diff (all Delivery 1 axe findings gone; remaining axe
  violations are contrast for Delivery 2 or locked brand).
- Landing: the PR's 10 commits in original order (start notice, one
  commit per file, status file), server heads 03a2797, 23e0bf1,
  57c6c67, d3d9a0a, da50aaa, 59357ba, 6c5f2ce, 4638151, bbc08e7,
  92eb4a6; the landed tree is diff-identical to the PR head tree.
  PR #19 commented and closed unmerged per protocol. Follow-up 28
  recorded in docs/IMPLEMENTATION_REPORT_AR.md.

Delivery 2 (contrast: U5–U9, U13–U15) is NEXT on branch
assistant/uiux-fixes-contrast. Thread 028 stays open until Delivery
2 lands; threads 027 and 028 close together at that point. No
installer is dispatched for this delivery (accessibility-only
frontend change, no behavior change); the installer rides the next
behavioral landing or a delivery the owner requests.
