# Tasks

## 1. Shared link store

- [x] 1.1 Add `storage:own`; links in plugin storage (`src/links.ts`), read and written by the worker with `orca.storage` and by the panel with `persist: 'storage'` atoms (no `redmine.links.*` requests needed)
- [x] 1.2 Switch the panel to the worker store, with the one-time copy from the `redmine.issueByWorkspace` and `redmine.projectByOrcaProject` atoms (atoms kept read-only this release); verify migration and no-loss-on-failure in `src/panel.test.tsx`
- [x] 1.3 Add `src/task-ref.ts` with the detection rule, replace the panel's branch-number suggestion with it, and cover every spec example in a unit test

## 2. Hooks

- [x] 2.1 Add `contributes.hooks` for `workspace.create.before`, `contributes.events` for `workspace.created`, settings `branchTemplate` and `onWorkspaceCreated`, engine `>=1.4.248`; verify `orca plugin validate .`
- [x] 2.2 Implement the before hook (template fill, git-safe slug via `slugify`, 1.5 s Redmine budget, pass on any failure); verify with `mountWorker(...).hooks.fire('workspace.create.before', …)` for applied, empty template, no task and timeout
- [x] 2.3 Handle the `workspace.created` event (resolve key, existence/project check, link unless linked); verify with `mountWorker(...).emit('workspace.created', …)`, including an already-linked workspace, a folder workspace and a missing task
- [x] 2.4 Implement `onWorkspaceCreated` (`comment`, `start` with status choice, refused-transition handling) in the `workspace.created` handler, which also covers `redmine.launchWorkspace` (its workspace names the task); verify Redmine calls in tests, and that `nothing` makes none
- [x] 2.5 Add en/es strings for the comment and settings descriptions; verify catalog parity

## 3. Docs and integration

- [x] 3.1 Document detection, the template placeholders and `onWorkspaceCreated` in README (Settings, "How the plugin knows…"); remove the now-implemented idea from "Ideas"
- [~] 3.2 On a dev load, create a workspace `<real id>-test` from Orca's dialog and confirm branch rewrite, link in the panel, and the comment; record the `workspaceId` ↔ key answer in design.md. Done so far: id answer recorded; `orca worktree create` fired the event and the handler reached Redmine (#4077 not visible: no link, no write); `orca plugin dev hook` ran the before hook (no template: passed). Left for the maintainer: a task id they can see, with `branchTemplate` and `onWorkspaceCreated` set, from Orca's dialog
