# Tasks

## 1. Worker

- [ ] 1.1 Add `findWorkspaceId(context)` using `workspace.list` with the `matchWorktree` rules; unit-test unique match, branch disambiguation and no match
- [ ] 1.2 Add the `redmine.launchHere` request to `src/protocol.ts` and its handler in `src/worker.ts` calling `agent.launch` with `buildLaunchPrompt`; verify in `src/worker.test.ts` that the host receives the expected workspaceId, agent and prompt, and that errors surface as codes
- [ ] 1.3 Add `agent:launch` to the manifest capabilities and raise `engines.orca` to `>=1.4.248` (the capability's `Since`); verify `orca plugin validate .` lists the new permission

## 2. Panel

- [ ] 2.1 Add "Launch agent here" to the Agent section, reusing the agent picker, instructions and comments controls; disabled without a focused workspace or when `orca.host.has('agent.launch')` is false; verify in `src/panel.test.tsx`
- [ ] 2.2 Assign the task to the workspace on success only when it has none; verify both cases in `src/panel.test.tsx`
- [ ] 2.3 Add en/es strings (button, success, errors) and verify the catalog-parity test passes
- [ ] 2.4 Add a `detail` scenario variant showing the button to `src/panel.check.ts` and verify `orca plugin check .`

## 3. Docs and integration

- [ ] 3.1 Update README Features and Permissions (`agent:launch`) and verify they match the manifest
- [ ] 3.2 On a dev load, launch Claude here on a real task and confirm the terminal opens with the prompt; record which workspace id `agent.launch` accepted in design.md
