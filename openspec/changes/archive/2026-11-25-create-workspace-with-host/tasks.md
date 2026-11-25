# Tasks

## 1. Create with the host

- [x] 1.1 `redmine.launchWorkspace` uses `workspace.create` (prompt limit and context file as "Launch agent here"); links the returned id; tests
- [x] 1.2 Agent failure after creation: link and report; test
- [x] 1.3 Remove `createWorktree`, `createWorktreeArgs`, `parseCreated`, `setOrcaCreator` and their tests; host refusal → `workspace_create` / `workspace_create_unavailable` codes, en/es `errors.*`
- [x] 1.4 Project picker from `project.list` only; remove the CLI branch and its test

## 2. Go to workspace

- [x] 2.1 `redmine.openWorkspace` + support flag; tests
- [x] 2.2 Button in the task detail and agent follow-ups; en/es; panel tests; check scenario

## 3. Release

- [x] 3.1 Manifest: `workspace:create`, `workspace:write`, `engines.orca >=1.4.260`; together with `add-rename-workspace-to-task` and `add-task-agents-and-resume`
- [x] 3.2 README: Permissions, Features, Requirements (Orca 1.4.260; CLI only for opening the panel and old mappings), CLI
- [ ] 3.3 Manual: create in a local and an SSH project with the CLI off the PATH; go to workspace
