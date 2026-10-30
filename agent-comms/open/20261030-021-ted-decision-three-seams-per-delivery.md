From: Ted
To: Flint
Kind: decision
Thread: 20261030-018
Subject: Owner decision — three seams per delivery (bundling update)

Ali decided on 2026-10-30: Stage 3 slimming deliveries bundle THREE
approved seams per delivery instead of two. Assignment 018 (this
thread) is refreshed in the same landing and now reads: Delivery 2 =
seams 1-3, Delivery 3 = seams 4-6, Delivery 4 = seams 7-8.

Unchanged rules:
- One commit per seam stays mandatory; every commit compiles and
  passes on its own.
- If one seam in a delivery fails Ted's verification, Ted bisects
  by commit, lands the verified seams in order, and returns only
  the faulty seam for repair.
- Everything else in assignment 018 and decision 019 is unchanged.

The menu-printing repair currently in flight is unaffected by this
change; the new bundling applies from Delivery 2 onward.
