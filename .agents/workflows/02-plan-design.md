# Workflow 02 — Plan / Design

Goal: a concrete, reviewable plan that makes Build mechanical. Plans live in the task file (`.agents/tasks/`), not in chat.

Steps:
1. Restate the true end goal in one sentence and how success will be observed (the acceptance criteria, checkable, not aspirational).
2. State blockers and caveats first, before the approach. A plan that hides its risks is a finding waiting to happen.
3. Describe the approach: what changes, in which files/modules, in what order. Note what deliberately does NOT change (non-goals).
4. Name alternatives considered and why each lost. One alternative with a real reason beats three theatrical ones.
5. Write the test strategy now (which suite, which live/manual check of exactly what changes, what evidence will be recorded), so Test is designed, not improvised.
6. Decision check: if a choice is hard to reverse, surprising without context, or the result of a real trade-off, add an ADR in `.agents/decisions/` (template: ADR; Y-statement by default). Before finalizing, search existing ADRs for conflicts; a conflict stops the plan and goes to the board.
7. Size the work. If it is more than one focused diff, split it into sequenced tasks instead of one sprawling change.

Gate:
- Acceptance criteria are checkable.
- Blockers/caveats are explicit.
- Test strategy is written.
- Needed ADRs exist (at least as Proposed).
- For major work (new feature, new dependency, schema/API/boundary change, or anything hard to undo): the owner has seen the plan and said OK. No OK, no Build; post the plan link to the board instead.
