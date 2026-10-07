# Workflow 04 — Test

Goal: evidence that exactly what changed actually works, recorded so the critic (and the next agent) can inspect it without re-running anything blind.

Steps:
1. Run the full relevant test suite (the repo command in AGENTS.md). Record the exact commands, outcomes, and exit status.
2. Live/manual smoke: exercise the changed behavior itself, end to end, in the most realistic mode available (run the app, hit the endpoint, open the output). A green suite plus zero contact with the changed path is not tested.
3. Global-failure check: if the feature depends on an external system that can fail globally (model, API key, binary, service), confirm the warmup probe result is in the report. Per-item failures that all trace to one global cause must be reported as that one cause.
4. Inspect outputs directly where the claim is visual or data-shaped: open the produced file at full resolution/detail, sample the exact values or regions the change affects, and compare before/after when a fix is claimed.
5. Write the report to `.agents/test-reports/YYYY-MM-DD-<task-id>.md` (template: test-report): commands run, pass/fail counts, failures with root cause (yours vs pre-existing, with evidence), skipped/un-runnable checks each as `unverified — <reason>` plus how to verify properly, and coverage gaps.

Gate:
- The changed behavior was exercised, not just adjacent code.
- Every failure is classified (caused by this change / pre-existing / unverified) with evidence.
- The report exists and is linked from the task file and the handoff.

Never report a blocked, timed-out, permission-denied, or zero-coverage check as a pass. Say `unverified` and say why.
