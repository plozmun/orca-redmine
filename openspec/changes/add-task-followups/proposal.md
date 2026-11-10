# Proposal

## Why

The plugin starts agents and links workspaces to tasks, but it stops paying attention afterwards. When an agent finishes the work, nothing reminds the user to update Redmine (comment, status, time), so tasks fall behind the code. When a workspace is removed, its link stays in storage forever and the task stays open in Redmine with no prompt to close it or log the time spent. Orca already delivers the needed signals to plugin workers: `agent.status.changed` (since 1.4.160, `agent:read`) and `workspace.removed` (since 1.4.245, `workspace:read`, already granted).

## What Changes

- **Agent follow-up:** when the main agent of a workspace linked to a task finishes (`done`, with a success or failure outcome) or gets blocked waiting for the user, the worker records a follow-up for that task. The panel shows pending follow-ups at the top of the task list, each with one-click actions: open the task, comment, change status, log time (pre-filled with the agent's working time, rounded to 0.25 h). Nothing is written to Redmine without a click.
- **Optional notification (off by default):** setting `agentNotification` (`off`, `done`, `doneAndBlocked`). When on, a desktop notification names the task (`#4077 Agent finished: <subject>`).
- **Workspace removal clean-up:** when a linked worktree workspace is removed, the worker deletes its link and records a follow-up offering to close the task (status picker limited to closed statuses), log time, or dismiss.
- Follow-ups are kept in worker storage (at most 20, oldest dropped, dismissed ones removed) so they survive the panel being closed and Orca restarting.

## Capabilities

### New Capabilities
- `task-followups`: what the plugin records when an agent working on a linked task finishes or blocks, or when a linked workspace is removed; how follow-ups are shown, acted on and dismissed; and the optional notification.

### Modified Capabilities

## Impact

- `orca-plugin.json`: `contributes.events` (`agent.status.changed`, `workspace.removed`), capabilities `agent:read` and `notifications:show`, setting `agentNotification`. Re-approval needed: ship in 0.2.0 with the other changes. No engine bump beyond the 0.2.0 floor (`>=1.4.248`).
- Depends on the shared link store and the `workspaceId` ↔ link key mapping from `add-workspace-create-hooks` (`storage:own`).
- `src/protocol.ts` (follow-up requests and event), `src/worker.ts` (event handlers, follow-up store), `src/panel.tsx` (follow-up strip), new pure helper `src/followups.ts`, `src/i18n/*`, README (Features, Settings, Permissions).
