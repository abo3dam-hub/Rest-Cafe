From: ted
To: assistant
Kind: decision
Thread: 20261030-027
Subject: Assignment — UI/UX audit with the UX/UI Agent Skills kit (REPORT ONLY, no fixes)

OWNER AUTHORIZATION (direct, recorded): on 2026-10-30 (~20:49 Damascus) Ali
told Ted in chat, verbatim sense: "prepare the work for Flint, tell him this
is a direct authorization from me, and as you proposed, let the tool's
results be recorded only, not executed." This file is that authorization in
writing, under the standing owner grant (thread 20261030-006: Ted's
agent-comms assignment/decision files on upstream main carry the owner's
word within Rest&Cafe scope and its locked rules). No carve-out is touched:
no money, no deletion, no posting in the owner's name, no billing.

## What this is

A UI/UX + accessibility AUDIT of the running Rest&Cafe app, using the
`plugin87/ux-ui-agent-skills` kit (public GitHub repo) as a measurement
instrument. Ted trialled this kit on 2026-10-15 on another project: it found
3 real accessibility defects, passed contrast/keyboard cleanly, AND produced
proven snapshot false positives. The verdict then, which governs this
assignment: useful as an audit with human verification, never as an
unquestioned pass/fail authority.

## Hard boundary — REPORT ONLY

- ZERO production changes: no code, config, test, golden, or docs edits.
  No fixes, however small or obvious. Fix ideas live in the report as
  recommendations, each marked NOT DONE.
- The kit is cloned on YOUR device, OUTSIDE this repository. Never commit
  kit files into this repo. The kit's own AGENTS.md / CLAUDE.md are its
  house doctrine for its own repo; they do NOT govern this project. Where
  kit rules conflict with this repo's AGENTS.md or the locked product rules
  below, the project wins, always.
- Delivery = ONE comms-only PR, branch `assistant/uiux-audit-report`,
  containing exactly one new file:
  `agent-comms/open/20261030-027-assistant-status-uiux-audit.md`
  (the full report, structure in §5). When you start, publish a short
  `-started` status file in this thread first, same as prior deliveries.

## Method

1. Build and run the app from upstream main; record the exact head SHA in
   the report. Seed through the real setup path with demo data in the
   production Syrian shape (ar, SYP / symbol SP, Asia/Damascus, finedine +
   demo), the same shape Ted's restaurant-day-cycle suite uses.
2. Render each screen in a real browser (the kit's Playwright Chromium),
   save rendered snapshots, run the gates against the snapshots. The gates
   accept local files, not live URLs — snapshot method must be documented
   per screen.
3. Kit verification discipline (from its own AGENTS.md): never state a
   number you did not measure; quote gate output verbatim for every claimed
   figure; a render gate that prints SKIPPED measured nothing — report it
   as NOT MEASURED, never as a pass (set `DS_REQUIRE_BROWSER=1` when you
   trust a render gate's exit code). Do NOT run `accuracy_report.mjs`
   against this project — it is the kit's self-test and scores ~nothing
   anywhere else.
4. If a screen cannot be rendered in your environment, say so explicitly
   with the blocker. Do not substitute static-code guesses for a render.

## Scope

Screens (Arabic primary; repeat axe + states gates in English for POS and
Settings):
- POS workspace (cashier face)
- Tables map
- KDS kitchen board
- Settings, including the TaxConfigurationPanel

Objective gates only:
- `axe_audit` (ARIA, labels, landmarks)
- `verify_states` (contrast in default / hover / focus / disabled)
- `verify_target_size` (WCAG 2.5.8)
- `verify_keyboard`
- `verify_overflow`, and `verify_responsive` at the resolutions this
  Windows desktop app actually runs at: 1366x768 and 1920x1080, plus
  125% display scale
- `verify_reduced_motion`

Target size, two tiers:
- Under 24px (WCAG 2.5.8 minimum) = DEFECT.
- 24–44px on the operational screens (POS / tables / KDS) = ADVISORY list,
  not defects. Rationale: touch POS used by a cashier in a rush; report
  them separately so the owner can judge.

Explicitly OUT of scope — do not report these as defects:
- Kit house rules: the no-emoji ban, the native `<select>` ban, the
  mobile-first gate, dark-mode checks via the kit's `data-theme`
  convention, em-dash / "AI tell" copy checks, token/hardcode lints
  against kit tokens, one-accent-colour and other taste rules.
- Locked product decisions: ar/en only (other locales frozen), SYP/USD
  only, DD/MM/YYYY Gregorian dates, hall (صالة) terminology, the brand
  orange + Al Malaki logo + "Powered by Ali.J" footer, Syria-only visible
  identity, hidden-but-present features (loyalty UI, online POS type).
  Flagging a locked decision as a defect invalidates that report section.

## False-positive discipline

The 2026-10-15 trial proved snapshot gates can claim overflow/contrast
failures that direct rendered measurement disproves. Therefore every defect
claim must carry: screen, gate name, verbatim measured output, the element
(visible label and file:line if known), snapshot method, and your
confidence: `verified-by-second-measurement` or `gate-only`. Where a gate
and a direct measurement disagree, report both and mark the claim
DISPUTED. Ted will spot-verify every defect by reproduction, filter false
positives, and present only the verified list to Ali.

## Report structure (in the status file)

1. Environment: head SHA, kit version/commit, browser, seeding method.
2. Per-screen gate table: pass / fail / not-measured, with measured
   numbers (never bare "passed").
3. Defects, numbered U1..Un, with the fields required above.
4. Advisory list (24–44px operational targets).
5. Disputed / likely-false-positive list.
6. Subjective observations (optional, max 5, clearly labelled subjective —
   these are opinions, not gate results).
7. Recommendations, each marked NOT DONE, ordered by your judgement of
   impact on a cashier/waiter during service.

## Gatekeeping and what happens after

Ted verifies, lands the comms PR unmerged per protocol, and reports the
filtered results to Ali in Arabic. Any fix is a separate future assignment
that exists only if Ali decides it. If you are blocked, ask via a
`question` file in this thread; silence is never approval, and nothing in
this assignment waits on a further owner approval inside its scope.
