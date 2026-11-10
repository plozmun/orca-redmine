# Tasks

## 1. Shared link store

- [ ] 1.1 Add `storage:own` and worker requests `redmine.links.get` / `redmine.links.set` backed by `orca.storage`; test read/write/delete in `src/worker.test.ts`
- [ ] 1.2 Switch the panel to the worker store, with the one-time copy from the `redmine.issueByWorkspace` and `redmine.projectByOrcaProject` atoms (atoms kept read-only this release); verify migration and no-loss-on-failure in `src/panel.test.tsx`
- [ ] 1.3 Add `src/task-ref.ts` with the detection rule, replace the panel's branch-number suggestion with it, and cover every spec example in a unit test

## 2. Hooks

- [ ] 2.1 Add `contributes.hooks` for `workspace.create.before`, `contributes.events` for `workspace.created`, settings `branchTemplate` and `onWorkspaceCreated`, engine `>=1.4.248`; verify `orca plugin validate .`
- [ ] 2.2 Implement the before hook (template fill, git-safe slug via `slugify`, 1.5 s Redmine budget, pass on any failure); verify with `mountWorker(...).hooks.fire('workspace.create.before', …)` for applied, empty template, no task and timeout
- [ ] 2.3 Handle the `workspace.created` event (resolve key, existence/project check, link unless linked); verify with `mountWorker(...).emit('workspace.created', …)`, including an already-linked workspace, a folder workspace and a missing task
- [ ] 2.4 Implement `onWorkspaceCreated` (`comment`, `start` with status choice, refused-transition handling) for both the `workspace.created` handler and `redmine.launchWorkspace`; verify Redmine calls in tests, and that `nothing` makes none
- [ ] 2.5 Add en/es strings for the comment and settings descriptions; verify catalog parity

## 3. Docs and integration

- [ ] 3.1 Document detection, the template placeholders and `onWorkspaceCreated` in README (Settings, "How the plugin knows…"); remove the now-implemented idea from "Ideas"
- [ ] 3.2 On a dev load, create a workspace `<real id>-test` from Orca's dialog and confirm branch rewrite, link in the panel, and the comment; record the `workspaceId` ↔ key answer in design.md
