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
