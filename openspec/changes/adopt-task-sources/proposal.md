# Proposal

> **Blocked on Orca.** `contributes.taskSources` is reserved and must stay empty until Orca defines its format (plugin-manifest.md, "Planned contribution points"). This change records the intent and the behaviour to keep; its design and tasks are revisited when the format ships.

## Why

Orca's native integrations (GitHub, GitLab, Jira, Linear) appear in Orca's own task views, new-workspace picker and workspace links. Redmine can only appear in a plugin panel, and Orca rejects Redmine URLs as workspace references. Orca plans `taskSources`: "issue and task providers such as Asana, Linear or Jira, declared as data that a worker fills with tasks". That is this plugin's core use case.

## What Changes

- Declare Redmine as a task source so its tasks appear wherever Orca lists tasks (task views, the new-workspace picker), with Orca's native linking instead of the plugin's own store.
- Fill the source from the worker using the existing Redmine client (filters: assigned to me, project mapping, status).
- Keep the panel for Redmine-specific actions Orca's task UI may not cover (time entries, status picker, comments), and drop panel features Orca then provides natively.
- Migrate existing workspace links (plugin store) to Orca's native links where the format allows.

## Capabilities

### New Capabilities
- `native-task-source`: Redmine tasks offered through Orca's task-source contribution, and how they map to Orca's native task fields and workspace links.

### Modified Capabilities

## Impact

- Manifest (`contributes.taskSources`), worker, possibly a large reduction of `src/panel.tsx`.
- Workspace link storage and the `workspace-task-link` capability once native links exist.
- Engine bump to the Orca version that ships the format.
