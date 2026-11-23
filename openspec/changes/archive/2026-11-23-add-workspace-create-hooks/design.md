# Design

## Context

Assignments live in the panel atom `redmine.issueByWorkspace` (`persist: 'plugin'`), keyed by the CLI's `identity.key`. The worker cannot read panel atoms and has no `storage:own`. Hooks run in the worker, must answer within 2 s (else they pass), and `workspace.create.before` gives `{ kind, projectId, name, branch?, base? }` with `name`/`branch`/`base` changeable. The `workspace.created` event (since 1.4.245, `workspace:read`, already granted) gives `{ workspaceId, kind, path, branch }`, the same fields as the observe-only `workspace.create.after` hook.

## Goals / Non-Goals

**Goals:** links and branch names right at creation for any launcher; panel and worker share one source of truth.

**Non-Goals:** linking folder workspaces (only worktrees have a stable branch); refusing creations (`onError` stays `pass`; this is never a guard).

## Decisions

- **Shared store in the worker.** Move `issueByWorkspace` and `projectByOrcaProject` to the plugin storage under `storage:own` (keys in `src/links.ts`). The panel uses atoms with `persist: 'storage'`, which Orca keeps in sync with the worker's `orca.storage`, so no `redmine.links.*` requests are needed. Migration: on setup, unless `links.migrated` is set, the panel merges the 0.1.x `persist: 'plugin'` atoms into storage (storage entries win), then sets the marker; the old atoms are left untouched for a downgrade. When the worker links the focused workspace, the panel hears `storage.onDidChange` and opens the task. Alternatives: requests to the worker (more code for the same result); keep the atom and have the worker ask the panel (rejected, the panel may be closed).
- **Key.** Links are keyed by the workspace's stable key (`identity.key`). The event's `workspaceId` is the CLI row `id` (`<repoId>::<path>`), so the key comes from `orca worktree list` (cache cleared, the workspace is new) matched by that id, or from `workspace.list` matched by path. The `identity:` form is accepted too in case Orca switches to it.
- **Link from the `workspace.created` event, not the `workspace.create.after` hook.** Both carry the same fields and neither lets the plugin change the creation. The event needs no hook entry (hooks are limited to 8 and every hook entry is listed in the approval prompt), uses a capability users already granted, and is delivered with no 2 s budget, so the Redmine lookup can take its time. It counts against the 4-event limit, shared with `add-task-followups` (`agent.status.changed`, `workspace.removed`): 3 of 4 used. Alternative: the after hook — rejected, it adds a hook for no extra data.
- **Before-hook budget.** Fetch the issue with a 1.5 s abort; no other awaited call before deciding. Plugin-created workspaces already have the `N-slug` name, so the template still applies to them.
- **`start` transition.** Redmine's API has no global default status (it is per tracker since 3.0). Rule: if the task is in the first open status of `/issue_statuses.json` (position order, normally New), move it to the next open one (normally In progress); otherwise only comment. If Redmine's workflow refuses the transition, keep the comment and log the error.
- **Recording the start once.** Only the `workspace.created` handler writes to Redmine, for automatic links and for the plugin's own launch alike (the launched workspace's name names the task, and the handler also acts when the workspace is already linked to that same task). A per-run set of workspace keys avoids a second comment if the event repeats.
- **Detection rule.** `src/task-ref.ts`: last path segment starting with 3+ digits then `-`, `_`, space or end; or `#N`, `redmine-N`, `rm-N` anywhere. Name before branch. The 0.1.x panel rule also took `bug-4321`; dropped, as it cannot be told apart from `release-2026`.
- **Detection shared with the panel.** `src/task-ref.ts` replaces the panel's current branch-number suggestion so both use one rule.

## Risks / Trade-offs

- [False positives: a branch `123-hotfix` in a repo unrelated to Redmine] → link only if the task exists and, when the Orca project is mapped to a Redmine project, belongs to it (or its subprojects).
- [Writing to Redmine without the user clicking] → off by default; the comment text says it came from Orca.
- [Storage migration loses links on failure] → write before clearing; keep the atom if the write fails.

## Migration Plan

0.2.0 with the other 1.4.248 changes. The atom migration runs once per machine; rollback to 0.1.x would see an empty atom, so keep the atom read-only (not cleared) for one release and clear it in the next.

## Answered questions

- `workspace.created`'s `workspaceId` (Orca 1.4.255, dev load 2026-11-10, worktree created with `orca worktree create`): `9e002ba4-…::/Users/…/4077-hook-test`, the CLI row `id`, not `identity:<key>` as `workspace.list` uses. Handled as above; after the fix, the same check reached Redmine for #4077 (403, not visible to that user, so correctly no link and no write).
