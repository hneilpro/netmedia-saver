# Workflow 05 — Critic review (harsh critic gate)

Goal: an independent, evidence-backed verdict on both the process and the outcome, before anything is presented as done. Performed by the critic role (see `.agents/roles/critic/AGENTS.md`) using the critic-review template, filed in `.agents/reviews/`.

## The rubric (score every row: PASS / FAIL / UNVERIFIED, with evidence)

Process rows:
1. Research: right questions, primary sources, uncertainty named, warmup probed where feasible.
2. Plan/Design: true end goal, checkable acceptance criteria, blockers first, alternatives real, test strategy written, ADRs where required, owner OK for major work.
3. Build: diff scoped, style/architecture respected, tests added for changed behavior, dependencies spelled out, no secrets/real personal data.
4. Test: full relevant suite run, changed behavior exercised live/manually, outputs inspected directly, failures classified, skips labelled `unverified — reason`.

Outcome rows:
5. Correctness: does it do what the acceptance criteria say, on the evidence (not on the description)?
6. Evidence quality: could a stranger reproduce the “it works” claim from the test report alone?
7. Risk: what breaks first in real use, what was left unverified, and is that risk acceptable and disclosed?
8. Suggestions: each improvement suggestion cites its backing (source, benchmark, or measured data from this repo) or is explicitly labelled opinion. Generic best-practice filler without backing is dropped.

## Rules of the gate

- Independent pass: the critic inspects the artifacts and evidence itself, at full detail, on the exact spots the change claims to affect. Reading the builder's summary is not inspection.
- Verdict is one of: approve / approve with notes / needs changes / reject. Blocking findings use the severity scheme in the critic role file. A “done” or “fixed” claim with an open Blocking finding needs an explicit owner waiver recorded in the review, or it is not done.
- Bounded loop: builder revises and the critic re-scores only the failed criteria. Default maximum two revision rounds. After that, remaining gaps are named in the review and the task stops; nobody loops until approval.
- Merge/done readiness (all required): acceptance criteria met on evidence; scope controlled; handoff exists; review exists and is not blocking; required checks passed or skips justified as `unverified`; test report exists for non-trivial changes; high-risk issues resolved or escalated in risks/; no secrets in the diff; rollback noted where the change is hard to undo; owner approval where POLICY.md requires it.
- After a user/owner correction, the next review must carry fresh evidence for exactly the corrected points. A blanket “all fixed” re-review does not satisfy the gate.

Post the verdict to the board the same run the review is filed. Update `.agents/status.json` (phase, blockers).
