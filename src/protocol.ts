// Panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
// Errors travel as codes (`error.code` on a rejected request, `errorCode` in answers) and the
// panel translates them with src/i18n; `*Detail` fields carry untranslated detail.
import type { CommentsMode } from './launch'
import type { CreatedWorktree, LocatedWorkspace } from './orca-workspaces'
import type { IssueDetail, IssueStatus, IssueSummary, Project } from './redmine'

export interface ConnectionStatus {
  configured: boolean
  url: string | null
  user: { login: string; name: string } | null
  /** Why a saved configuration does not connect. */
  errorCode?: string
  errorDetail?: string
}

declare module 'orca' {
  interface PluginRequests {
    /** Checks the connection with the saved URL and API key. */
    'redmine.status': { output: ConnectionStatus }
    /** Validates, then saves the URL (setting) and API key (encrypted secret). */
    'redmine.configure': { input: { url: string; apiKey: string }; output: ConnectionStatus }
    /** Deletes the API key. */
    'redmine.disconnect': { output: ConnectionStatus }
    /** Open issues, newest first. `search`: subject text or `#123`. `projectId`: id or identifier (includes subprojects). */
    'redmine.issues': {
      input: { mine: boolean; search?: string; projectId?: string; status?: string }
      output: { issues: IssueSummary[]; total: number }
    }
    'redmine.issue': { input: { id: number }; output: IssueDetail }
    'redmine.statuses': { output: IssueStatus[] }
    'redmine.projects': { output: Project[] }
    /** Which Orca project the focused workspace comes from, and its stable id. */
    'redmine.locateWorkspace': {
      input: { displayName: string; branch: string }
      output: { located: LocatedWorkspace | null; errorCode?: string; errorDetail?: string }
    }
    'redmine.setStatus': { input: { id: number; statusId: number }; output: IssueDetail }
    'redmine.comment': { input: { id: number; notes: string }; output: IssueDetail }
    'redmine.logTime': { input: { id: number; hours: number; comments: string }; output: { timeEntryId: number } }
    /** Orca projects (repositories) a workspace can be created in. */
    'redmine.orcaProjects': { output: { id: string; name: string }[] }
    /** Creates a new workspace for the task and, when asked, launches an agent with its context. */
    'redmine.launchWorkspace': {
      input: {
        issueId: number
        orcaProjectId: string
        agent: string | null
        instructions: string
        baseBranch?: string
        activate: boolean
        locale: string
        /** Which comments go into the context; defaults to the `contextComments` setting. */
        comments?: CommentsMode
      }
      output: CreatedWorktree & { name: string }
    }
    /** Types the task prompt into a terminal (no Enter): the `sendPrompt` setting, else a default in the panel's language. */
    'redmine.sendToAgent': { input: { id: number; terminalId: string; locale: string }; output: { accepted: boolean } }
  }
  interface PluginPanelEvents {
    /** After a status change, comment or time entry: open panels reload the issue. */
    'redmine.issueChanged': { id: number }
  }
}
