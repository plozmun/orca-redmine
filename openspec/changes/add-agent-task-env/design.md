# Design

## Context

`agent.launch.before` gives `{ agent, workspaceId, workspaceKind, terminalId?, command, env }` and may change `command`/`env`. `agent.prompt.before` gives `{ agent, terminalId, prompt, inputKind }`, with no workspace id. Hooks pass after 2 s or on a throw. Links live in plugin storage under `links.issueByWorkspace`, keyed by workspace identity key (`AssignedIssue { id, subject }`).

## Decisions

- **Local only.** The launch hook resolves the workspace key and reads the link from storage; it never calls Redmine. Key resolution: `keyFromHostId(workspaceId)` for the `identity:` form; for the CLI form (`<repoId>::<path>`) use `workspace.list` (match by id or path), as `describeCreated` does for `workspace.created`. If no key or no link, return `next(event)` unchanged.
- **Merge env.** `env: { ...event.env, REDMINE_ISSUE: String(id) }`. An existing `REDMINE_ISSUE` in `event.env` is kept (the launcher chose it).
- **Prompt pointer.** Remember `terminalId → { id, subject }` from `agent.launch.before` when `terminalId` is given (in memory, worker lifetime, capped at 200 entries). In `agent.prompt.before`, only for `inputKind: "launch"`, setting on, terminal known, and the prompt not already containing `#N` or the task URL: append `\n\nRedmine task #N "subject": <url>` (English, as task context for agents). No fallback to the focused workspace: a wrong guess is worse than none.
- **Hint text.** `agent.cliHint` gains a sentence about `$REDMINE_ISSUE`.

## Risks / Trade-offs

- [Env is frozen at launch: re-linking the workspace does not update a running agent] → documented.
- [An agent never looks at env by itself] → the variable mainly serves scripts and the hint; the prompt pointer covers agents that need telling.
