# Tasks

## 1. Gate

- [ ] 1.1 Watch Orca releases for `contributes.sidebarCards` with a `Since` version; record version and link here
- [ ] 1.2 Rewrite design.md and tasks against the published format; re-validate with `openspec validate add-sidebar-task-card`

## 2. Implementation (refine after 1.2)

- [ ] 2.1 Add a batched `RedmineClient.issuesById()` and feed it from the existing poller; verify in `src/redmine.test.ts`
- [ ] 2.2 Declare the card and update it from the worker; verify on a dev load that linked workspaces show `#id · status` and that pressing it opens the panel
