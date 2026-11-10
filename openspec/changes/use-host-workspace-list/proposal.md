# Proposal

## Why

`redmine.locateWorkspace` finds the focused workspace's stable key and Orca project by running `orca worktree list` and `orca project list` through the CLI. When the CLI is not installed or not on the worker's PATH, or is slow, the panel cannot tell which workspace it is in: the task link and the "assign from branch" suggestion stop working (`orca_cli` / `workspace_not_listed`). Since host API 1.3 the worker can call `workspace.list`, which needs only `workspace:read` (already granted) and answers without spawning a process.

`workspace.list` returns `{ id, kind, name, path, branch, hostId }`. It does not say which Orca project a workspace belongs to, so the CLI is still needed for the Redmine project mapping and for creating worktrees.

## What Changes

- Find the focused workspace's key with `workspace.list` first, using the existing name/branch matching rule. The CLI listing is then used only to learn the Orca project, and is not required to get the key.
- If the CLI fails, the panel still knows the workspace: task links, the branch suggestion and "Send to agent" keep working. Only the project mapping is unavailable, and the panel says so instead of showing a general error.
- Gate (passed 2026-11-10: `id` is `identity:` + the stored key): this only ships if `workspace.list`'s `id` equals the key links are stored under today (the CLI's `identity.key`, else `id`). If it does not, existing links would be orphaned; the change then records the mapping rule found and stays CLI-first.
- No new capability, hook or command: can ship before 0.2.0 without re-approval.

## Capabilities

### New Capabilities
- `workspace-locate`: how the plugin identifies the focused Orca workspace and its Orca project, and how it degrades when the Orca CLI is unavailable.

### Modified Capabilities

## Impact

- `src/orca-workspaces.ts` (matching over `workspace.list` rows), `src/worker.ts` (`redmine.locateWorkspace`), `src/protocol.ts` (located result may have a null project with a reason), `src/panel.tsx` (message when only the project is unknown), tests.
- Also gives `add-launch-agent-here` (`findWorkspaceId`) and `add-workspace-create-hooks` (key mapping) the lookup they need.
