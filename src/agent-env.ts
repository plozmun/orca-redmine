// What an agent gets when it starts in a workspace linked to a task: one environment variable, and
// optionally a line in the launch prompt naming the task. Local data only: the launch hook reads the
// plugin's own storage and never calls Redmine, so an agent start is never slowed down.
import type { AssignedIssue } from './links'

/** The only variable exported to agents: the task number, so scripts and redmine-cli can read it. */
export const ISSUE_ENV = 'REDMINE_ISSUE'
/** Terminals remembered for the prompt pointer; the oldest are forgotten first. */
export const TERMINAL_LIMIT = 200

/**
 * `env` plus `REDMINE_ISSUE=<id>`. A launcher that already set the variable keeps its value, and
 * nothing else is added: neither the API key nor the Redmine URL ever reaches an agent.
 */
export function withIssueEnv(env: Record<string, string>, id: number): Record<string, string> {
  return env[ISSUE_ENV] ? { ...env } : { ...env, [ISSUE_ENV]: String(id) }
}

/** The workspace path inside a CLI id (`<repoId>::<path>`), which is how Orca names some events. */
export function pathFromCliId(workspaceId: string): string | null {
  const at = workspaceId.indexOf('::')
  return at >= 0 && at + 2 < workspaceId.length ? workspaceId.slice(at + 2) : null
}

/** Task number and subject of the terminals the launch hook saw, oldest forgotten first. */
export class LaunchedTasks {
  private readonly byTerminal = new Map<string, AssignedIssue>()

  remember(terminalId: string, issue: AssignedIssue): void {
    // Re-inserting keeps the map in least-recently-seen order.
    this.byTerminal.delete(terminalId)
    this.byTerminal.set(terminalId, issue)
    for (const oldest of this.byTerminal.keys()) {
      if (this.byTerminal.size <= TERMINAL_LIMIT) break
      this.byTerminal.delete(oldest)
    }
  }

  taskFor(terminalId: string): AssignedIssue | undefined {
    return this.byTerminal.get(terminalId)
  }

  get size(): number {
    return this.byTerminal.size
  }
}

/** The task's page, from the Redmine URL in Settings; null when none is set yet. */
export function taskUrl(baseUrl: string | null, id: number): string | null {
  const base = baseUrl?.trim().replace(/\/+$/, '')
  return base ? `${base}/issues/${id}` : null
}

/** One line naming the task, English like the rest of the text handed to agents. */
export function taskPointer(issue: AssignedIssue, baseUrl: string | null): string {
  const head = `Redmine task #${issue.id} "${issue.subject}"`
  const url = taskUrl(baseUrl, issue.id)
  return url ? `${head}: ${url}` : head
}

/** Whether the prompt already names the task: its `#N` (not `#N0`) or its page. */
export function namesTask(prompt: string, id: number, baseUrl: string | null): boolean {
  if (new RegExp(`#${id}(?!\\d)`).test(prompt)) return true
  const url = taskUrl(baseUrl, id)
  return Boolean(url && prompt.includes(url))
}

/** The prompt with the pointer appended, or null when it already names the task. */
export function withPromptPointer(prompt: string, issue: AssignedIssue, baseUrl: string | null): string | null {
  if (namesTask(prompt, issue.id, baseUrl)) return null
  return `${prompt.trimEnd()}\n\n${taskPointer(issue, baseUrl)}`
}
