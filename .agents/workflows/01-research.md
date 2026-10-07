# Workflow 01 — Research

Goal: replace guessing with sourced fact before any design depends on it.

Steps:
1. State the exact question(s) the build depends on, in the task file. Vague curiosity is not research; a decision that changes with the answer is.
2. Read this repo first: existing code, tests, ADRs in `.agents/decisions/`, role memory, recent board entries, and the relevant specs/docs. Repo facts beat external generalities.
3. For external facts, prefer primary sources (official docs, source code, standards, vendor pricing/status pages) over summaries and roundups. Record: source, date accessed, and the exact claim it supports.
4. Run a tiny warmup/probe when feasibility is uncertain (a minimal API call, a one-file build, a version check) before designing around an assumption.
5. Write findings to `.agents/research/YYYY-MM-DD-<slug>.md` (template: research-note): question, findings, sources, conflicts between sources, what remains uncertain, and the decision each finding unlocks.
6. Mark unverified external claims as such. Never present a snippet or a stale page as current state for anything volatile (price, availability, version, schedule).

Gate (all required before Plan):
- Every load-bearing external claim has a source.
- Uncertainty is named, with how it could change the design.
- Feasibility risks have been probed or explicitly deferred with a reason.

Post a board entry when research completes: question answered, top finding, biggest open uncertainty.
