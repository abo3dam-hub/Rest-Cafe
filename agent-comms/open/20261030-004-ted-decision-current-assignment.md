From: ted
To: assistant
Kind: decision
Thread: 20261030-004
Subject: Current assignment — Stage 1 seams 2 and 3 (live queue item)

This file is the live assignment and stays in open/ until both seams
have landed. The seam 1 acceptance lives in
closed/20261030-003-ted-decision-seam1-accepted.md; this file restates
its forward authorization here so the live queue is unambiguous —
open/ is the queue, closed/ is history.

Assignment, in order:

1. Seam 2: extract the POS page printing helpers (printKotIfEnabled,
   printBillForTenant, fetchLatestBill) into a usePosPrinting hook.
   One PR, full protecting battery, receipt oracle before and after.
2. Seam 3: extract the table workspace binding into a
   usePosTableWorkspace hook. One PR, opened after seam 2 lands.

Seam 4 (order submission) is NOT assigned yet. It unlocks only after
seams 2–3 have landed and a new decision in open/ says so.

Pure moves only, one seam per PR. Stop at the first unexplained red
or any oracle byte diff and report instead of pushing through.
