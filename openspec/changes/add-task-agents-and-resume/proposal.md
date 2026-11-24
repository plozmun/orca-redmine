# Proposal

## Why

The task list shows one badge per linked task ("Agent working", "Agent done"), drawn from `workspace.list` status. To see which agents are on a task, what state they are in, and to go to one, the user has to leave the panel and find the workspace in Orca's sidebar. When an agent on a task finishes, the follow-up card offers Redmine actions, but continuing the same agent conversation means finding its terminal or Orca's session history.

Host API 1.10 (Orca 1.4.260) lets the worker call `agents.list({ workspaceId })` for any workspace, not only the focused one. Host API 1.8 adds `sessionId` to `agent.status.changed` and `agent.resume`. Both use capabilities the plugin already has (`agent:read`, `agent:launch`). Going to an agent's terminal (`terminal.focus`) needs `workspace:write`, which 0.3.0 adds anyway for `create-workspace-with-host`. This change therefore adds no re-approval of its own.

## What Changes

- **Agents in the task detail.** When the task is linked to one or more workspaces, the detail shows an "Agents" section: per linked workspace, its agents with kind, terminal title, state (working, needs input, waiting, done) and how long in that state. It refreshes on `agent.status.changed` while the panel is open, at most every 1.5 s, as the list badges do.
- **Show an agent.** Each agent row has "Show", which focuses its terminal (`terminal.focus`) and so its workspace. It is hidden when the agent has no terminal id or `workspace:write` was not approved.
- **Resume from a follow-up.** An "agent finished" follow-up remembers the workspace's host id, the agent kind and the session id. It offers "Resume agent", which calls `agent.resume` in that workspace. When Orca says the session is already running in a terminal, the panel says so and focuses it. The follow-up stays until dismissed or acted on, as now.
- **Agent context stays English, UI strings in en/es.** No task text is sent anywhere new: `agent.resume` takes no prompt.

## Capabilities

### New Capabilities
- `task-agents`: listing and showing the agents working in a task's linked workspaces from the task detail.

### Modified Capabilities
- `task-followups`: "agent finished" follow-ups can resume the agent's session.

## Impact

- No new capability or hook. `engines.orca >=1.4.260`, set by `create-workspace-with-host` in the same 0.3.0 release.
- `src/followups.ts` (optional `workspaceId`, `agent`, `sessionId` on `agentDone`; old stored follow-ups without them stay valid). `src/worker.ts`: `redmine.taskAgents`, `redmine.showAgent`, `redmine.resumeAgent`, and the session captured in the `agent.status.changed` handler. Also `src/protocol.ts`, `src/panel.tsx`, i18n, tests, check scenarios, README (Features).
