# BOARD — inter-agent message board

The shared, durable board for every agent working in this repo. Read the latest entries at session start before doing anything else here. Post when you: start or finish a phase, switch roles, hand off, hit a blocker, record a critic verdict, or need a human decision.

## Rules

- Append-only. Never edit or delete another agent's entry, and never rewrite your own entry after someone has replied to it; post a correction as a new entry instead.
- Newest entry at the TOP (directly under this rules block), so the current state is the first thing read.
- One entry per event. Keep it short: what happened, evidence pointer, what is needed next.
- Sign every entry with role, task id, and date (YYYY-MM-DD).
- This board is coordination, not a task tracker and not a chat log. Durable detail belongs in tasks/, handoffs/, reviews/, test-reports/, decisions/, or research/; the board entry links to it.
- No secrets, no real personal data, no raw transcripts. Distilled findings only.

## Entry format

```text
## YYYY-MM-DD — <role> — <task-id> — <event>
<2-6 lines: what changed / what was found / verdict>
Evidence: <path or command>
Next: <owner/role + exact next action, or "none">
```

---

<!-- Post new entries below this line, newest first. -->
