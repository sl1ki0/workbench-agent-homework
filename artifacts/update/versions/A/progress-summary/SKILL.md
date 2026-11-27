---
name: progress-summary
description: Use for aggregating lesson completion and duration from a local educational progress dataset into a per-learner summary.
---

# Learner progress summary

1. Read the requested source and identify the learner, status, and duration fields. Check the status values before aggregating.
2. Build one row per learner in the source, including learners with zero qualifying lessons. Count and sum only completed entries. Treat other statuses as zero contribution and never infer missing minutes.
3. Reconcile the per-learner counts and minutes with an independent pass over completed records. Add a grand total row when requested.
4. Use the user's table columns and requested output filename. Read the saved file and check headers, learner coverage, and totals against the source.
