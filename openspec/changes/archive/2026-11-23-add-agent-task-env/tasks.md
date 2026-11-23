# Tasks

## 1. Launch hook

- [x] 1.1 Add `agent.launch.before` to `contributes.hooks`; verify `orca plugin validate .`
- [x] 1.2 Implement the hook: key resolution (identity and CLI id forms), link lookup in storage, `REDMINE_ISSUE` merged into env, no network; verify with `mountWorker(...).hooks.fire('agent.launch.before', …)` for linked, unlinked, null workspaceId, CLI-id form and existing-env cases, and assert no `fetch` happened
- [x] 1.3 Test that no env value equals the stored API key or the Redmine URL
- [x] 1.4 Update `agent.cliHint` (en/es) to mention `$REDMINE_ISSUE`; verify catalog parity and `src/launch.test.ts`

## 2. Prompt pointer

- [x] 2.1 Add `agent.prompt.before` hook and `promptPointer` setting (boolean, default false); verify validate
- [x] 2.2 Implement terminal→task memory and the pointer; verify with `hooks.fire` for on/off, prompt already naming the task, unknown terminal and `orchestration` input

## 3. Docs and integration

- [x] 3.1 Document `REDMINE_ISSUE`, that nothing else (no key, no URL) is exported, and `promptPointer` in README (redmine-cli, Settings, hooks table)
- [ ] 3.2 On a dev load, open a Claude tab in a linked workspace and confirm `echo $REDMINE_ISSUE`
