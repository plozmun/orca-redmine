// Minimal Redmine REST API client. Only the worker (Node) uses it: panels have no network.
// It does not depend on Orca, so tests drive it with a fake `fetch`.

import { localDateDaysAgo } from './days'

export { localDateDaysAgo }

export interface IssueSummary {
  id: number
  subject: string
  project: string
  projectId: number
  tracker: string
  status: string
  statusId: number
  priority: string
  assignee: string | null
  updatedOn: string
}

export interface Journal {
  id: number
  author: string
  notes: string
  createdOn: string
}

export interface IssueDetail extends IssueSummary {
  description: string
  doneRatio: number
  url: string
  journals: Journal[]
}

export interface IssueStatus {
  id: number
  name: string
  isClosed: boolean
}

export interface TimeEntry {
  id: number
  hours: number
  comments: string
  /** Day the time was spent, `YYYY-MM-DD`. */
  spentOn: string
  activity: string
  user: string
}

export interface RedmineUser {
  id: number
  login: string
  name: string
}

export interface Project {
  id: number
  identifier: string
  /** Including the parent path: `Client › iOS App`. */
  name: string
  parentId?: number
}

/**
 * Ids of the project named by `ref` (identifier or numeric id) and all its subprojects, as Redmine's
 * `project_id` filter includes them. Empty when `ref` is not in the list.
 */
export function projectSubtree(projects: readonly Project[], ref: string): Set<number> {
  const root = projects.find((p) => p.identifier === ref || String(p.id) === ref)
  const ids = new Set<number>(root ? [root.id] : [])
  for (let grew = Boolean(root); grew; ) {
    grew = false
    for (const p of projects) {
      if (p.parentId !== undefined && ids.has(p.parentId) && !ids.has(p.id)) {
        ids.add(p.id)
        grew = true
      }
    }
  }
  return ids
}

export interface ListOptions {
  mine: boolean
  search?: string
  projectId?: string
  /** `open` (default), `closed`, `*` (any) or a status id. */
  status?: string
  limit?: number
}

/** A status filter Redmine accepts for `status_id`; anything else means open. */
export function statusFilter(value: string | undefined): string {
  return value && /^(open|closed|\*|\d+)$/.test(value) ? value : 'open'
}

/** What the status bar shows: my open tasks, and how many need attention. */
export interface OpenCounts {
  /** Open tasks assigned to the current user. */
  total: number
  /** Of those, whose due date is before today. */
  overdue: number
  /** Of those, in one of the two highest priorities (stock Redmine: Urgent and Immediate). */
  urgent: number
}

export interface IssuePriority {
  id: number
  name: string
  /** Some Redmine instances answer with it; the stock API does not. */
  isDefault?: boolean
}

/**
 * Ids of the two highest priorities, in the instance's own order (names differ per install): the
 * ranks at least two positions above the default one, which on stock Redmine (Low, Normal, High,
 * Urgent, Immediate) are Urgent and Immediate. Redmine does not tell a non-admin which priority is
 * the default: it is the entry flagged `is_default` when the instance says so, else the second one,
 * which is Redmine's stock "Normal". An instance with fewer than three priorities has none.
 */
export function urgentPriorityIds(priorities: readonly IssuePriority[]): number[] {
  const flagged = priorities.findIndex((p) => p.isDefault)
  return priorities.slice((flagged >= 0 ? flagged : 1) + 2).map((p) => p.id)
}

/** `GET /enumerations/issue_priorities.json` per base URL, kept for the worker's life. */
const prioritiesByUrl = new Map<string, IssuePriority[]>()

/** Tests: forgets the cached priority enumerations. */
export function resetRedmineCaches(): void {
  prioritiesByUrl.clear()
}

/**
 * Error with a stable `code`. The worker rethrows it, the panel receives `error.code` and shows
 * the translated text (see src/i18n). `message` carries untranslated detail (server text, URL).
 */
export class RedmineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number
  ) {
    super(message)
  }
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
}>


export function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  if (!/^https?:\/\/[^/]+/i.test(trimmed)) {
    throw new RedmineError('invalid_url', `Invalid Redmine URL: ${url}`)
  }
  return trimmed
}

/* eslint-disable @typescript-eslint/no-explicit-any -- Redmine JSON responses */
function name(ref: any): string {
  return typeof ref?.name === 'string' ? ref.name : ''
}

function toSummary(raw: any): IssueSummary {
  return {
    id: raw.id,
    subject: raw.subject ?? '',
    project: name(raw.project),
    projectId: raw.project?.id ?? 0,
    tracker: name(raw.tracker),
    status: name(raw.status),
    statusId: raw.status?.id ?? 0,
    priority: name(raw.priority),
    assignee: raw.assigned_to ? name(raw.assigned_to) : null,
    updatedOn: raw.updated_on ?? ''
  }
}

export class RedmineClient {
  readonly baseUrl: string

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl)
  }

  issueUrl(id: number): string {
    return `${this.baseUrl}/issues/${id}`
  }

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    let res: Awaited<ReturnType<FetchLike>>
    try {
      res = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers: {
          'X-Redmine-API-Key': this.apiKey,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new RedmineError('network', `${this.baseUrl}: ${detail}`)
    }
    const text = await res.text()
    if (!res.ok) {
      if (res.status === 401) throw new RedmineError('unauthorized', 'HTTP 401', 401)
      if (res.status === 403) throw new RedmineError('forbidden', 'HTTP 403', 403)
      if (res.status === 404) throw new RedmineError('not_found', 'HTTP 404', 404)
      let errors = ''
      try {
        errors = (JSON.parse(text).errors ?? []).join('; ')
      } catch {
        // not a JSON body
      }
      throw new RedmineError('http_error', errors || `HTTP ${res.status}`, res.status)
    }
    return text ? JSON.parse(text) : undefined
  }

  async currentUser(): Promise<RedmineUser> {
    const { user } = await this.call('GET', '/users/current.json')
    return { id: user.id, login: user.login ?? '', name: `${user.firstname ?? ''} ${user.lastname ?? ''}`.trim() }
  }

  private async countIssues(params: URLSearchParams): Promise<number> {
    const data = await this.call('GET', `/issues.json?${params}`)
    return data.total_count ?? 0
  }

  /** The instance's priorities in its own order, read once per base URL. */
  private async issuePriorities(): Promise<IssuePriority[]> {
    const cached = prioritiesByUrl.get(this.baseUrl)
    if (cached) return cached
    const data = await this.call('GET', '/enumerations/issue_priorities.json')
    const priorities: IssuePriority[] = (data.issue_priorities ?? []).map((p: any) => ({
      id: p.id,
      name: p.name ?? '',
      ...(p.is_default === true ? { isDefault: true } : {})
    }))
    prioritiesByUrl.set(this.baseUrl, priorities)
    return priorities
  }

  /**
   * My open tasks, how many are overdue and how many are urgent, as three `limit=1` counts: the
   * number stays right past the 100 issues a listing would fetch.
   */
  async openCounts(): Promise<OpenCounts> {
    const mine = () => new URLSearchParams({ assigned_to_id: 'me', status_id: 'open', limit: '1' })
    const overdueParams = mine()
    // Redmine's due_date shorthand has no plain `<` operator (`<=`, `>=`, `><`, `<t+`, `>t-`…), and
    // an operator it does not know can be ignored or refused; "on or before yesterday" is "before
    // today". URLSearchParams encodes `<=` as %3C%3D.
    overdueParams.set('due_date', `<=${localDateDaysAgo(1)}`)
    const [total, overdue, priorities] = await Promise.all([
      this.countIssues(mine()),
      this.countIssues(overdueParams),
      this.issuePriorities()
    ])
    const urgentIds = urgentPriorityIds(priorities)
    if (urgentIds.length === 0) return { total, overdue, urgent: 0 }
    const urgentParams = mine()
    urgentParams.set('priority_id', urgentIds.join('|'))
    return { total, overdue, urgent: await this.countIssues(urgentParams) }
  }

  async listIssues(options: ListOptions): Promise<{ issues: IssueSummary[]; total: number }> {
    const params = new URLSearchParams({
      status_id: statusFilter(options.status),
      sort: 'updated_on:desc',
      limit: String(options.limit ?? 50)
    })
    if (options.mine) params.set('assigned_to_id', 'me')
    if (options.projectId) params.set('project_id', options.projectId)
    const search = options.search?.trim()
    if (search) {
      const id = /^#?(\d+)$/.exec(search)
      if (id) {
        params.set('issue_id', id[1])
        params.set('status_id', '*')
      } else {
        params.set('subject', `~${search}`)
      }
    }
    const data = await this.call('GET', `/issues.json?${params}`)
    return { issues: (data.issues ?? []).map(toSummary), total: data.total_count ?? 0 }
  }

  /** Active projects the user can see (pages of 100, at most 500). */
  async listProjects(): Promise<Project[]> {
    const raw: any[] = []
    for (let offset = 0; offset < 500; offset += 100) {
      const data = await this.call('GET', `/projects.json?limit=100&offset=${offset}`)
      raw.push(...(data.projects ?? []))
      if (raw.length >= (data.total_count ?? 0) || (data.projects ?? []).length === 0) break
    }
    const byId = new Map<number, any>(raw.map((p) => [p.id, p]))
    const fullName = (p: any, depth = 0): string => {
      const parent = p.parent ? byId.get(p.parent.id) : undefined
      return parent && depth < 10 ? `${fullName(parent, depth + 1)} › ${p.name}` : p.name
    }
    return raw
      .filter((p) => p.status === undefined || p.status === 1)
      .map((p) => ({ id: p.id, identifier: p.identifier, name: fullName(p), ...(p.parent ? { parentId: p.parent.id } : {}) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async getIssue(id: number): Promise<IssueDetail> {
    const { issue } = await this.call('GET', `/issues/${id}.json?include=journals`)
    return {
      ...toSummary(issue),
      description: issue.description ?? '',
      doneRatio: issue.done_ratio ?? 0,
      url: this.issueUrl(id),
      journals: (issue.journals ?? [])
        .filter((j: any) => typeof j.notes === 'string' && j.notes.trim() !== '')
        .map((j: any) => ({ id: j.id, author: name(j.user), notes: j.notes, createdOn: j.created_on ?? '' }))
    }
  }

  async statuses(): Promise<IssueStatus[]> {
    const data = await this.call('GET', '/issue_statuses.json')
    return (data.issue_statuses ?? []).map((s: any) => ({ id: s.id, name: s.name, isClosed: Boolean(s.is_closed) }))
  }

  async updateIssue(id: number, change: { statusId?: number; notes?: string }): Promise<void> {
    const issue: Record<string, unknown> = {}
    if (change.statusId !== undefined) issue.status_id = change.statusId
    if (change.notes) issue.notes = change.notes
    await this.call('PUT', `/issues/${id}.json`, { issue })
  }

  /** `spentOn` is a local `YYYY-MM-DD` day; without it Redmine books today. */
  async logTime(id: number, hours: number, comments: string, spentOn?: string): Promise<number> {
    const entry: Record<string, unknown> = { issue_id: id, hours, comments }
    if (spentOn) entry.spent_on = spentOn
    const { time_entry } = await this.call('POST', '/time_entries.json', { time_entry: entry })
    return time_entry.id
  }

  /** The current user's time entries on a task, newest first (at most 100). */
  async myTimeEntries(issueId: number): Promise<TimeEntry[]> {
    const params = new URLSearchParams({ issue_id: String(issueId), user_id: 'me', limit: '100' })
    const data = await this.call('GET', `/time_entries.json?${params}`)
    return (data.time_entries ?? [])
      .map((e: any) => ({
        id: e.id,
        hours: Number(e.hours) || 0,
        comments: e.comments ?? '',
        spentOn: e.spent_on ?? '',
        activity: e.activity?.name ?? '',
        user: e.user?.name ?? ''
      }))
      .sort((a: TimeEntry, b: TimeEntry) => b.spentOn.localeCompare(a.spentOn) || b.id - a.id)
  }
}
