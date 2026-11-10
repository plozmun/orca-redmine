# Tasks

## 1. Gate

- [x] 1.1 On a dev load, log `workspace.list` rows next to `orca worktree list --json` rows for local, renamed and (if available) SSH worktrees; record in design.md whether `id` equals `identity.key || id`. Stop here and update the proposal if it does not. **Result:** `workspace.list` returns `id: "identity:" + identity.key` (checked 2026-11-10 on Orca 1.4.255: 38 of 38 local worktrees matched the CLI's `identity.key` and display name; listing not truncated). Renamed and SSH worktrees were not available to check

## 2. Implementation

- [ ] 2.1 Generalise `matchWorktree` to a source-neutral row and ignore folders; keep all cases in `src/orca-workspaces.test.ts` passing and add host-row cases (unique name, branch tie-break, folder ignored)
- [ ] 2.2 `redmine.locateWorkspace`: host first, CLI for the project by key, CLI-only fallback (`host.has`, failure, truncated); return `projectErrorCode` when only the project is missing; verify in `src/worker.test.ts` with CLI ok, CLI failing and host missing
- [ ] 2.3 Panel: show the linked task and the "project unknown" message when `projectErrorCode` is set; verify in `src/panel.test.tsx`; add/confirm en/es strings and catalog parity

## 3. Docs

- [ ] 3.1 README: update "How the plugin knows…" to say the CLI is only needed for project mapping and creating workspaces
