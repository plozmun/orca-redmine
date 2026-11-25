# Tasks

## 1. Worker

- [x] 1.1 Pure `workspaceNameFor(template, issue)` in `src/task-ref.ts` with tests (default, placeholders, control chars, 200 cut, number prefix)
- [x] 1.2 `redmine.renameWorkspace` in `src/protocol.ts` and `src/worker.ts`; test the host call and the `has()` gate in `src/worker.test.ts`
- [x] 1.3 Manifest: `workspace:write`, `workspaceNameTemplate`; verify validate

## 2. Panel and docs

- [x] 2.1 "Rename workspace" action in the workspace bar when linked; en/es strings; panel test; check scenario
- [x] 2.2 README: Features, Settings, Permissions
- [ ] 2.3 Manual: rename from a dev load and confirm the sidebar name
