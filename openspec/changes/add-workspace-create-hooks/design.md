# Design

## Context

Assignments live in the panel atom `redmine.issueByWorkspace` (`persist: 'plugin'`), keyed by the CLI's `identity.key`. The worker cannot read panel atoms and has no `storage:own`. Hooks run in the worker, must answer within 2 s (else they pass), and `workspace.create.before` gives `{ kind, projectId, name, branch?, base? }` with `name`/`branch`/`base` changeable. The `workspace.created` event (since 1.4.245, `workspace:read`, already granted) gives `{ workspaceId, kind, path, branch }`, the same fields as the observe-only `workspace.create.after` hook.

## Goals / Non-Goals

**Goals:** links and branch names right at creation for any launcher; panel and worker share one source of truth.

**Non-Goals:** linking folder workspaces (only worktrees have a stable branch); refusing creations (`onError` stays `pass`; this is never a guard).

## Decisions

- **Shared store in the worker.** Move `issueByWorkspace` (and `projectByOrcaProject`, so other changes can use it) to `orca.storage` under `storage:own`, behind two requests `redmine.links.get/set`. Panel migrates once: on start, if worker storage is empty and the atom has entries, it writes them and clears the atom. Alternative: keep the atom and have the worker ask the panel — rejected, the panel may be closed.
- **Key.** Links are keyed by the workspace's stable key. The hook's `workspaceId` must be mapped to that key: if equal to the CLI `id`/`identity.key`, use it directly; otherwise resolve through the cached `orca worktree list` (cleared first, since the workspace is new). Verified on a dev load (open question below).
- **Link from the `workspace.created` event, not the `workspace.create.after` hook.** Both carry the same fields and neither lets the plugin change the creation. The event needs no hook entry (hooks are limited to 8 and every hook entry is listed in the approval prompt), uses a capability users already granted, and is delivered with no 2 s budget, so the Redmine lookup can take its time. It counts against the 4-event limit, shared with `add-task-followups` (`agent.status.changed`, `workspace.removed`): 3 of 4 used. Alternative: the after hook — rejected, it adds a hook for no extra data.
- **Before-hook budget.** Fetch the issue with a 1.5 s abort; no other awaited call before deciding. Plugin-created workspaces already have the `N-slug` name, so the template still applies to them.
- **`start` transition.** Use `/issue_statuses.json` (already fetched for the status picker): first status with `is_closed: false` after the default one. If Redmine's workflow refuses the transition, keep the comment and log the error.
- **Detection shared with the panel.** `src/task-ref.ts` replaces the panel's current branch-number suggestion so both use one rule.

## Risks / Trade-offs

- [False positives: a branch `123-hotfix` in a repo unrelated to Redmine] → link only if the task exists and, when the Orca project is mapped to a Redmine project, belongs to it (or its subprojects).
- [Writing to Redmine without the user clicking] → off by default; the comment text says it came from Orca.
- [Storage migration loses links on failure] → write before clearing; keep the atom if the write fails.

## Migration Plan

0.2.0 with the other 1.4.248 changes. The atom migration runs once per machine; rollback to 0.1.x would see an empty atom, so keep the atom read-only (not cleared) for one release and clear it in the next.

## Open Questions

- Is the `workspace.created` event's `workspaceId` the same value as `orca worktree list`'s `identity.key`? Changes only the lookup step. Related finding from `use-host-workspace-list`: `workspace.list` returns `id: "identity:" + identity.key` (checked 2026-11-10 on Orca 1.4.255: 38 of 38 local worktrees matched the CLI's `identity.key` and display name; listing not truncated); check whether the event uses the same `identity:` form with `orca plugin dev emit` / a real creation.
