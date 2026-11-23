# Tasks

## 1. Create with the host

- [ ] 1.1 `redmine.launchWorkspace` uses `workspace.create` when offered (prompt limit and context file as "Launch agent here"); links the returned id; tests with and without the method
- [ ] 1.2 Agent failure after creation: link and report; test

## 2. Go to workspace

- [ ] 2.1 `redmine.openWorkspace` + support flag; tests
- [ ] 2.2 Button in the task detail and agent follow-ups; en/es; panel tests; check scenario

## 3. Release

- [ ] 3.1 Manifest: `workspace:create`, `workspace:write`, `engines.orca >=1.4.259`; with `add-rename-workspace-to-task`
- [ ] 3.2 README: Permissions, Features, CLI
- [ ] 3.3 Manual: create in a local and an SSH project; go to workspace
