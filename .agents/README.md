# .agents/ — repository-local agent assets

Repository-local instructions, coordination state, and evidence for AI agents working here. Vendor-neutral Markdown; any agent client that can read files can use it. It is a file convention, not a runtime: nothing here runs agents automatically, and reading a file does not change any client's permissions.

## Layout

```text
.agents/
├── README.md          # this file
├── POLICY.md          # safety, authority, secrets, git rules that no role may override
├── BOARD.md           # inter-agent message board (append-only)
├── status.json        # current task/phase/roles/blockers, machine-readable
├── roles/
│   ├── builder/       # AGENTS.md + memory/MEMORY.md
│   └── critic/        # AGENTS.md + memory/MEMORY.md
├── workflows/         # 01-research, 02-plan-design, 03-build, 04-test, 05-critic-review, handoff
├── templates/         # task, handoff, research-note, test-report, critic-review, ADR, board-entry
├── scripts/           # maintenance utilities (clean_board.py bounds BOARD.md; dry-run default)
├── board-archive/     # BOARD-YYYY-MM.md monthly archives written by clean_board.py (created on first run)
├── tasks/             # one file per task (goal, non-goals, acceptance criteria, checks, result)
├── research/          # dated research notes with sources
├── decisions/         # ADRs (architecture/design decision records)
├── handoffs/          # structured role-to-role handoffs
├── reviews/           # critic reviews and merge/done recommendations
├── test-reports/      # verification evidence, failures, skipped checks, coverage gaps
├── risks/             # blockers, conflicts, human-decision requests
└── scratch/           # temporary notes, NOT durable truth (git-ignored except .gitkeep)
```

## Responsibility model

Put each rule at the narrowest layer that can enforce it, then reference it; do not duplicate a rule into every layer.

- Policy (POLICY.md): invariants that apply to every role and every task.
- Role (roles/<role>/AGENTS.md): what one responsibility owns, what it must never do, and how it hands off.
- Workflow (workflows/*.md): the ordered steps and gates for one phase of work, spanning roles where needed.
- Skill/template (templates/*.md): the exact shape of one artifact (a task file, a review, a report). Fill it in; do not improvise a new shape per task.
- Memory (roles/<role>/memory/MEMORY.md): current, verified facts and lessons for that role, with date and evidence. Concise. Superseded entries are marked `superseded`, not silently deleted in the working tree.
- Artifact folders (tasks/, reviews/, test-reports/, decisions/, research/, handoffs/, risks/): the durable, reviewable evidence of work actually done.

## Loading policy

Progressive disclosure. Start from the root AGENTS.md and the current task. Load the role file for the role you are in, then the workflow for the current phase. Load an artifact only when the task needs it. Loading everything “to be safe” pollutes context and is explicitly not the standard.

## Change policy

When agent behavior fails in a repeatable way: capture it (risks/ or a board post), classify the root cause, make the smallest change to the responsible policy/role/workflow/template, and keep a regression note in the relevant workflow or memory so the failure stays fixed. An incident is historical evidence, not a new standing instruction.

## status.json contract

Fields: `current_task` (task id or null), `phase` (one of: idle, research, plan, build, test, review, blocked, done), `branch` (string or null), `roles` ({builder, critic}: agent/role holder name or null when unassigned), `blockers` (list of short strings), `last_board_entry` (one-line summary or null), `updated` (ISO date YYYY-MM-DD or null). Keep it valid JSON; update it on every phase change, handoff, and board post.

## Token budget

Session start should cost roughly: root AGENTS.md + one role file + the tail of BOARD.md (about 1,500 words). Load workflows and artifacts on demand per phase; never load all of .agents/ at once.
