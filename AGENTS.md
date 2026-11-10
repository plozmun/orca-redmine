# AGENTS.md

Guidance for coding agents working on this repository. User-facing documentation is in [README.md](README.md).

## What this is

An Orca plugin (`plozmun.redmine-tasks`, manifest `orca-plugin.json`) that shows Redmine tasks in a sidebar panel and links them to Orca workspaces and agents. TypeScript with no build step: Orca transpiles `src/worker.ts` (Node worker, `trusted-worker` profile) and `src/panel.tsx` (components panel) when it loads them. There is no `package.json`. Do not add npm dependencies or a bundler.

## Commands

```sh
orca plugin validate .        # manifest, limits, files; run after every manifest change
orca plugin test .            # unit tests: src/**/*.test.ts(x)
orca plugin check .           # renders the panel in each scenario of src/panel.check.ts
orca plugin shot . --scenario detail   # PNG of a scenario, for checking UI changes
orca plugin dev watch . --check        # hot-reload into a running Orca (asks to approve)
```

Run `validate`, `test` and `check` before considering a change done. `npx tsc -p .` needs `orca plugin types` to have written `.orca/types/`; with some Orca versions that step fails, so do not rely on it.

Authoritative plugin docs: `orca skills get orca-plugin-authoring --references`, or `docs/reference/plugin-*.md` in github.com/stablyai/orca. Check the `Since` column there before using a manifest field, hook or host method, and raise `engines.orca` to the highest `Since` you use.

## Code map and boundaries

- `src/redmine.ts`: Redmine REST client. No Orca imports; keep it that way.
- `src/protocol.ts`: the only contract between panel and worker. Each new request or event gets typed here first.
- `src/worker.ts`: everything that touches the network, secrets, the `orca` CLI or terminals. The panel cannot reach the network.
- `src/panel.tsx`: UI and panel-persisted state (atoms with `persist: 'plugin'`).
- `src/launch.ts`, `src/agent-files.ts`, `src/textile.ts`, `src/orca-workspaces.ts`: pure helpers, unit-tested.

## Conventions

- **Errors:** the worker throws `RedmineError` with a code (`unauthorized`, `network`, `orca_cli`…). The panel translates `errors.<code>`. Do not put user-facing text in worker errors.
- **i18n:** every UI string goes through `t(key)`. Add keys to `src/i18n/en.ts` and `src/i18n/es.ts` together; a test enforces matching keys and placeholders. Text given to agents as task context stays in English.
- **Tests:** every behaviour change comes with tests in the same change. Worker tests use `orca/testing` (`mountWorker`, and `hooks.fire` for hooks). Panel scenarios go in `src/panel.check.ts` with sample data, never real Redmine data.
- **Docs:** when settings, permissions or features change, update the README tables in the same change.

## Security rules (the listing review checks these)

- The Redmine API key lives only in `orca.secrets`. Never write it to settings, storage, files, logs, prompts, agent environments or test fixtures.
- Keep the capability list minimal. Each new capability, hook, command or panel makes every user re-approve the update, so group such changes into one release.
- No telemetry, analytics or obfuscated code.
- The plugin is not affiliated with Redmine. Keep that wording, and the CC BY-SA credit for `assets/`, in README.

## Planning with OpenSpec

Larger changes are planned in `openspec/changes/<name>/` (proposal, specs, design, tasks) before coding. Changes marked **Blocked on Orca** depend on contribution points Orca has reserved but not shipped (`taskSources`, `connections`, `sidebarCards`). Do not implement them until their format appears in Orca's manifest reference. Use `openspec list`, `openspec show <change>` and `openspec validate --all --strict`.

## Releases

The version in `orca-plugin.json` and the git tag must match: version `0.2.0` → tag `v0.2.0`. Orca's indexer reads tags. A published version never changes, so do not move or reuse a tag. Bump the version, commit, tag, and push only when the maintainer asks. Listing status: https://www.onorca.dev/plugins/plozmun/orca-redmine (machine-readable in `status.json` of github.com/stablyai/orca-community-plugins).
