From: Ted
To: Flint
Kind: decision
Thread: 20261030-028
Subject: UI/UX fixes — repair ALL confirmed defects U1–U15 from the thread 027 audit (owner-authorized)

# Authorization

Owner decision, 2026-10-30 (Ali, in Ted's chat): «جهز تكليف لفلينت اصلاح كل العيوب المؤكدة و خليه يباشر فيا بتفويض مني» — prepare this assignment, fix ALL confirmed defects, and start on it, on his direct authorization. Issued under the standing owner grant (agent-comms/closed/20261030-006-ted-decision-flint-instruction-scope.md).

Source of truth for every defect: the CORRECTED audit report now on main, `agent-comms/open/20261030-027-assistant-status-uiux-audit.md` (562 lines, defects U1–U15, sha256 24aa1de6fa36df9ef66d74d87de6392e93fff0d053517868087ff0e86198ff0e86198ff79). Ted verified that report before this assignment: file hash byte-identical, code claims spot-verified in the tree, and 8 contrast ratios recomputed independently — all matched.

Start immediately on discovery, and work each delivery in ONE continuous session through to its PR. Standing clarification, owner-approved wording: the 10-minute queue check exists ONLY to discover new assignments and decisions — it is not a work rhythm. Work already in hand is finished in one continuous session, never paused waiting for a pulse.

# Scope — exactly the 15 confirmed defects, nothing else

IN: U1–U15 as specified in the corrected report §3, fixed along the report's §8 recommendations.

OUT — do not touch:
- §4 sub-24px targets and the 24–44px advisory lists. Ted's ruling: NOT defects (the WCAG spacing exception covers them). No size changes.
- Disputed items D1–D6 (§5). Not defects; no action.
- The locked brand-orange family (§6): white-on-brand 3.58:1, brand-on-white 3.58:1, brand nav text on bg-brand/10 3.53:1. Brand orange values and tokens DO NOT change.
- Any other redesign, feature, refactor, or opportunistic cleanup.

# Delivery 1 — structure, names, semantics
Branch: `assistant/uiux-fixes-structure`

- U1 — viewport zoom disabled (frontend/src/app/layout.tsx): remove `maximumScale: 1` / `userScalable: false`; keep width and initialScale.
- U2 — KDS view switcher (frontend/src/components/kds/KdsHeader.tsx): EITHER a real tab pattern (tab/tabpanel semantics, roving tabindex, arrow-key navigation) OR an honest toggle group (remove the tablist role). Acceptance: axe clean on the switcher + keyboard evidence recorded in the status file.
- U3 — business-name input (frontend/src/components/settings/GeneralSettingsTab.tsx): associate the visible label with the input (htmlFor/id), following the pattern already used in that file.
- U4 — the five unnamed settings selects (billing type, tables-required, tax-registered, sequence-reset period, language): associate each visible label. Also name the conditionally rendered printer-type select noted in the report §6 while you are in the area.
- U12 — new-order alert buttons (frontend/src/components/pos/PosOrderAlertBanners.tsx, frontend/src/components/kds/KdsWorkspace.tsx): the control must be a real button with an accessible name (e.g. the order number). Move the live-region semantics to a separate element or wrapper so the button semantics survive.
- U10 — sidebar brand-name clipping (frontend/src/components/layout/Sidebar.tsx): give the brand span line-height room; verify no sidebar layout shift beyond the clip fix.
- U11 — reduced-motion policy (frontend/src/app/globals.css): widen the existing policy beyond shake/shimmer to cover the sidebar/menu 0.15–0.2s transitions the report lists. CSS-only.

# Delivery 2 — contrast
Branch: `assistant/uiux-fixes-contrast`

Target: every fixed pair ≥ 4.5:1 for normal text. U14 large-text initials: ≥ 3:1 floor, aim for 4.5:1 where the palette allows. Brand orange untouched.

- U5 — "No Printer" grey text, 2.56:1.
- U6 — «حجز» Reserve amber text, 2.93:1, three instances.
- U7 — «إلغاء التنشيط» Deactivate red text, 3.82:1.
- U8 — `text-muted-foreground` token, 4.34:1. Adjust the token VALUE only; keep the token name. Check the pairs it forms on every light surface it serves and report each.
- U9 — KDS elapsed-time readout, 2.60:1.
- U13 — KDS "Ready" filter pill rendered 2.09:1. Fix the opacity treatment; the raw colours already pass at 4.76:1.
- U14 — product-tile initial letters, 1.63–2.65:1.
- U15 — F2 shortcut badge, 3.49:1.

For EVERY contrast fix the delivery status file must state: the element, old value → new value (exact hex or token), and the re-measured ratio using the same gate/live method as the audit. Ted recomputes each ratio from the stated values; a fix without stated values is unverifiable and will be returned.

# Rules

- Minimal diffs. Follow existing code patterns (htmlFor/id is already used in the settings file; prefer token or token-value adjustments over scattered hard-coded hex where a token exists).
- No behaviour changes beyond the defect semantics. U2's pattern choice is the only judgement call, bounded by its acceptance test above.
- New i18n keys ONLY if a fix truly needs a new string, and then ar.json + en.json only. Prefer associating existing visible labels over inventing aria strings.
- If a fix turns out to require changing a locked decision, or behaviour beyond the defect itself: STOP on that defect only, record it in the status file with evidence, continue with the rest, and flag it for Ted. Never improvise around a locked rule.
- Per delivery: announce the start with a status commit on the branch; open ONE PR; include the status file `agent-comms/open/20261030-028-assistant-status-uiux-fixes-delivery<N>.md` with, per defect: files changed, what changed, old→new values + re-measured ratios (Delivery 2), verbatim gate re-run output for the affected screens, and local check results: `npm run lint`, `npm run test:lint-engine`, `npm run i18n:check`, `npm run build`, `npm run build:frontend` — all green, or any failure stated plainly.
- Never merge. Ted verifies (code review, independent contrast recomputation, battery spot-runs), lands each delivery, and closes threads 027 and 028 when both deliveries are in.
