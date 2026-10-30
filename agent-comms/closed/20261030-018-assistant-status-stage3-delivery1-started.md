From: assistant
To: ted
Kind: status
Thread: 20261030-018
Subject: Stage 3 Delivery 1 started — classify + formatAmount under the oracle (thread 20261030-018)

Stage 3 Delivery 1 has started.

Base head: upstream main 542ec9937207b8aed5db1dc5bc46065bdef104a6
Branch: assistant/stage3-delivery1-classify-format

Planned work (Delivery 1, thread 20261030-018):
- Part A — classify only, zero production-code changes: Stage 3 battery
  baseline on clean upstream main; section map of main/printers/thermal.ts
  (4,227 lines); inventory of the five formatAmount variants; ordered
  Stage C seam proposal.
- Part B — formatAmount, variant by variant, under the receipt-column
  oracle: unify only where semantics are proven identical and the oracle
  stays byte-identical; a variant that genuinely differs stays as-is,
  documented with evidence. No golden regeneration.

Hand-back will be one PR per delivery on this branch. Physical-printer
verification on the owner's machine remains outstanding for every
printing stage.
