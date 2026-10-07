# AGENTS.md

Entrypoint for any AI agent working in this repository. Read this file first, then the role file for your current role. This file is the single source of truth for shared rules; role files add responsibility-specific rules and never repeat these.

## Roles

- Builder: research, plan/design, build/update, test. Owns all mutations. One builder writes at a time. See `.agents/roles/builder/AGENTS.md`.
- Critic: harsh independent review of the process and the outcome. Read-only on the work it reviews. Scores against the rubric in `.agents/workflows/05-critic-review.md`, cites research for load-bearing claims, and can block a "done" claim. See `.agents/roles/critic/AGENTS.md`.

One agent may play both roles sequentially, never in the same pass on the same change. A builder does not grade its own work; a critic does not edit the work it just graded. Switch roles explicitly and post the switch to `.agents/BOARD.md`.

## Loading order

1. This file.
2. `.agents/roles/<role>/AGENTS.md` and `.agents/roles/<role>/memory/MEMORY.md`.
3. The workflow file for the current phase in `.agents/workflows/`.
4. Only the templates, tasks, handoffs, reviews, and decisions the current task actually needs. Do not load every file in `.agents/` by default (progressive disclosure).

## The build cycle (mandatory for non-trivial work)

Research, then Design, then Plan, then Build, then Test, then Critic review. No phase is skipped because a later one “will probably catch it.” Trivial one-line fixes may collapse Research/Design into the task note; everything else follows the gates in `.agents/workflows/`.

- Research: `.agents/workflows/01-research.md`. Findings go to `.agents/research/`, with sources.
- Plan/Design: `.agents/workflows/02-plan-design.md`. Design choices that are hard to reverse, surprising without context, or the result of a real trade-off become an ADR in `.agents/decisions/`.
- Build/Update: `.agents/workflows/03-build.md`.
- Test: `.agents/workflows/04-test.md`. Evidence goes to `.agents/test-reports/`. A check that could not run is `unverified — <reason>`, never a pass.
- Critic review: `.agents/workflows/05-critic-review.md`. Review goes to `.agents/reviews/`. Nothing is presented as done or fixed until the critic gate passes or its blockers are explicitly waived by the owner.

For major work, the Plan phase needs the owner's OK before Build starts.

## Coordination

- `.agents/BOARD.md` is the inter-agent message board. Read it at session start; post handoffs, blockers, role switches, and review verdicts. Append-only; never rewrite another agent's entry.
- `.agents/status.json` holds the current task, phase, role assignment, and blockers in machine-readable form. Keep it current; it is the fastest way for the next agent to orient.
- `.agents/tasks/` holds one file per task: goal, non-goals, acceptance criteria, checks, and result.
- `.agents/handoffs/` holds structured role-to-role handoffs: what changed, what was verified, what is risky, what is next.
- `.agents/risks/` holds blockers and requests for a human decision. Do not guess past a blocker that needs the owner.

## Hard rules

- Show evidence before claiming done: exact commands run, their output or summary, and exit status. “Should work” is not evidence.
- Never write a secret, token, password, or real personal data into any committed file. Placeholders only; use John Doe / Jane Doe in examples, never the owner's real name in pushed code.
- Do not commit directly in a spammy series. Hold changes and batch them; the owner reviews at push time and holds back anything broken, superseded, or pending.
- Keep diffs small and focused. Preserve the existing architecture and code style unless the task is explicitly a redesign.
- If a rule in this file stops you from finishing, stop and say so on the board. Do not work around a guard.

## Repo commands

Fill these in per repo and keep them current (stale commands are worse than none):

- Install: n/a — load unpacked in Edge/Chrome (extensions page, Developer mode, Load unpacked)
- Run: load/reload the extension, then browse; real validation is the live browser run
- Test: `node tests/run-tests.js` and `node tests/integration-test.js`
- Lint: none configured; syntax-check changed JS with `node --check`
- Build: n/a — plain MV3 extension, no bundler
