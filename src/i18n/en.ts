// English messages: the source of truth. Other locales must provide the same keys (see ./index.ts).
// Placeholders use {name} and are filled by `translate`.
export const en = {
  // Connection
  'connect.title': 'Connect to Redmine',
  'connect.help': 'Find your API key in Redmine → My account → API access key. It is stored encrypted in the system keychain.',
  'connect.failed': 'Could not connect',
  'connect.url': 'Redmine URL',
  'connect.urlFromSettings': 'Redmine: {url}',
  'connect.changeUrl': 'Change URL',
  'connect.whyNotSettings': 'The API key is asked for here, not in Settings → Plugins → Redmine, because Orca settings are stored unencrypted; here it goes to the system keychain.',
  'connect.apiKey': 'API key',
  'connect.submit': 'Connect',
  'connecting': 'Connecting to Redmine',

  // Header
  'header.title': 'Redmine',
  'header.reload': 'Reload',
  'header.disconnect': 'Disconnect',

  // Workspace card
  'workspace.none': 'No focused workspace: showing tasks from every project.',
  'workspace.orcaProject': 'Orca project: {name}',
  'workspace.orcaProjectUnknown': 'Could not identify the Orca project',
  'workspace.orcaProjectUnknownReason': 'Could not identify the Orca project: {reason}',
  'workspace.redmineProjectFor': 'Redmine project for {name}',
  'workspace.noTask': 'No task assigned. Open a task and press “Assign to this workspace”.',
  'workspace.unassignTask': 'Unassign task',
  'workspace.assignFromBranch': 'Assign #{id} (from branch)',

  // Project picker
  'projects.all': 'No project (all)',
  'projects.clear': 'Remove project',

  // Search picker
  'picker.search': 'Search: {label}',
  'picker.searchPlaceholder': 'Search {count}…',
  'picker.empty': 'No matches',
  'picker.count': '{total} results',
  'picker.more': 'Showing {shown} of {total}: refine the search',
  'picker.cancel': 'Cancel',

  // Issue list
  'list.search': 'Search',
  'list.searchPlaceholder': 'Subject or #number',
  'list.onlyMine': 'Only assigned to me',
  'list.loading': 'Loading tasks',
  'list.empty': 'No open tasks',
  'list.emptyHint': 'Change the filter or the search.',
  'list.count': '{shown} of {total} tasks',

  // Issue detail
  'issue.back': '← Back',
  'issue.openInRedmine': 'Open in Redmine',
  'issue.unassigned': 'Unassigned',
  'issue.updated': 'updated',
  'issue.isWorkspaceTask': 'Task of this workspace',
  'issue.unassign': 'Unassign',
  'issue.assign': 'Assign to this workspace',
  'issue.assignReplacing': 'Assign to this workspace (replaces #{id})',
  'issue.status': 'Status',
  'issue.description': 'Description',
  'issue.noDescription': 'No description',
  'issue.history': 'History ({count})',
  'issue.noComments': 'No comments',

  // Launch in a new workspace
  'launch.title': 'Launch agent in a new workspace',
  'launch.subtitle': 'Creates a worktree for the task, like Orca does for Jira or GitHub',
  'launch.name': 'Workspace and branch: {name} (with Orca’s branch prefix)',
  'launch.orcaProject': 'Orca project',
  'launch.orcaProjectPlaceholder': 'Choose the repository',
  'launch.noOrcaProjects': 'Could not read the Orca projects.',
  'launch.agent': 'Agent',
  'launch.noAgent': 'No agent (workspace only)',
  'launch.baseBranch': 'Base branch',
  'launch.baseBranchPlaceholder': 'The repository’s default branch',
  'launch.instructions': 'Instructions for the agent',
  'launch.activate': 'Open the workspace when created',
  'launch.comments': 'Comments in the context',
  'launch.commentsNone': 'No comments',
  'launch.commentsRecent': 'Latest {count} comments',
  'launch.commentsAll': 'Full history ({count} comments)',
  'launch.settingsHint': 'Default instructions, prompts and comments are set in Settings → Plugins → Redmine.',
  'launch.submit': 'Create workspace and launch agent',
  'launch.submitNoAgent': 'Create workspace',
  'launch.contextHint': 'The agent gets your instructions plus, as reference data, the task description and latest comments.',
  'launch.defaultInstructions': 'Complete Redmine task #{id} "{subject}": {url}',
  'launch.done': 'Workspace “{name}” created.',
  'launch.doneBranch': 'Workspace “{name}” created on branch {branch}.',
  'launch.doneAgent': '{agent} launched.',
  'launch.assigned': 'Task assigned.',

  // Send to the current workspace's agent
  'send.title': 'Send to agent',
  'send.subtitle': 'Types the task prompt into a terminal of the current workspace',
  'send.terminal': 'Terminal',
  'send.noTerminals': 'Open a workspace with a terminal (Claude, Codex…) to send it the task.',
  'send.submit': 'Send prompt',
  'send.prompt': 'Work on Redmine task #{id} "{subject}" ({url}). Read the task description and comments first.',
  'send.accepted': 'Prompt typed into the terminal: review it and press Enter',
  'send.rejected': 'The terminal did not accept the text',

  // Time and comments
  'time.title': 'Log time',
  'time.hours': 'Hours',
  'time.comment': 'Comment',
  'time.submit': 'Log',
  'time.done': '{hours} h logged on #{id}',
  'comment.title': 'Comment',
  'comment.label': 'Comment',
  'comment.submit': 'Add comment',
  'comment.done': 'Comment added',
  'status.done': 'Status updated',
  'assign.done': '#{id} assigned to this workspace',
  'assign.removed': 'Task unassigned from the workspace',

  // Errors (by code; the worker sends the code, the panel translates it)
  'errors.not_configured': 'Set the Redmine URL and API key first',
  'errors.unauthorized': 'Invalid API key',
  'errors.forbidden': 'You do not have permission for this action in Redmine',
  'errors.not_found': 'Not found in Redmine',
  'errors.network': 'Could not reach Redmine ({detail})',
  'errors.invalid_url': 'The Redmine URL must start with http:// or https://',
  'errors.invalid_hours': 'Hours must be between 0 and 24',
  'errors.http_error': 'Redmine refused the request: {detail}',
  'errors.orca_cli': 'Could not run the Orca CLI ({detail})',
  'errors.workspace_not_listed': 'Orca does not list this workspace',
  'errors.timeout': 'Took too long; the workspace may still be created',
  'errors.need_orca_project': 'Choose the Orca project where the workspace will be created',
  'errors.need_comment': 'Write a comment',
  'errors.need_hours': 'Enter the hours, e.g. 1.5',
  'errors.no_terminals': 'The current workspace has no terminals',

  // Command palette (worker)
  'command.notConfigured': 'Redmine is not configured: open the Redmine panel (flag icon in the right sidebar) and enter the URL and your API key.',
  'command.noIssues': 'You have no open Redmine tasks.',
  'command.header': '{total} open tasks assigned to you:'
}

export type MessageKey = keyof typeof en
export type Messages = Record<MessageKey, string>
