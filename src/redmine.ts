// Minimal Redmine REST API client. Only the worker (Node) uses it: panels have no network.
// It does not depend on Orca, so tests drive it with a fake `fetch`.

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
}

export interface ListOptions {
  mine: boolean
  search?: string
  projectId?: string
  limit?: number
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

/** Issue number in a branch such as `feature/12345-login`, `12345_fix` or `bug-12345` (3+ digits). */
export function issueIdFromBranch(branch: string | null | undefined): number | null {
  if (!branch) return null
  const match = /(?:^|[/_#-])(\d{3,})(?=$|[/_-])/.exec(branch)
  return match ? Number(match[1]) : null
}

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

  async listIssues(options: ListOptions): Promise<{ issues: IssueSummary[]; total: number }> {
    const params = new URLSearchParams({
      status_id: 'open',
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
      .map((p) => ({ id: p.id, identifier: p.identifier, name: fullName(p) }))
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

  async logTime(id: number, hours: number, comments: string): Promise<number> {
    const { time_entry } = await this.call('POST', '/time_entries.json', {
      time_entry: { issue_id: id, hours, comments }
    })
    return time_entry.id
  }
}
