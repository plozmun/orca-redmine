# Proposal

## Why

Recent Orca (host API 1.7; 1.4.271 is at 1.10) answers through the plugin host what the worker still asks the `orca` CLI for, and names workspaces in its events with the same id `workspace.list` uses:

- `workspace.list` rows carry `projectId` and `project`; `project.list` lists projects (repositories and folders) with the same ids. Both need only `workspace:read`, which the plugin already has.
- `workspace.created`, `workspace.removed` and `agent.status.changed` carry `workspaceListId`, and `workspace.changed` / `workspace.readContext` carry the focused `workspaceId`.
- `workspace.list` takes `includeStatus` and returns each workspace's agent state (`working`, `permission`, `done`, `active`, `inactive`, plus `unread`).

Today the Orca project of a workspace, the project picker for new workspaces and part of the event handling go through `orca worktree list` / `orca project list` (15 s cache, fails without the CLI on the worker's PATH and for SSH hosts) and through id-shape guesses (`pathFromCliId`, an alias map). The task list cannot tell which linked task has an agent working on it.

## What Changes

- **Orca project from the host.** Locating the focused workspace takes its key, Orca project id and name from `workspace.list` (matched by the focused `workspaceId` when Orca gives it, else by name and branch as now). The CLI is only the fallback for older Orca.
- **Project ids.** The host names a project by its repository id (`f867aa90-…`); the CLI names the logical project (`git:host/path`, with `sourceRepoIds`). Mappings are stored under the host id from now on. Existing mappings under CLI ids are copied once to each of their `sourceRepoIds` (CLI needed for that one step; they were created with it). Old keys are kept, so going back to 0.2.0 still works.
- **Project picker from the host.** "Launch agent → New workspace" lists Git projects from `project.list` (hidden ones left out). Creating the worktree still uses `orca worktree create`, which gets the CLI project id the picked repository belongs to.
- **Event ids.** Workspace and agent events use `workspaceListId` when present; the alias map and CLI lookup remain for older Orca.
- **Agent state in the task list.** A task whose linked workspace has an agent working, waiting for permission, or done and unread shows a small badge in its row. Read with `workspace.list { includeStatus: true }` when the list loads and when agent status changes (debounced). Nothing is written to Redmine.

No new capabilities, hooks, events or settings: the update needs no re-approval.

## Capabilities

### New Capabilities
- `agent-status-in-list`: the agent state of linked workspaces in the task list.

### Modified Capabilities
- `workspace-locate`: the Orca project comes from the host; mappings are keyed by the host project id.

## Impact

- `src/orca-workspaces.ts` (host row with `projectId`/`project`, id matching, project key migration helper), `src/worker.ts` (locate, events, `redmine.orcaProjects`, `redmine.agentStates`, CLI id translation at creation), `src/protocol.ts`, `src/panel.tsx`, i18n, tests, check scenario, README (CLI section).
- `engines.orca` unchanged (`>=1.4.248`): every new host field is optional and checked before use.
