# Proposal

## Why

Tasks are linked to workspaces only from the panel: the plugin's own launch assigns the task, and the panel offers to assign one when the branch contains a number. Workspaces created any other way (Orca's new-workspace dialog, the CLI, automations, other agents) stay unlinked until someone opens the panel, and their branch names follow no team convention. Orca 1.4.248 adds a `workspace.create.before` hook that runs for every creation, whatever starts it, and since 1.4.245 the `workspace.created` event tells the worker about every new worktree.

## What Changes

- **Branch convention (opt-in):** a `branchTemplate` setting (for example `{tracker}/{id}-{slug}`). When a workspace is being created and its name or branch names a Redmine task (`1234-…`, `#1234`, `redmine-1234`), the plugin rewrites the branch to the template. Empty template means no change, which is the default.
- **Automatic link:** after a workspace is created whose name or branch names a task that exists in Redmine, the task is assigned to it, as if chosen in the panel. Workspaces that already have a task are not touched.
- **Task update on creation (opt-in):** an `onWorkspaceCreated` setting: `nothing` (default), `comment` (adds "Work started in Orca workspace `<name>` (branch `<branch>`)" to the task), or `start` (the comment plus moving a New task to the first "in progress" status).
- The panel reads assignments from the store shared with the worker, so links made by the worker show up in the panel.
- Raise `engines.orca` to `>=1.4.248`.

## Capabilities

### New Capabilities
- `workspace-task-link`: how a workspace becomes linked to a Redmine task (panel, plugin launch, automatic detection at creation), the branch convention, and the optional task update when work starts.

### Modified Capabilities

## Impact

- `orca-plugin.json`: `contributes.hooks` (`workspace.create.before`), `contributes.events` (`workspace.created`, covered by the already granted `workspace:read`), `storage:own` capability, settings, engine bump. Re-approval needed (hook + capability).
- `src/worker.ts`, new `src/task-ref.ts` (task number detection, shared with the panel's existing branch suggestion), `src/launch.ts` (`slugify` reuse).
- `src/panel.tsx`: assignments move from panel-persisted atoms to worker storage (one-time migration).
- Redmine writes on creation only when the user opts in.
