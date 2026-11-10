# Design

## Context

`redmine.launchWorkspace` runs `orca worktree create --agent --prompt` through the CLI. `redmine.sendToAgent` calls `terminal.sendText` with `enter: false`. The panel knows the focused workspace's name, branch and terminals (`workspace.readContext`), and `redmine.locateWorkspace` resolves its stable key and Orca project through `orca worktree list`. `agent.launch` needs `{ workspaceId, agent, prompt }`.

## Goals / Non-Goals

**Goals:** one-click agent start in the current workspace with full context.

**Non-Goals:** replacing the CLI-based new-workspace launch (the CLI does creation + agent + comment in one step and is proven); changing Send to agent.

## Decisions

- **Workspace id from `workspace.list`.** Match the focused context by name + branch (same rule as `matchWorktree`) against `workspace.list` (needs only `workspace:read`, already granted). Alternative: use the CLI row's `id` — kept as fallback if the two ids turn out identical, which would let us reuse the cached listing. Verify on a dev load which id `agent.launch` accepts.
- **Prompt reuse.** Use `buildLaunchPrompt` with the panel's instructions field and comments mode, so both launches give the agent identical text. The prompt goes inline (not a file) because `agent.launch` submits it to the agent, not to a shell line.
- **Assignment in the panel.** The panel assigns the task (it owns `issueByWorkspace`), only if empty, after the worker reports success.
- **Capability gating in UI.** `orca.host.has('agent.launch')` hides the button on hosts without it.

## Risks / Trade-offs

- [New capability → users must re-approve] → ship with the other 0.2.0 changes.
- [`agent:launch` is a 1.4.248 capability → users on older Orca cannot update] → same engine floor as the hook and status bar changes in 0.2.0.
- [`agent.launch` returns as soon as the CLI starts; prompt delivery failures are not reported] → show "Agent started" rather than "Task sent".
- [Name/branch match ambiguity with duplicate names] → same disambiguation as `matchWorktree`; if no unique match, show `workspace_not_listed`.

## Open Questions

- ~~Whether `workspace.list` ids equal `orca worktree list` ids/`identity.key`.~~ Answered in `use-host-workspace-list`: `workspace.list` returns `id: "identity:" + identity.key` (checked 2026-11-10 on Orca 1.4.255: 38 of 38 local worktrees matched the CLI's `identity.key` and display name; listing not truncated). Still open: that `agent.launch` accepts this same `id` (expected, both are host API 1.3).
