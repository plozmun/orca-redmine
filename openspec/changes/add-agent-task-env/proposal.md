# Proposal

## Why

An agent started in a linked workspace only knows its task if the plugin wrote the prompt. Agents opened from Orca's own "new tab", automations or orchestration get nothing, and redmine-cli has to be told the task number in every prompt. Orca 1.4.248's `agent.launch.before` hook runs for every agent start and can add environment variables; `agent.prompt.before` can rewrite prompts Orca submits.

## What Changes

- For every agent started in a workspace linked to a task, add environment variables: `REDMINE_ISSUE` (number), `REDMINE_ISSUE_URL`, `REDMINE_URL` (base), and `REDMINE_CONTEXT_FILE` (path to the task context file, refreshed at launch). No API key is ever exported.
- Mention these variables in the redmine-cli hint so agents can use them.
- **Optional prompt pointer (off by default):** setting `promptPointer`. When on, prompts Orca submits as a *launch* to an agent in a linked workspace get one line appended pointing to the context file, unless the prompt already mentions that task.
- Raise `engines.orca` to `>=1.4.248` (shared with the other hook changes).

## Capabilities

### New Capabilities
- `agent-task-context`: what an agent started in a linked workspace receives about its task without the plugin writing its prompt (environment, context file, optional prompt pointer), and what is never shared.

### Modified Capabilities

## Impact

- `orca-plugin.json`: `contributes.hooks` (`agent.launch.before`, `agent.prompt.before`), `promptPointer` setting. Depends on the shared link store from `add-workspace-create-hooks` (`storage:own`).
- `src/worker.ts`, `src/agent-files.ts` (context file writer reused), `src/launch.ts` (hint text).
- Every agent start in Orca waits for this plugin's hook (bounded by 2 s, fails open).
