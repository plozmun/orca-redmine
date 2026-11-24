// Panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
// Errors travel as codes (`error.code` on a rejected request, `errorCode` in answers) and the
// panel translates them with src/i18n; `*Detail` fields carry untranslated detail.
import type { CommentsMode } from './launch'
import type { Followup } from './followups'
import type { AgentState, CreatedWorktree, LocatedWorkspace } from './orca-workspaces'
import type { IssueDetail, IssueStatus, IssueSummary, OpenCounts, Project, TimeEntry } from './redmine'

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
    /**
     * Which Orca project the focused workspace comes from, and its stable id. The id comes from the
     * host when it can answer, so `located` may be set with a null project and an `errorCode` saying
     * why the project is unknown (the CLI failed or does not list it).
     */
    'redmine.locateWorkspace': {
      /** `workspaceId`: the focused workspace's `workspace.list` id, when Orca gives it (host API 1.7). */
      input: { displayName: string; branch: string; workspaceId?: string }
      output: { located: LocatedWorkspace | null; errorCode?: string; errorDetail?: string }
    }
    'redmine.setStatus': { input: { id: number; statusId: number }; output: IssueDetail }
    'redmine.comment': { input: { id: number; notes: string }; output: IssueDetail }
    /** `spentOn`: the day to book, `YYYY-MM-DD`, at most today; today when left out. */
    'redmine.logTime': { input: { id: number; hours: number; comments: string; spentOn?: string }; output: { timeEntryId: number } }
    /** My open tasks, overdue ones and urgent ones: the list header's tiles and the status bar. */
    'redmine.counts': { output: OpenCounts }
    /** The current user's time entries on a task. */
    'redmine.timeEntries': { input: { id: number }; output: TimeEntry[] }
    /** Agent state of linked tasks, by task number: working, waiting for permission, or done and unseen. */
    'redmine.agentStates': { output: Record<string, AgentState> }
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
    /** Whether the `redmine` CLI (redmine-cli) is installed: `redmine --version`, or null. */
    'redmine.cli': { output: { version: string | null } }
    /**
     * Types the task prompt into a terminal (no Enter): the `sendPrompt` setting, else a default in the
     * panel's language. The context goes in a file (`<tmp>/orca-redmine/<id>.md`) the prompt points to.
     */
    'redmine.sendToAgent': { input: { id: number; terminalId: string; locale: string }; output: { accepted: boolean } }
    /** Pending follow-ups recorded by the worker when an agent finishes or a linked workspace goes away. */
    'redmine.followups.get': { output: { followups: Followup[] } }
    /** Removes one pending follow-up (acted on, or dismissed by the person). */
    'redmine.followups.dismiss': { input: { id: string }; output: { followups: Followup[] } }
    /** Whether this Orca can start an agent in a workspace (`agent.launch`); the panel hides the action when it cannot. */
    'redmine.launchHereSupport': { output: { available: boolean } }
    /**
     * Starts `agent` in a new terminal of the focused workspace with the prompt a new-workspace launch
     * gets. `workspaceKey` is that workspace's link key, so the panel can assign the task to it.
     */
    'redmine.launchHere': {
      input: { issueId: number; agent: string; instructions: string; locale: string; comments?: CommentsMode }
      output: { terminalId: string; workspaceKey: string | null }
    }
    /**
     * Whether this Orca can rename a workspace (`workspace.rename`, host API 1.5); the panel hides
     * the action when it cannot.
     */
    'redmine.renameWorkspaceSupport': { output: { available: boolean } }
    /**
     * Renames the focused workspace after its task, filling `workspaceNameTemplate`. Only the panel's
     * explicit "Rename workspace" action calls it: nothing renames a workspace by itself.
     */
    'redmine.renameWorkspace': {
      input: { workspaceKey: string; issue: Pick<IssueSummary, 'id' | 'subject' | 'tracker' | 'project'> }
      output: { name: string }
    }
    /** Agents in the workspaces linked to the task, newest links first (at most 5). */
    'redmine.taskAgents': { input: { issueId: number }; output: { workspaces: TaskWorkspaceAgents[] } }
    /** Which agent actions this Orca offers and the user approved. */
    'redmine.agentActionsSupport': { output: { show: boolean; resume: boolean } }
    /** Focuses one listed agent's terminal; refuses one the last `redmine.taskAgents` did not name. */
    'redmine.showAgent': { input: { terminalId: string }; output: { focused: boolean } }
    /** Resumes the session of an "agent finished" follow-up; `started` is false when it already runs. */
    'redmine.resumeAgent': { input: { followupId: string }; output: { terminalId: string; started: boolean } }
  }
  interface PluginPanelEvents {
    /** After a status change, comment or time entry: open panels reload the issue. */
    'redmine.issueChanged': { id: number }
    /** After the worker records or dismisses a follow-up: open panels show the new list. */
    'redmine.followupsChanged': { followups: Followup[] }
    /** After the worker counted my tasks again (status bar tick or a change from a panel). */
    'redmine.countsChanged': OpenCounts
  }
}

/** One agent of a workspace linked to a task, as `agents.list` reports it. */
export interface TaskAgent {
  terminalId: string | null
  title: string | null
  agent: string | null
  state: 'working' | 'blocked' | 'waiting' | 'done'
  stateStartedAt: number
}

/** The agents of one workspace linked to a task. */
export interface TaskWorkspaceAgents {
  /** The workspace's link key. */
  key: string
  name: string
  agents: TaskAgent[]
}
