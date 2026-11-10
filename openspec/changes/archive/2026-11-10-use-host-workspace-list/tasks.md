# Tasks

## 1. Gate

- [x] 1.1 On a dev load, log `workspace.list` rows next to `orca worktree list --json` rows for local, renamed and (if available) SSH worktrees; record in design.md whether `id` equals `identity.key || id`. Stop here and update the proposal if it does not. **Result:** `workspace.list` returns `id: "identity:" + identity.key` (checked 2026-11-10 on Orca 1.4.255: 38 of 38 local worktrees matched the CLI's `identity.key` and display name; listing not truncated). Renamed and SSH worktrees were not available to check

## 2. Implementation

- [x] 2.1 Generalise `matchWorktree` to a source-neutral row and ignore folders; keep all cases in `src/orca-workspaces.test.ts` passing and add host-row cases (unique name, branch tie-break, folder ignored)
- [x] 2.2 `redmine.locateWorkspace`: host first, CLI for the project by key, CLI-only fallback (`host.has`, failure, truncated); return `errorCode` with a located workspace when only the project is missing; verify in `src/worker.test.ts` with CLI ok, CLI failing and host missing
- [x] 2.3 Panel: show the linked task and the "project unknown" message when the project is null with an `errorCode`; verify in `src/panel.test.tsx`; add/confirm en/es strings and catalog parity

## 3. Docs

- [x] 3.1 README: update "How the plugin knows…" to say the CLI is only needed for project mapping and creating workspaces

## 4. Integration

- [x] 4.1 On a dev load (2026-11-10, Orca 1.4.255), `redmine.locateWorkspace` for `msl-kyb` returned the same `wt2:local:…` key and Orca project as 0.1.7; an unknown workspace returned `workspace_not_listed`
