# Workflow — Handoff

Goal: the next agent (or the critic, or the owner) can continue without re-discovering anything.

A handoff is required: builder to critic (before review), any role to any role mid-task, and any agent ending a session with work in flight.

Steps:
1. Create `.agents/handoffs/YYYY-MM-DD-<task-id>-<from>-to-<to>.md` (template: handoff).
2. Include: task id and goal, branch and worktree, exact files changed, what was verified and how (link the test report), what is unverified and why, known risks, open decisions for the owner, and the single exact next action.
3. Update `.agents/status.json` (current task, phase, roles, blockers).
4. Post a board entry linking the handoff. The board entry is the pointer; the handoff file is the substance.

A handoff that says “works, see code” without verification evidence is incomplete. The receiving agent should say so on the board and treat the work as unverified until evidence exists.
