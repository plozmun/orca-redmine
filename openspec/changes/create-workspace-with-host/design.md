# Design

## Create

`workspace.create { projectId, name, baseBranch?, agent?, prompt?, open }` → `{ workspaceId, terminalId? }`. `projectId` is the host repository id the picker now lists. `hostId` is omitted (the project's host). The worker links `keyFromHostId(workspaceId)` to the task before answering, so the panel and `workspace.created` agree; the `workspace.created` handler already skips a workspace that is linked.

The prompt limit and context file rules of "Launch agent here" apply (`fitsLaunchPrompt` / `contextFilePrompt`). An error that names the created workspace id (agent failed after creation) still links the workspace and reports the agent error.

## Open

`redmine.openWorkspace { issueId }` finds the linked key in the link store, its host id (`identity:<key>`), and calls `workspace.open`. The button only appears when `host.has('workspace.open')` (the worker answers, as for `launchHereSupport`).

## Capabilities

`workspace:create` and `workspace:write` are both new; one release asks once. `engines.orca` moves to `>=1.4.259` because older Orca refuses unknown capability kinds.
