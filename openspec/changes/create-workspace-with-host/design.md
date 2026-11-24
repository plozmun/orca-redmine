# Design

## Create

`workspace.create { projectId, name, baseBranch?, agent?, prompt?, open }` → `{ workspaceId, terminalId? }`. `projectId` is the host repository id the picker now lists. `hostId` is omitted (the project's host). The worker links `keyFromHostId(workspaceId)` to the task before answering, so the panel and `workspace.created` agree; the `workspace.created` handler already skips a workspace that is linked.

The prompt limit and context file rules of "Launch agent here" apply (`fitsLaunchPrompt` / `contextFilePrompt`). An error that names the created workspace id (the agent failed after creation) still links the workspace and reports the agent error.

Errors: a host refusal maps to a `RedmineError` code (`workspace_create`, with the host reason as detail for the log), not to user text. `orca_cli` no longer comes from this flow.

## No CLI fallback

`engines.orca >=1.4.260` guarantees host API 1.10, so `workspace.create` (1.8) and `project.list` (1.7) are always offered to the worker. The worker still checks `host.has()` once. If a method is missing, which would mean a broken host, it throws `workspace_create_unavailable` instead of running the CLI. Removed: `createWorktree`, `createWorktreeArgs`, `parseCreated`, `setOrcaCreator`, the 115 s timeout, and the picker's `orcaLister().projects` branch.

Kept on the CLI, each with its own reason:
- `orca plugin list/open` for the status bar's "open panel": there is no host method to reveal a panel.
- `migrateProjectKeys`: mappings saved before 0.2.1 are keyed by CLI project ids. This runs once per install and is already guarded by a flag.
- `locateWithCli`/`describeWorktree`: used when the host listing is truncated or does not name the workspace.

## Open

`redmine.openWorkspace { issueId }` finds the linked key in the link store and calls `workspace.open { workspaceId: "identity:" + key }`. The button only appears when `host.has('workspace.open')` and the user approved `workspace:write` (the worker answers, as for `launchHereSupport`).

## Capabilities

`workspace:create` and `workspace:write` are both new. Shipping them in one release means users approve once. `engines.orca` moves to `>=1.4.260`. `workspace:create` needs 1.4.259 (older Orca refuses unknown capability kinds), and `agents.list({ workspaceId })` from `add-task-agents-and-resume` needs host API 1.10 (Orca 1.4.260).

## Risks / Trade-offs

- [Users on Orca 1.4.248–1.4.259 stop getting updates] → they stay on 0.2.1, which keeps working. Orca auto-updates, and 1.4.260 has been out since 2026-11-15.
- [Without the CLI, a worker that times out cannot recover the half-created workspace] → `workspace.create` names the id in its error; we link it and report.
