# Tasks

## 1. Locate and projects

- [x] 1.1 Host rows with `projectId`/`project`; match by focused `workspaceId` first; tests in `src/orca-workspaces.test.ts`
- [x] 1.2 `redmine.locateWorkspace` takes the project from the host row; CLI only as fallback; worker tests (no CLI call)
- [x] 1.3 Project mapping migration (CLI ids → host repository ids) with a storage flag; tests
- [x] 1.4 `redmine.orcaProjects` from `project.list` (git, not hidden); `redmine.launchWorkspace` translates a host id to the CLI project id; tests

## 2. Events

- [x] 2.1 `workspaceListId` in `workspace.created`, `workspace.removed`, `agent.status.changed`; tests with and without it

## 3. Agent states

- [x] 3.1 `redmine.agentStates` (protocol, worker, tests)
- [x] 3.2 Row badge, debounced refresh on `agent.status.changed`, en/es strings, panel test, check scenario

## 4. Docs and checks

- [x] 4.1 README: CLI section, features
- [x] 4.2 validate, test, check, `openspec validate --all --strict`
- [ ] 4.3 Manual: locate without `orca` on PATH; badge while an agent works
