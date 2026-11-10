# Proposal

## Why

"Send to agent" types a one-line prompt into an existing terminal and leaves Enter to the user. It needs an open terminal with an agent already waiting, and it cannot carry the task context inline. Launching an agent in the current workspace today means creating a new workspace. Host API 1.3 offers `agent.launch`: it starts an agent CLI in a new terminal of a workspace and sends the prompt once the agent is ready.

## What Changes

- Add **Launch agent here** to the task's Agent section: starts the chosen agent (same picker as the new-workspace launch) in a new terminal of the focused workspace, with the same instructions + context prompt the new-workspace launch uses.
- Assign the task to the focused workspace when launching, if it has none (same as the new-workspace flow).
- Keep **Send to agent** unchanged (review-before-Enter, existing terminal).
- Request the `agent:launch` capability and raise `engines.orca` to `>=1.4.248`.

## Capabilities

### New Capabilities
- `agent-launch`: how the plugin starts agents for a Redmine task — in a new workspace (existing behaviour, now specified) and in the focused workspace (new) — and what prompt they receive.

### Modified Capabilities

## Impact

- `orca-plugin.json`: `agent:launch` capability (triggers re-approval) and `engines.orca` raised to `>=1.4.248`. The `agent.launch` method is host API 1.3, but the `agent:launch` capability is only read since Orca 1.4.248, so the engine bump is required (shared with the other 0.2.0 changes).
- `src/worker.ts`: `redmine.launchHere` handler; `src/protocol.ts`: request type; `src/panel.tsx`: button and agent picker reuse; `src/launch.ts`: reuse `buildLaunchPrompt`.
- Workspace id resolution: the focused workspace's id must be found (`workspace.list` matched by name/branch, or the CLI listing already used by `locateWorkspace`).
- README: Features and Permissions tables.
