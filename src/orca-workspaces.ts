// Finds Orca workspaces for the worker. The stable workspace key and, from host API 1.7, the Orca
// project come from the host's `workspace.list`; the Orca CLI (`orca worktree list|create`, `orca
// project list`) is the fallback for older Orca, and still creates new worktrees.
import { RedmineError } from './redmine'

export interface WorktreeRow {
  id: string
  identity?: { key?: string } | null
  projectId?: string | null
  displayName?: string
  branch?: string
  /** Where the worktree lives, as the CLI reports it; used to remember the workspace ids. */
  path?: string | null
}

export interface OrcaProjectRow {
  id: string
  displayName?: string
  /** The host's ids for this project's repositories (`workspace.list` `projectId`, `project.list` `id`). */
  sourceRepoIds?: string[]
}

export interface LocatedWorkspace {
  /** Stable worktree id: survives renaming the workspace. */
  workspaceKey: string
  orcaProjectId: string | null
  orcaProjectName: string | null
}

export interface OrcaListing {
  worktrees: WorktreeRow[]
  projects: OrcaProjectRow[]
}

export function shortBranch(branch: string | null | undefined): string {
  return (branch ?? '').replace(/^refs\/heads\//, '')
}

function fallbackProjectName(projectId: string): string {
  return projectId.split('/').filter(Boolean).pop() ?? projectId
}

export interface FocusedContext {
  displayName: string
  branch: string
  /** The focused workspace's `workspace.list` id, when Orca gives it (host API 1.7). */
  workspaceId?: string
}

/**
 * The one matching rule for every listing: the row with that name (and branch, when several share
 * it); else the only one on that branch.
 */
function pickRow<T>(rows: readonly T[], nameOf: (row: T) => string | undefined, branchOf: (row: T) => string | null | undefined, context: FocusedContext): T | null {
  const branch = shortBranch(context.branch)
  const byName = rows.filter((r) => nameOf(r) === context.displayName)
  const candidates = byName.length > 0 ? byName : branch ? rows.filter((r) => shortBranch(branchOf(r)) === branch) : []
  return candidates.length === 1 ? candidates[0] : (candidates.find((r) => branch && shortBranch(branchOf(r)) === branch) ?? null)
}

/** The key links are stored under, as the CLI gives it. */
function cliKey(row: WorktreeRow): string {
  return row.identity?.key || row.id
}

function projectOf(listing: OrcaListing, row: WorktreeRow): Pick<LocatedWorkspace, 'orcaProjectId' | 'orcaProjectName'> {
  const projectId = row.projectId ?? null
  const project = projectId ? listing.projects.find((p) => p.id === projectId) : undefined
  return {
    orcaProjectId: projectId,
    orcaProjectName: projectId ? (project?.displayName ?? fallbackProjectName(projectId)) : null
  }
}

/** A matched CLI row, kept so its id and path can be remembered with the link key. */
export interface MatchedWorktree {
  located: LocatedWorkspace
  /** The CLI's `<repoId>::<path>` id, as workspace events may name it. */
  id: string
  path: string | null
}

/** Locates the focused workspace in the CLI listing, with the row it came from. */
export function matchWorktreeWithRow(listing: OrcaListing, context: FocusedContext): MatchedWorktree | null {
  const row = pickRow(listing.worktrees, (w) => w.displayName, (w) => w.branch, context)
  if (!row) return null
  return {
    located: { workspaceKey: cliKey(row), ...projectOf(listing, row) },
    id: row.id,
    path: row.path ?? null
  }
}

/** Locates the focused workspace in the CLI listing (key and Orca project). */
export function matchWorktree(listing: OrcaListing, context: FocusedContext): LocatedWorkspace | null {
  return matchWorktreeWithRow(listing, context)?.located ?? null
}

/** The Orca project of the worktree stored under `key`, or null when the CLI does not list it. */
export function projectForKey(listing: OrcaListing, key: string): Pick<LocatedWorkspace, 'orcaProjectId' | 'orcaProjectName'> | null {
  const row = listing.worktrees.find((w) => cliKey(w) === key)
  return row ? projectOf(listing, row) : null
}

/**
 * A worktree named the way Orca's workspace events name it. `workspace.created` gives the CLI row's
 * `id` (`<repoId>::<path>`, checked on Orca 1.4.255), not the `identity:` form of `workspace.list`,
 * so it is matched by `id`, or by link key when one is known.
 */
export function describeWorktree(
  listing: OrcaListing,
  ref: { id?: string; key?: string | null }
): (LocatedWorkspace & { name: string | null }) | null {
  const row = listing.worktrees.find((w) => (ref.id && w.id === ref.id) || (ref.key && cliKey(w) === ref.key))
  return row ? { workspaceKey: cliKey(row), name: row.displayName ?? null, ...projectOf(listing, row) } : null
}

/** Agent state of a workspace, as `workspace.list { includeStatus: true }` reports it (host API 1.7). */
export interface HostWorkspaceStatus {
  state: 'working' | 'permission' | 'done' | 'active' | 'inactive'
  unread: boolean
}

/** A row of the host's `workspace.list`. `project`/`projectId` arrive with host API 1.7. */
export interface HostWorkspaceRow {
  id: string
  kind: 'worktree' | 'folder'
  name: string
  path?: string
  branch: string | null
  project?: string | null
  projectId?: string | null
  status?: HostWorkspaceStatus
}

/** A row of the host's `project.list` (host API 1.7). */
export interface HostProjectRow {
  id: string
  name: string
  kind: 'git' | 'folder'
  hidden?: boolean
}

const HOST_ID_PREFIX = 'identity:'

/**
 * The link key for a `workspace.list` id: the host id is `identity:` + the CLI's `identity.key`
 * (checked on Orca 1.4.255). Any other shape is not trusted, so the caller falls back to the CLI.
 */
export function keyFromHostId(id: string): string | null {
  return id.startsWith(HOST_ID_PREFIX) && id.length > HOST_ID_PREFIX.length ? id.slice(HOST_ID_PREFIX.length) : null
}

/**
 * The host's `workspace.list` id of the focused worktree (`identity:<key>`), or null. It is what
 * every other host workspace method takes, `agent.launch` included. Folders never match.
 */
export function findWorkspaceId(rows: readonly HostWorkspaceRow[], context: FocusedContext): string | null {
  return findWorkspaceRow(rows, context)?.id ?? null
}

/**
 * The focused worktree's row: by the `workspaceId` Orca gives the focused workspace (host API 1.7),
 * else by name and branch. Folders never match.
 */
export function findWorkspaceRow(rows: readonly HostWorkspaceRow[], context: FocusedContext): HostWorkspaceRow | null {
  const worktrees = rows.filter((r) => r.kind === 'worktree')
  const byId = context.workspaceId ? worktrees.find((r) => r.id === context.workspaceId) : undefined
  return byId ?? pickRow(worktrees, (r) => r.name, (r) => r.branch, context)
}

/**
 * The Orca project of a host row, or null when this Orca does not report it (host API before 1.7:
 * no `projectId` field at all). A row that reports `projectId: null` has no project.
 */
export function projectFromHostRow(row: HostWorkspaceRow): Pick<LocatedWorkspace, 'orcaProjectId' | 'orcaProjectName'> | null {
  if (row.projectId === undefined) return null
  const projectId = row.projectId
  return {
    orcaProjectId: projectId,
    orcaProjectName: projectId ? (row.project || fallbackProjectName(projectId)) : null
  }
}

/**
 * Copies project mappings stored under ids the host does not know (the CLI's logical project ids,
 * `git:<host>/<path>`, used up to 0.2.0) to the host ids of that project's repositories. Old keys
 * are kept, and a host id that already has a mapping keeps it. Null when nothing changes.
 */
export function migrateProjectKeys(
  map: Readonly<Record<string, string>>,
  hostIds: ReadonlySet<string>,
  cliProjects: readonly OrcaProjectRow[]
): Record<string, string> | null {
  const next = { ...map }
  let changed = false
  for (const [key, redmineProject] of Object.entries(map)) {
    if (hostIds.has(key)) continue
    const project = cliProjects.find((p) => p.id === key)
    for (const repoId of project?.sourceRepoIds ?? []) {
      if (next[repoId] !== undefined) continue
      next[repoId] = redmineProject
      changed = true
    }
  }
  return changed ? next : null
}

/** Project ids in a mapping that the host does not list: the ones a migration would look up. */
export function unknownProjectKeys(map: Readonly<Record<string, string>>, hostIds: ReadonlySet<string>): string[] {
  return Object.keys(map).filter((key) => !hostIds.has(key))
}

/**
 * The CLI project id `orca worktree create --project` takes for a project picked by its host id
 * (a repository id). An id the CLI already lists, or one it does not know, is passed unchanged.
 */
export function cliProjectIdFor(id: string, cliProjects: readonly OrcaProjectRow[]): string {
  if (cliProjects.some((p) => p.id === id)) return id
  return cliProjects.find((p) => p.sourceRepoIds?.includes(id))?.id ?? id
}

/** The link key of the focused worktree in the host's listing, or null. Folders are never linked. */
export function matchHostWorkspace(rows: readonly HostWorkspaceRow[], context: FocusedContext): string | null {
  const id = findWorkspaceId(rows, context)
  return id ? keyFromHostId(id) : null
}

const CLI_CANDIDATES = [process.env.ORCA_CLI, 'orca', '/usr/local/bin/orca', '/opt/homebrew/bin/orca'].filter(
  (c): c is string => Boolean(c)
)

/** Runs `orca <args> --json` and returns `result`. Failures throw RedmineError('orca_cli' | 'timeout'). */
export async function runOrcaJson(args: string[], timeoutMs = 10_000): Promise<any> {
  const { execFile } = await import('node:child_process')
  let lastError: unknown
  for (const cli of CLI_CANDIDATES) {
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(cli, [...args, '--json'], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, out) =>
          // The CLI may exit non-zero and still print `ok: true` JSON (host scope notes).
          out ? resolve(out) : reject(err ?? new Error('no output'))
        )
      })
      const data = JSON.parse(stdout)
      if (!data.ok) throw new Error(data.error?.message ?? 'orca returned an error')
      return data.result
    } catch (error) {
      lastError = error
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') break
    }
  }
  const killed = (lastError as { killed?: boolean } | undefined)?.killed
  const detail = lastError instanceof Error ? lastError.message : String(lastError)
  throw new RedmineError(killed ? 'timeout' : 'orca_cli', detail)
}

let cache: { at: number; listing: OrcaListing } | null = null

/** Orca worktrees and projects, cached for 15 s. */
export async function listOrca(): Promise<OrcaListing> {
  if (cache && Date.now() - cache.at < 15_000) return cache.listing
  const [wt, pr] = await Promise.all([runOrcaJson(['worktree', 'list', '--limit', '1000']), runOrcaJson(['project', 'list'])])
  const listing = { worktrees: wt.worktrees ?? [], projects: pr.projects ?? [] }
  cache = { at: Date.now(), listing }
  return listing
}

export function clearOrcaCache(): void {
  cache = null
}

export interface CreateWorktreeOptions {
  orcaProjectId: string
  name: string
  agent: string | null
  prompt: string
  baseBranch?: string
  comment?: string
  activate: boolean
}

export interface CreatedWorktree {
  workspaceKey: string | null
  displayName: string | null
  branch: string | null
  path: string | null
  /** What started: 'structured' (chat), 'terminal', or null when no agent was requested. */
  launch: string | null
}

export function createWorktreeArgs(o: CreateWorktreeOptions): string[] {
  const args = ['worktree', 'create', '--project', o.orcaProjectId, '--name', o.name, '--no-parent']
  if (o.agent) args.push('--agent', o.agent, '--prompt', o.prompt)
  if (o.baseBranch?.trim()) args.push('--base-branch', o.baseBranch.trim())
  if (o.comment) args.push('--comment', o.comment)
  if (o.activate) args.push('--activate')
  return args
}

/** First object in the reply shaped like a worktree (has `identity.key`, or `path` and `branch`). */
function findWorktree(value: any, depth = 0): any {
  if (!value || typeof value !== 'object' || depth > 4) return null
  if (value.identity?.key || (typeof value.path === 'string' && 'branch' in value)) return value
  for (const key of ['worktree', 'workspace', 'result']) {
    const found = findWorktree(value[key], depth + 1)
    if (found) return found
  }
  return null
}

export function parseCreated(result: any): CreatedWorktree {
  const wt = findWorktree(result)
  return {
    workspaceKey: wt?.identity?.key ?? wt?.id ?? null,
    displayName: wt?.displayName ?? null,
    branch: wt?.branch ? shortBranch(wt.branch) : null,
    path: wt?.path ?? null,
    launch: result?.launch?.outcome?.kind ?? (result?.agentTerminalHandle ? 'terminal' : null)
  }
}

/**
 * Creates the worktree (and launches the agent) through the Orca CLI. Gives up after 115 s, before
 * the 120 s a panel request may wait at most.
 */
export async function createWorktree(o: CreateWorktreeOptions): Promise<CreatedWorktree> {
  const created = parseCreated(await runOrcaJson(createWorktreeArgs(o), 115_000))
  clearOrcaCache()
  return created
}

/** What the task list shows about a linked workspace's agent. */
export type AgentState = 'working' | 'permission' | 'done'

const AGENT_STATE_RANK: Record<AgentState, number> = { permission: 3, working: 2, done: 1 }

/** The badge a workspace status earns: working, waiting for permission, or done and not yet seen. */
function agentStateOf(status: HostWorkspaceStatus | undefined): AgentState | null {
  if (!status) return null
  if (status.state === 'working' || status.state === 'permission') return status.state
  return status.state === 'done' && status.unread ? 'done' : null
}

/**
 * Agent state per linked task (by task number), from `workspace.list { includeStatus: true }` and the
 * link store. A task linked to several workspaces shows the one that most needs the person:
 * permission, then working, then done.
 */
export function agentStatesFor(
  rows: readonly HostWorkspaceRow[],
  links: Readonly<Record<string, { id: number }>>
): Record<string, AgentState> {
  const states: Record<string, AgentState> = {}
  for (const row of rows) {
    const key = keyFromHostId(row.id)
    const issue = key ? links[key] : undefined
    const state = agentStateOf(row.status)
    if (!issue || !state) continue
    const current = states[String(issue.id)]
    if (!current || AGENT_STATE_RANK[state] > AGENT_STATE_RANK[current]) states[String(issue.id)] = state
  }
  return states
}
