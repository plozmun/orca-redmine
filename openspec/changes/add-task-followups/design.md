# Design

## Context

`agent.status.changed` payload: `{ workspaceId | null, paneKey, terminalId?, title?, state, receivedAt, mainAgent?: { state, outcome?, stateStartedAt } }`. It needs `agent:read` and an entry in `contributes.events` (at most 4 events; this change uses 2, and `add-workspace-create-hooks` uses `workspace.created`: 3 of 4). `workspace.removed` payload: `{ workspaceId, kind, path }`, worktrees only. Links live in worker storage keyed by the workspace's stable key (`add-workspace-create-hooks`). The worker only runs while something keeps it alive; with `statusBarItems` (`add-status-bar-counter`) it runs while the plugin is enabled, and event delivery starts it otherwise.

## Goals / Non-Goals

**Goals:** never lose the moment to update Redmine after agent work; no orphan links; no Redmine writes without a click.

**Non-Goals:** writing comments or statuses automatically; summarising the agent's work (would need `terminal:read` and sending terminal output to Redmine, which is a privacy risk); follow-ups for agents in unlinked workspaces; folder workspaces.

## Decisions

- **Main agent only.** Use `mainAgent.state` when present, else `state`. Record a follow-up on the transition into `done` with outcome `success`, `failure` or `unconfirmed`; skip `cancellation`, `superseded` and `interruption` (the user stopped it and is already looking). Record `blocked` only for the notification, not as a follow-up, since the user must answer the agent first.
- **Working time.** Keep `paneKey → first working receivedAt` in memory for the worker's life; on `done`, hours = (done − first working) rounded to 0.25, at least 0.25. If the worker started mid-run (no working seen), leave the hours field empty rather than guess.
- **De-duplication.** One pending follow-up per task and kind: a new `agentDone` for the same task replaces the older one (keeps the latest time), so a chatty agent does not fill the list.
- **Store shape.** Storage key `followups`: `{ id, kind: 'agentDone' | 'workspaceRemoved', issueId, workspaceName, at, hours? }[]`, max 20. No user-facing text is stored; the panel builds text with `t()`. Requests `redmine.followups.get` and `redmine.followups.dismiss({ id })`; the worker posts `redmine.followupsChanged` after each write.
- **Acting completes the follow-up.** Any action taken from a follow-up (comment, status, time) dismisses it after success; opening the task does not.
- **Removal flow.** On `workspace.removed`, resolve the key, read the link, delete it, record `workspaceRemoved`. The "Close task" action reuses the status picker filtered to `is_closed: true`.
- **Notification text.** The worker has no panel locale; it uses the system locale like the palette command does (`systemLocale()`), and only the task number and subject, never description text.

## Risks / Trade-offs

- [Two more capabilities → re-approval] → ship in 0.2.0 with the other capability changes.
- [Orca already shows its own "agent done" notification] → ours is off by default; the follow-up in the panel is the Redmine-specific value.
- [Events missed while the worker was not running] → acceptable; without the status bar item the worker may not be alive. Document that the status bar item keeps it running.
- [`workspaceId` null for some panes] → ignored.

## Migration Plan

New storage key only; nothing to migrate. Rollback leaves an unused `followups` key.

## Open Questions

- Whether `agent.status.changed` fires when the worker is not already running (event-started worker). Checked on a dev load with `orca plugin dev emit` and a real agent; changes only the README note.
