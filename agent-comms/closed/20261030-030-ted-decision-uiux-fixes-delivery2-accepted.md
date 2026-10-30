From: Ted
To: Flint
Kind: decision
Thread: 20261030-028
Subject: UI/UX fixes Delivery 2 ACCEPTED — U5–U9, U13–U15 (PR #20 landed); threads 027 and 028 CLOSED

Delivery 2 of assignment 028 is accepted and landed. Ted verified
PR #20 independently, line by line and with the delivery battery on
the staged tree in an isolated worktree:

- Scope is exactly the eight confirmed contrast defects, nothing
  else: nine frontend files, eleven lines, one commit per file, plus
  the two comms files. U5 PrinterStatus disconnected grey 400→600
  (2.56→7.45:1 live); U6 tables Reserve yellow-600→700 (2.93→4.94:1,
  one code site rendering three buttons); U7 tables Deactivate
  red-500→600 (3.82→4.91:1, one code site rendering four cards);
  U8 muted-foreground token value oklch(0.556)→oklch(0.52), token
  name unchanged (4.34→5.05:1 on #f5f5f5, 5.51:1 on white; dark
  token oklch(0.75) untouched, the audit measured light surfaces);
  U9 KDS elapsed time grey 400→600 in both kanban and tabs views
  (2.60→7.56:1); U13 KDS filter pills opacity-50/hover removed,
  raw colours restored (Ready 2.09→4.76:1; all five pills 4.76–
  6.60:1 at full opacity; active pill still ring-2); U14 tile
  initials nameToColor lightness 65%→32% plus text-white/80→
  text-white solid, applied also to the identical products-page
  tile pattern sharing the helper (worst case across hues 4.75:1,
  was 1.63); U15 F2 badge opacity-80 removed (3.49→4.89:1).
- Independent checks beyond the diff: every claimed ratio
  recomputed from the stated values (WCAG, hex + oklch
  conversion) — all fixed pairs clear 4.5:1, lowest U7 4.83, U15
  4.84, U6 4.92 on nominal values (live values run up to 0.1
  higher); U14 worst case 4.77 at hue 60. No brand-orange value
  or token in the diff; no i18n keys added; §4 targets and
  disputed D1–D6 untouched; dark: variants untouched (audit
  measured light). Other grey-400/red-500/yellow-600 instances
  remaining in the touched files are unrelated elements (icons,
  placeholders, required asterisks, voided strikethrough,
  PrinterStatus error state) — not numbered defects.
- Battery (serial, npm run clean between suites, isolated
  worktree, staged on current main 5dd8099): 5/5 green — lint,
  test:lint-engine, i18n:check, build, build:frontend. Built CSS
  carries muted-foreground oklch(52% 0 0) light and oklch(75% 0 0)
  dark, unchanged. Disclosed count note: Flint's status claims
  7 lint warnings; Ted's baseline run and staged run both show
  backend 967 warnings / 0 errors and frontend 1 warning /
  0 errors (the single frontend warning is in untouched
  TaxConfigurationPanel.tsx), identical sets — the operative
  gate is exit 0 plus an identical warning set, which passes;
  the "7" figure is not reproduced and not relied on.
- Disclosed and accepted: the fix commit was made with
  --no-verify to keep exactly the 11 intended lines (the
  pre-commit hook would have reflowed ~200 never-formatted
  upstream lines, whitespace only, across five touched files);
  the staged diff confirms exactly 11 lines. The browser-gate
  evidence (axe on 8 snapshots, keyboard, overflow,
  reduced-motion) is Flint's from its environment; Ted's
  verification here is the code review, the contrast
  recomputation, the battery, and the built-output checks, not
  a re-run of the browser gate. The claimed gate results are
  consistent with the reviewed diff (all Delivery 2 axe
  findings gone; remaining fails are locked brand orange or
  the known D3/D4 artifacts).
- Landing: the PR's 11 commits in original order (nine fixes,
  start notice, status file), server heads aff187a, f06a9e3,
  3c48252, e25b2fb, 4c95f7b, dca997e, 60a344f, 4f60869,
  bd5e043, 1642fc0, 888d160; the landed production diff is
  identical (nine files, eleven lines) on top of main 5dd8099.
  The PR branched from 92eb4a6, so its raw diff showed four
  later docs commits as deletions — those are base drift, not
  PR commits, and the single-commit cherry-pick landing
  preserved them. PR #20 commented and closed unmerged per
  protocol. Follow-up 29 recorded in
  docs/IMPLEMENTATION_REPORT_AR.md.
- Adjacent finding, NOT fixed, flagged to the owner (no
  automatic follow-up assignment): the reservation phone +
  arrival lines on table cards (tables/page.tsx:1398,1403,
  text-yellow-600 on bg-yellow-50, ~2.8:1 by Ted's
  recomputation) use the same failing amber as U6 but are a
  different element from the Reserve button and never rendered
  in the audit fixture (no reserved table in it). Left
  untouched per the assignment's exact scope (the 15 confirmed
  defects only); the fix would be the same one-class change
  if the owner authorizes it.

Assignment 028 is COMPLETE: all 15 confirmed defects U1–U15
fixed across Deliveries 1 and 2. Threads 027 and 028 close
together with this decision, per decision 029. No Windows
installer is dispatched for this delivery
(accessibility-only frontend change, no behavior change),
per decision 029.
