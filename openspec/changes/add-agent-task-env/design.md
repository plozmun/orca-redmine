# Design

## Context

`agent.launch.before` gives `{ agent, workspaceId, workspaceKind, terminalId?, command, env }`, may change `command`/`env`. `agent.prompt.before` gives `{ agent, terminalId, prompt, inputKind }` — no workspace id. Hooks pass after 2 s or on throw (`onError: pass`). `writeContextFile` already writes `<tmp>/orca-redmine/<id>.md` with owner-only permissions. Links come from the shared store introduced in `add-workspace-create-hooks`.

## Goals / Non-Goals

**Goals:** task identity everywhere, fail-open, no secrets.

**Non-Goals:** passing the API key to redmine-cli (it keeps its own login); rewriting person-typed prompts; `agent.tool.*` hooks.

## Decisions

- **Decide fast, refresh in background.** In `agent.launch.before`: look up the link (storage, local), set the three id/URL variables, and set `REDMINE_CONTEXT_FILE` to the existing file path if one exists; then refresh the file in the background (fetch issue, rewrite) without awaiting. If no file exists yet, await the fetch with a 1.2 s budget. This keeps launches well under 2 s.
- **Workspace mapping for prompts.** `agent.prompt.before` has only `terminalId`. Remember `terminalId → task` from `agent.launch.before` (when it provides `terminalId`) for the worker's lifetime; fall back to the focused workspace's terminal list (`workspace.readContext`). Otherwise pass.
- **Only `inputKind: "launch"`.** Orchestration dispatches and `orca terminal send` are left alone to avoid polluting multi-agent messages.
- **Hint text.** `agent.cliHint` gains "`$REDMINE_ISSUE` holds the task number", only when the variable is set.

## Risks / Trade-offs

- [Every agent launch now waits on this plugin] → local-only path in the common case; fail-open.
- [Stale context file] → background refresh on each launch; the file header carries the fetch time.
- [`REDMINE_URL` reveals the instance URL to the agent] → acceptable: agents already get the task URL in prompts.

## Migration Plan

Ship with `add-workspace-create-hooks` (depends on its shared store).
