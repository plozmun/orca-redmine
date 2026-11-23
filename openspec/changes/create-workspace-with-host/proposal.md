# Proposal

## Why

"Launch agent → New workspace" runs `orca worktree create` (up to 115 s, needs the CLI on the worker's PATH, local projects only) and then relies on the CLI's output shape. Orca 1.4.259+ (host API 1.8) offers `workspace.create` (capability `workspace:create`; with `agent`, also `agent:launch`): it creates the worktree in a Git project, local or SSH, runs the project's setup and Orca's hooks, and starts the agent with the prompt once setup is done.

Separately, a task's workspace can only be reached by finding it in Orca's sidebar. With `workspace:write`, `workspace.open` shows it in one press. The same capability is what `add-rename-workspace-to-task` needs, so both ship together in one re-approval.

## What Changes

- **Create with the host.** When `host.has('workspace.create')`, "New workspace" calls it with the host project id (the picker's ids since `use-host-projects-and-status`), the task's workspace name, base branch, agent and prompt, and `open` from "Open when created". The returned `workspaceId` is linked to the task. The CLI path remains for older Orca.
- **Go to the workspace.** The task detail (when the task is linked to a workspace other than the focused one) and the follow-up cards (agent finished) get "Go to workspace", which calls `workspace.open`.
- **Rename** (`add-rename-workspace-to-task`) ships in the same release.

## Capabilities

### New Capabilities
- `workspace-create`: creating a task workspace through Orca's host API.
- `workspace-open`: jumping to a task's workspace from the panel.

## Impact

- `orca-plugin.json`: capabilities `workspace:create`, `workspace:write`; `engines.orca` `>=1.4.259` (first Orca with `workspace:create`). One re-approval, version 0.3.0.
- `src/worker.ts` (`redmine.launchWorkspace`, `redmine.openWorkspace`), `src/protocol.ts`, `src/panel.tsx`, i18n, tests, README (Permissions, Features, CLI).
