// Where workspace ↔ task links live: the plugin's storage (`storage:own`), shared by the panel
// (atoms with `persist: 'storage'`) and the worker (`orca.storage`), so links the worker makes at
// workspace creation show up in the panel.

/** Workspace link key (see src/orca-workspaces.ts) → the task linked to it. */
export const ISSUE_BY_WORKSPACE = 'links.issueByWorkspace'
/** Orca project id → Redmine project identifier (the list filter for its workspaces). */
export const PROJECT_BY_ORCA_PROJECT = 'links.projectByOrcaProject'
/** Set once the 0.1.x panel-only links were copied into storage. */
export const LINKS_MIGRATED = 'links.migrated'

export interface AssignedIssue {
  id: number
  subject: string
}
