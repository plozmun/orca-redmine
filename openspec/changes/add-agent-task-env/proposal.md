# Proposal

## Why

An agent started in a linked workspace only knows its task if the plugin wrote the prompt. Agents opened from Orca's own "new tab", automations or orchestration get nothing. Orca 1.4.248's `agent.launch.before` hook runs for every agent start and can add environment variables; `agent.prompt.before` can rewrite prompts Orca submits.

## What Changes

- For every agent started in a workspace linked to a task, add **one** environment variable: `REDMINE_ISSUE` (the task number). Scripts, git hooks, status lines and the agent itself can read it; `redmine issues get $REDMINE_ISSUE` gives the rest. No URL, no file, no credential is exported.
- The hook only reads the local link store: no network call, so it never slows an agent start.
- **Optional prompt pointer (off by default):** setting `promptPointer`. When on, launch prompts Orca submits to an agent in a linked workspace get one line naming the task (`#N`, subject, URL), unless the prompt already names it.
- The redmine-cli hint in the plugin's own prompts mentions `$REDMINE_ISSUE`.

### Reduced from the first draft

The first draft exported four variables (`REDMINE_ISSUE`, `REDMINE_ISSUE_URL`, `REDMINE_URL`, `REDMINE_CONTEXT_FILE`). Dropped because:
- `REDMINE_URL` and `REDMINE_ISSUE_URL` are derivable, and `REDMINE_*` is redmine-cli's own namespace (`REDMINE_SERVER`, `REDMINE_API_KEY`, `REDMINE_DEFAULT_PROJECT`…): a look-alike `REDMINE_URL` invites confusion with its configuration.
- `REDMINE_CONTEXT_FILE` needed a Redmine fetch on every agent start (orchestration starts many), put untrusted task text in a temp file nobody asked for, and went stale; the env is frozen at launch anyway.
- Environment variables are inherited by every child process of the agent (builds, tests, servers), so fewer is better.

## Capabilities

### New Capabilities
- `agent-task-context`: what an agent started in a linked workspace receives about its task without the plugin writing its prompt, and what is never shared.

## Impact

- `orca-plugin.json`: `contributes.hooks` (`agent.launch.before`, `agent.prompt.before`), `promptPointer` setting. Uses the shared link store (`storage:own`) from `add-workspace-create-hooks`.
- `src/worker.ts`, `src/launch.ts` (hint text), i18n hint strings.
