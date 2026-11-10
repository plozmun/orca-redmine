# Tasks

## 1. Gate

- [ ] 1.1 Watch Orca releases and `docs/reference/plugin-manifest.md` for a `taskSources` entry with a `Since` version; done when the format is published (record version and link here)
- [ ] 1.2 Rewrite design.md and this task list against the published format (fields, filters, link model, refresh) and re-validate with `openspec validate adopt-task-sources`

## 2. Implementation (refine after 1.2)

- [ ] 2.1 Declare the source in the manifest and fill it from the worker; verify tasks appear in Orca's picker on a dev load
- [ ] 2.2 Migrate stored links to native links; verify an upgraded workspace keeps its task
- [ ] 2.3 Remove panel features Orca now covers and update README; verify `orca plugin test .` and `orca plugin check .`
