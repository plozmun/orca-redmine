# Tasks

## 1. Launch hook

- [ ] 1.1 Add `agent.launch.before` to `contributes.hooks` and verify `orca plugin validate .`
- [ ] 1.2 Implement the hook: link lookup by workspace key, the four variables, existing-file fast path, 1.2 s first-fetch budget, background refresh, merge with existing env; verify with `mountWorker(...).hooks.fire('agent.launch.before', …)` for linked, unlinked, Redmine down and existing-env cases
- [ ] 1.3 Add a test asserting no env value equals the stored API key
- [ ] 1.4 Update `agent.cliHint` (en/es) to mention `$REDMINE_ISSUE` when set; verify catalog parity and `src/launch.test.ts`

## 2. Prompt pointer

- [ ] 2.1 Add `agent.prompt.before` hook and `promptPointer` setting (default false); verify validate
- [ ] 2.2 Implement terminal→task memory and the focused-context fallback; append the pointer only for `inputKind: "launch"` and prompts not already naming the task; verify with `hooks.fire` for on/off, own prompt, unknown terminal and orchestration input

## 3. Docs and integration

- [ ] 3.1 Document the variables, the guarantee that no key is exported, and `promptPointer` in README (redmine-cli and Settings sections)
- [ ] 3.2 On a dev load, open a Claude tab in a linked workspace and confirm `env | grep REDMINE` shows the variables and the file is readable
