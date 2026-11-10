# Design

## Context

Links (`redmine.issueByWorkspace`) are keyed by `identity.key || id` from `orca worktree list` (`matchWorktree`). The project comes from the row's `projectId` and `orca project list`. `listOrca()` caches both for 15 s; a miss clears the cache and retries, for brand-new workspaces. `workspace.list` (worker, `workspace:read`, API 1.3) lists every worktree and folder on every host, possibly `truncated`.

## Goals / Non-Goals

**Goals:** workspace key without the CLI; no change to stored keys; clearer degradation.

**Non-Goals:** removing the CLI (still needed for projects and `worktree create`); folder workspaces (links stay worktree-only).

## Decisions

- **Gate on key identity.** First task: on a dev load, compare `workspace.list` ids with the CLI's `identity.key` and `id` for several worktrees (local, renamed, SSH if available). Record the answer here. Proceed only if `id` equals the stored key (or a documented deterministic transform of it).
- **Shared matcher.** Generalise `matchWorktree` to rows `{ key, name, branch, projectId? }` so both sources use one rule: name match, branch to break ties, else the only worktree on that branch. Rows with `kind: "folder"` are ignored.
- **Order.** `workspace.list` → key. Then the CLI listing (cached) → project for that key; matched by key, not by name, so it cannot pick a different workspace. If the host method is missing (`host.has`) or fails, fall back to today's CLI-only path.
- **Result shape.** `located` keeps `{ workspaceKey, orcaProjectId, orcaProjectName }`; project fields may be null with `projectErrorCode` (e.g. `orca_cli`) so the panel can say "Orca project unknown: <reason>" (existing strings `workspace.orcaProjectUnknown*`) and still show the linked task.
- **Truncated listings.** If `truncated` and no match, fall back to the CLI path.

## Risks / Trade-offs

- [Ids differ between host and CLI] → the gate; nothing ships without it.
- [Two sources disagree on a brand-new workspace] → host first, it is updated synchronously by Orca; CLI cache is cleared on a key miss as today.

## Gate result

`workspace.list` returns `id: "identity:" + identity.key` (checked 2026-11-10 on Orca 1.4.255: 38 of 38 local worktrees matched the CLI's `identity.key` and display name; listing not truncated). So the stored link key is the host id with the `identity:` prefix removed; keep that transform in one helper (`keyFromHostId`) and fall back to the CLI path for an id without the prefix. Not checked: renamed worktrees (the key is documented to survive renames) and SSH hosts (none configured); cover both with unit tests on the transform and recheck when an SSH host is available.

## Migration Plan

None if the gate passes (same keys). Rollback: revert to CLI-only lookup.
