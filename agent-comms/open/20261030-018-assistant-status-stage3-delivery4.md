From: assistant
To: ted
Kind: status
Thread: 20261030-018
Subject: Stage 3 Delivery 4 done — thermal.ts slim 3, seams 7-8 (document-plugin-receipt, receipt-entry)

Delivery 4 is complete on branch assistant/stage3-delivery4-thermal-slim-3,
base upstream main 96d01bd8c2f9fa561f95bb9a03322aa12390c106 (Delivery 3
landed and accepted, decision 20261030-025). One commit per seam, pure
moves only, thermal.ts keeps re-exports so existing call sites do not
change. No golden regenerated. Physical-printer verification on the
owner's machine remains outstanding for every printing stage — not claimed
here.

What moved (thermal.ts 2,092 -> 1,093 lines):

- Seam 7 (5bbdc43) — S9 plugin ESC/POS line-template renderer ->
  main/printers/document-plugin-receipt.ts (583 lines):
  renderPluginReceipt (:50), parseJson (:105),
  selectTemplateWidthProfile (:113), collectTemplateWidthProfiles (:134),
  TEMPLATE_ROW_TO_CHARGE_ID (:149), renderEscposLineTemplateV1 (:154).
  The moved block is byte-identical to the base (verified by diff),
  except one one-word `export` addition on renderPluginReceipt, which
  formatReceipt calls. The module imports its S10 helpers
  (formatClassicReceipt, formatTableLabel, resolvePaymentMethodLabel,
  pluginDetailLines, pluginItemHeader, pluginItemRows, pluginSummaryRow)
  from './thermal' — call-time use only, same accepted shape as
  Deliveries 2-3; seam 8 retargets that import to './receipt-entry'.
- Seam 8 (c4dd8b4) — S8 receipt entry dispatch + S10 compact/classic
  wrappers + plugin column helpers ->
  main/printers/receipt-entry.ts (470 lines): formatReceipt (:31),
  normalizeReceiptTemplate (:142), formatCompactReceipt (:151),
  formatClassicReceipt (:180), pluginLineItemColumns (:219),
  pluginLineGap (:272), pluginDetailLines (:277), pluginItemHeader
  (:283), pluginItemRows (:299), pluginItemColumnValue (:351),
  pluginItemTaxRate (:380), pluginSummaryRow (:390),
  composePluginColumns (:420), alignCell (:438), truncateCell (:442),
  resolvePaymentMethodLabel (:457), formatTableLabel (:464), capitalize
  (:468). Both blocks byte-identical to the base (verified by diff), no
  export additions: every moved symbol was already exported from
  thermal.ts. document-plugin-receipt.ts's S10-symbols import retargets
  from './thermal' to './receipt-entry' (one line, same delivery,
  within main/printers/).

thermal.ts keeps re-exports (thermal.ts:49-58): it imports formatReceipt
for its print entry points and re-exports formatReceipt,
formatClassicReceipt, formatCompactReceipt, normalizeReceiptTemplate,
resolvePaymentMethodLabel and formatTableLabel, so existing call sites
(including raster-documents.ts's normalizeReceiptTemplate import) do not
change. No exports lost from the thermal.ts surface: the four S10
helpers (pluginDetailLines, pluginItemHeader, pluginItemRows,
pluginSummaryRow) were never exported from thermal.ts; they are now
exported from receipt-entry.ts for document-plugin-receipt.ts's internal
use only, no outside caller. renderPluginReceipt is exported from its
own module for receipt-entry.ts's use only and is not re-exported from
thermal.ts (S9 had no exported symbols).

Battery (Stage 3 battery, serial, `npm run clean` between suites, proxy
unset except `build:frontend`): baseline on 96d01bd 29/30 green plain
(test:raster rc=1 plain, declared environment skip: Missing X server /
$DISPLAY) and 30/30 effective (raster rc=0 under xvfb-run); after seam 7
and after seam 8 the same 29/30 plain / 30/30 effective, no new red vs
baseline. Receipt-column oracle 12/12 byte-identical at baseline and
after each seam; bills-print-api 34/34; migration registry 371/371;
menu-printing 10/10.

Disclosed:
- Seam 7 build first failed (TS2459): the four S10 helpers are declared
  in thermal.ts but not exported, so the new module could not import
  them; fixed with one-word `export` additions in thermal.ts (they move
  with `export` to receipt-entry.ts in seam 8). It also failed (TS2304)
  because six formatting-helpers names S9 used feed thermal.ts's local
  re-export block (`export { ... };`), which tests use via the thermal
  path — they stay imported; only parseAddons was pruned. The extract
  script was corrected and re-run; build green before the seam 7 battery.
- The pre-commit formatter collapsed blank lines left by the moves
  (one double blank in the seam 7 commit, two in the seam 8 commit);
  whitespace only. The moved blocks in the committed files are still
  byte-identical to the base. Targeted re-check on the committed bytes
  (build, lint, oracle 12/12, merchant-print-templates, print-parity,
  menu-printing 10/10, print-document) all green.
- The thermal.ts <-> document-plugin-receipt.ts / receipt-entry.ts
  import cycles are call-time use only (same accepted shape as the
  Delivery 2/3 cycles). If a later seam turns any cycle into a
  load-time use, that seam stops and is reported.

What is next: per assignment 018, Stage 3 completes with Delivery 4.
No owner wait at any gate.
