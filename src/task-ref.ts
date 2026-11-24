// Which Redmine task a workspace name or branch refers to, and the branch name a team template
// gives a task. Pure: shared by the panel (assign suggestion) and the worker (creation hooks).
import { slugify } from './launch'
import type { IssueSummary } from './redmine'

/**
 * Task number named by a workspace name or branch, or null. Only the last path segment counts
 * (`feature/4077-login` → `4077-login`). Forms, case-insensitive:
 * - starts with the number, 3 digits or more, then `-`, `_`, a space or the end (`4077-login`);
 * - `#N` anywhere (`fix #42`);
 * - `redmine-N` / `rm-N` (or `_`) anywhere (`hotfix-rm-42`).
 * A bare number after a word (`release-2026`, `bug-4321`) is not taken: too often a year or version.
 */
export function taskRef(text: string | null | undefined): number | null {
  if (!text) return null
  const segment = text.replace(/^refs\/heads\//, '').split('/').pop() ?? ''
  const leading = /^(\d{3,})(?=$|[-_ ])/.exec(segment)
  const explicit = /#(\d+)\b/.exec(text) ?? /(?:^|[^a-z0-9])(?:redmine|rm)[-_](\d+)(?![0-9])/i.exec(text)
  const found = leading?.[1] ?? explicit?.[1]
  const id = found ? Number(found) : NaN
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/** The task a workspace refers to: its name first, then its branch. */
export function taskRefFromWorkspace(name: string | null | undefined, branch: string | null | undefined): number | null {
  return taskRef(name) ?? taskRef(branch)
}

/** Placeholders a `branchTemplate` may use. */
export const BRANCH_PLACEHOLDERS = ['id', 'slug', 'tracker', 'project'] as const

/** Placeholders a `workspaceNameTemplate` may use. */
export const WORKSPACE_NAME_PLACEHOLDERS = ['id', 'subject', 'tracker', 'project'] as const

/** What "Rename workspace" uses when no template is set: `4077 Checkout with saved cards`. */
export const DEFAULT_WORKSPACE_NAME_TEMPLATE = '{id} {subject}'

/** Orca refuses workspace names longer than this. */
export const WORKSPACE_NAME_MAX = 200

/**
 * Fills a branch template such as `{tracker}/{id}-{slug}` and makes it a valid, lower-case git
 * branch. Unknown placeholders are dropped. Null when nothing usable is left.
 */
export function branchFromTemplate(
  template: string,
  issue: Pick<IssueSummary, 'id' | 'subject' | 'tracker' | 'project'>
): string | null {
  const vars: Record<string, string> = {
    id: String(issue.id),
    slug: slugify(issue.subject),
    tracker: slugify(issue.tracker),
    project: slugify(issue.project)
  }
  const filled = template.trim().replace(/\{(\w+)\}/g, (_, name: string) => vars[name.toLowerCase()] ?? '')
  const branch = filled
    .toLowerCase()
    .split('/')
    .map((part) =>
      part
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/\.{2,}/g, '.')
        .replace(/^[.-]+|[.-]+$/g, '')
        .replace(/\.lock$/, '')
    )
    .filter(Boolean)
    .join('/')
  return branch || null
}

/**
 * The name "Rename workspace" gives the focused workspace: the filled `workspaceNameTemplate`
 * (default `{id} {subject}`), with whitespace collapsed and control or hidden characters removed
 * (Orca refuses them, and a blank name). It is cut to 200 characters and always starts with the task
 * number, so `taskRef` still finds the task in the renamed workspace. Unknown placeholders are
 * dropped, as in a branch template.
 */
export function workspaceNameFor(
  template: string,
  issue: Pick<IssueSummary, 'id' | 'subject' | 'tracker' | 'project'>
): string {
  const vars: Record<string, string> = {
    id: String(issue.id),
    subject: issue.subject,
    tracker: issue.tracker,
    project: issue.project
  }
  const filled = (template.trim() || DEFAULT_WORKSPACE_NAME_TEMPLATE).replace(
    /\{(\w+)\}/g,
    (_, name: string) => vars[name.toLowerCase()] ?? ''
  )
  const clean = filled
    .replace(/\s+/g, ' ') // newlines and tabs in a subject become one space
    .replace(/[\p{Cc}\p{Cf}]/gu, '') // control and hidden characters Orca refuses
    .trim()
  const numbered = new RegExp(`^${issue.id}(?!\\d)`).test(clean) ? clean : `${issue.id} ${clean}`.trim()
  const cut = numbered.slice(0, WORKSPACE_NAME_MAX).replace(/[\uD800-\uDBFF]$/, '')
  return cut.trimEnd() || String(issue.id)
}
