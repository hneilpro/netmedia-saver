# Workflow 03 — Build / Update

Goal: the smallest complete change that passes the plan's acceptance criteria, delivered turnkey.

Before editing, run: `git status`, `git branch --show-current`, `git log --oneline -5`. Confirm the task, branch, and that the worktree is clean or that existing changes are understood. One writer at a time (see POLICY.md).

Steps:
1. Implement in the repo's existing style and architecture. Match naming, structure, and error-handling patterns already present; divergence needs a reason in the handoff.
2. Keep the diff focused. Unrelated fixes discovered along the way go to the board or a new task, not into this diff.
3. Add or update tests for the behavior you changed, in the same change.
4. Spell out every dependency in the handoff: new imports/packages (with versions where it matters), config, migrations, environment variables, and manual steps. The deliverable must be usable without diagnosis homework by the owner.
5. Config and version gotchas: pin choices to the versions actually installed in this repo/environment, not the latest documented ones. The workflow/schema version fields in config files are format versions unless the project says otherwise; do not bump them to match a release name.
6. Reproduce-before-fix for bugs: a failing test or a scripted reproduction first, then the fix, then the same check green. “I see the bug in the code” is not a reproduction.
7. Before handoff, run: `git status`, `git diff`, `git diff --stat`. Read your own diff end to end once, as a stranger.

Gate:
- Diff is scoped and self-reviewed.
- Dependencies are spelled out.
- Nothing secret or personally identifying is in the diff (placeholders only).
- Ready to hand to Test as one coherent unit.
