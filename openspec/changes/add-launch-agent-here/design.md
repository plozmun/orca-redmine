# Design

## Context

`redmine.launchWorkspace` runs `orca worktree create --agent --prompt` through the CLI. `redmine.sendToAgent` calls `terminal.sendText` with `enter: false`. The panel knows the focused workspace's name, branch and terminals (`workspace.readContext`), and `redmine.locateWorkspace` resolves its stable key and Orca project through `orca worktree list`. `agent.launch` needs `{ workspaceId, agent, prompt }`.

## Goals / Non-Goals

**Goals:** one-click agent start in the current workspace with full context.

**Non-Goals:** replacing the CLI-based new-workspace launch (the CLI does creation + agent + comment in one step and is proven); changing Send to agent.

## Decisions

- **Workspace id from `workspace.list`.** Match the focused context by name + branch (same rule as `matchWorktree`) against `workspace.list` (needs only `workspace:read`, already granted). Alternative: use the CLI row's `id` — kept as fallback if the two ids turn out identical, which would let us reuse the cached listing. Verify on a dev load which id `agent.launch` accepts.
- **Prompt reuse.** Use `buildLaunchPrompt` with the panel's instructions field and comments mode, so both launches give the agent identical text. `agent.launch` caps `prompt` at 4096 characters (checked in Orca 1.4.257's host schema) and `agent` must be a TUI agent id Orca knows. When the prompt is longer, write the task context with `writeContextFile` (as Send to agent does) and send the instructions plus a pointer to that file instead of the inline context.
- **Assignment in the panel.** The panel assigns the task (it owns `issueByWorkspace`), only if empty, after the worker reports success.
- **Capability gating in UI.** A panel's `host.has(method)` answers for the panel's own surface, and `agent.launch` is a worker method, so the panel asks the worker (`redmine.launchHereSupport`) once and disables the button when the answer is false (hint: update Orca).

## Risks / Trade-offs

- [New capability → users must re-approve] → ship with the other 0.2.0 changes.
- [`agent:launch` is a 1.4.248 capability → users on older Orca cannot update] → same engine floor as the hook and status bar changes in 0.2.0.
- [`agent.launch` returns as soon as the CLI starts; prompt delivery failures are not reported] → show "Agent started" rather than "Task sent".
- [Name/branch match ambiguity with duplicate names] → same disambiguation as `matchWorktree`; if no unique match, show `workspace_not_listed`.

## Open Questions

- ~~Whether `workspace.list` ids equal `orca worktree list` ids/`identity.key`.~~ Answered in `use-host-workspace-list`: `workspace.list` returns `id: "identity:" + identity.key` (checked 2026-11-10 on Orca 1.4.255: 38 of 38 local worktrees matched the CLI's `identity.key` and display name; listing not truncated). Orca 1.4.257's host schema documents the `workspace.list` id as "what every other workspace method takes", so `agent.launch` takes the `identity:` form. Still to confirm on a dev load.
