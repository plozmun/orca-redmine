# Proposal

## Why

Orca's sidebar shows a workspace by its branch-derived name (`4077-checkout`), which says little about the task. Orca 1.4.257 (host API 1.5) adds `workspace.rename` (worker, capability `workspace:write`), the same as renaming by hand.

## What Changes

- In the task detail's workspace bar, when the focused workspace is linked to the task, a "Rename workspace" action renames it to a name built from the task (default `{id} {subject}`, e.g. `4077 Checkout with saved cards`), cut to 200 characters. Explicit click only; never automatic for existing workspaces.
- Setting `workspaceNameTemplate` (string, default empty = `{id} {subject}`; placeholders `{id} {subject} {tracker} {project}`).
- For workspaces the plugin creates ("New workspace"), the `workspace.create.before` hook already may set `name`; out of scope here (Orca names them from the branch, which already carries the number).
- The new name keeps the task number first, so `taskRef` still detects it.

## Capabilities

### New Capabilities
- `workspace-rename`: renaming the focused, linked workspace after its task.

## Impact

- `orca-plugin.json`: capability `workspace:write` (one more re-approval; ship in the same release as the other 0.2.0 capabilities), setting `workspaceNameTemplate`.
- `src/worker.ts` (`redmine.renameWorkspace` request; `orca.host.has('workspace.rename')` gate), `src/protocol.ts`, `src/panel.tsx`, i18n, README.
