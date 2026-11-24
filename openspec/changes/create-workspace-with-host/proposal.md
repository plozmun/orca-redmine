# Proposal

## Why

"Launch agent → New workspace" runs `orca worktree create` (up to 115 s, needs the CLI on the worker's PATH, local projects only) and then relies on the CLI's output shape. Orca 1.4.259+ (host API 1.8) offers `workspace.create` (capability `workspace:create`; with `agent`, also `agent:launch`): it creates the worktree in a Git project, local or SSH, runs the project's setup and Orca's hooks, and starts the agent with the prompt once setup is done.

Separately, a task's workspace can only be reached by finding it in Orca's sidebar. With `workspace:write`, `workspace.open` shows it in one press. The same capability is what `add-rename-workspace-to-task` needs, so both ship together in one re-approval.

Release 0.3.0 also uses `agents.list({ workspaceId })`, host API 1.10 (`add-task-agents-and-resume`). The floor is therefore Orca 1.4.260, and every Orca that can install 0.3.0 has `workspace.create`. A CLI fallback for creating workspaces would never run, so it is removed instead of kept.

## What Changes

- **Create with the host only.** "New workspace" calls `workspace.create` with the host project id (the picker's ids since `use-host-projects-and-status`), the task's workspace name, base branch, agent and prompt, and `open` from "Open when created". The returned `workspaceId` is linked to the task. `orca worktree create` and its parsing are removed; the Orca CLI is no longer needed to create a workspace, and SSH projects work.
- **Project picker from the host only.** `project.list` (host API 1.7) is always there from 1.4.260, so the picker's CLI fallback goes too.
- **Go to the workspace.** The task detail (when the task is linked to a workspace other than the focused one) and the follow-up cards (agent finished) get "Go to workspace", which calls `workspace.open`.
- **Rename** (`add-rename-workspace-to-task`) and **task agents and resume** (`add-task-agents-and-resume`) ship in the same release.
- **Out of scope.** The Orca CLI stays for what the host API does not cover yet: opening the panel from the status bar (`orca plugin open`), moving project mappings saved before 0.2.1 to host ids, and finding a workspace when the host listing is truncated.

## Capabilities

### New Capabilities
- `workspace-create`: creating a task workspace through Orca's host API.
- `workspace-open`: jumping to a task's workspace from the panel.

## Impact

- `orca-plugin.json`: capabilities `workspace:create`, `workspace:write`; `engines.orca` `>=1.4.260` (host API 1.10, the newest minor 0.3.0 uses). One re-approval, version 0.3.0.
- `src/orca-workspaces.ts`: remove `createWorktree`, `createWorktreeArgs`, `parseCreated` and their tests. `src/worker.ts`: remove `setOrcaCreator` and the picker's CLI fallback; add `redmine.openWorkspace`. Also `src/protocol.ts`, `src/panel.tsx`, i18n, tests, README (Permissions, Features, Requirements, CLI).
