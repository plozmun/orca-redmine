# Design

## Decisions

- **Worker request.** `redmine.renameWorkspace { workspaceKey, issue }` → `workspace.rename { workspaceId: "identity:" + key, name }`. The panel already has the located key.
- **Name rules.** Fill the template, collapse whitespace, strip control characters (Orca refuses hidden/control characters and blank names), cut to 200. If the result has no task number at its start, prefix `{id} ` so detection keeps working.
- **Gate.** Hidden when `workspace.rename` is not offered (Orca < 1.4.257) or the workspace is a folder.
- **No automatic rename.** Renaming someone's workspace silently is surprising; only on click.

## Risks / Trade-offs

- [`workspace:write` also allows opening workspaces/files and running built-in commands] → the plugin only calls `workspace.rename`; README says so.
- [Panel CLI matching uses the display name] → links are keyed by identity key, and the CLI match tiebreaks by branch; rename does not break the link.
