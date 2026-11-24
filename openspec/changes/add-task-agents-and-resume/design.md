# Design

## Agents of a task

`redmine.taskAgents { issueId }` → `{ workspaces: { key, name, agents: TaskAgent[] }[] }`.

1. Linked keys: every key in `ISSUE_BY_WORKSPACE` whose issue is `issueId`. A task can have several workspaces.
2. For each key: `agents.list({ workspaceId: "identity:" + key })`. A rejection (no workspace has that id, e.g. removed while Orca was closed) leaves that workspace out and is logged. It does not fail the request.
3. `TaskAgent = { terminalId, title, agent, state, stateStartedAt }`, the host row minus `task` and `sessionId`. The panel needs neither.

Calls are made in parallel, at most 5 linked workspaces per task, newest links first. The panel calls the request when the detail opens and, debounced 1.5 s, on `agent.status.changed` when the event's `workspaceListId` is one of the task's keys. It reuses the timer pattern of `agentStatesSoon`.

## Show an agent

`redmine.showAgent { terminalId }` → `terminal.focus { terminalId }` → `{ focused }`. The worker refuses any `terminalId` that the last `redmine.taskAgents` answer did not include, so the panel cannot focus arbitrary terminals. The button is gated by `redmine.agentActionsSupport` → `{ show: has('terminal.focus') && granted('workspace:write'), resume: has('agent.resume') }`.

## Resume

When `agent.status.changed` records an `agentDone` follow-up, the worker also stores:
- `workspaceId`: the event's `workspaceListId` (host id).
- `sessionId`: from the event (host API 1.8).
- `agent`: the kind, which the event does not carry. The worker finds it with `agents.list({ workspaceId })` by matching `terminalId` (or `sessionId`). If no row matches, or the kind is not one `agent.resume` accepts, `agent` is left out.

Resuming needs all three. `redmine.resumeAgent { followupId }` reads the follow-up from storage, not from the panel, and calls `agent.resume { workspaceId, agent, sessionId }` → `{ terminalId, started }`. If `started` is false, the panel says "Already running" and calls `redmine.showAgent` with that terminal. A host error maps to `RedmineError('agent_resume')`.

The follow-up is not dismissed. Resuming does not update Redmine, and the next "done" replaces the follow-up anyway (one per task and kind).

Old follow-ups stored by 0.2.x have none of the three fields and simply show no "Resume" button. `asFollowups` keeps validating them.

## Risks / Trade-offs

- [`agents.list` for each linked workspace on every status change] → debounced, only for the open task's keys, at most 5.
- [Session ids in plugin storage] → they are Orca's local ids, not credentials. The panel shows them nowhere.
- [The agent kind can be missing for agents launched outside Orca's known kinds] → no Resume button, and the rest of the follow-up works.
