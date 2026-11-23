# Design

## Ids

| What | Host (API 1.7) | CLI |
|---|---|---|
| Workspace | `identity:<key>` (`workspace.list`, `workspaceListId`) | `<repoId>::<path>`, `identity.key` |
| Project | repository id (`f867aa90-…`): `workspace.list` `projectId`, `project.list` `id` | logical project `git:<host>/<path>` with `sourceRepoIds` |

Link keys stay `<key>` (unchanged since 0.1.x). Project mappings move to the host repository id: it is what `workspace.list`, `project.list` and the host's `workspace.create` (0.3.0) use, and it needs no CLI.

## Migration of project mappings

`links.projectByOrcaProject` may hold CLI ids (`git:` or any id the host does not list). When the worker locates a workspace with the host and the map has keys that `project.list` does not know, it runs `orca project list` once and, for each such key, copies the Redmine project to every `sourceRepoIds` entry that has no mapping yet. A storage flag records success; a failed CLI run is retried at the next locate. Old keys are not deleted.

## Agent states

`redmine.agentStates` answers `{ [issueId]: 'working' | 'permission' | 'done' }` from `workspace.list { includeStatus: true }` joined with the link store. `done` only while `unread` (the person has not looked yet); `active`/`inactive` are not shown. Without `includeStatus` support the answer is empty. The panel asks after each list load and, debounced by 1.5 s, on `agent.status.changed`.

## Fallbacks

Each host path is used only when `host.has(...)` and the answer carries the field; otherwise the 0.2.0 code path runs unchanged.
