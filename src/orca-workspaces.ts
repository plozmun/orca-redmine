// Finds Orca workspaces for the worker. The stable workspace key comes from the host's
// `workspace.list` when it can answer; the Orca CLI (`orca worktree list|create`, `orca project
// list`) is still needed for the Orca project (repository) a workspace belongs to, as a fallback
// for the key, and to create new worktrees.
import { RedmineError } from './redmine'

export interface WorktreeRow {
  id: string
  identity?: { key?: string } | null
  projectId?: string | null
  displayName?: string
  branch?: string
}

export interface OrcaProjectRow {
  id: string
  displayName?: string
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

/** Locates the focused workspace in the CLI listing (key and Orca project). */
export function matchWorktree(listing: OrcaListing, context: FocusedContext): LocatedWorkspace | null {
  const pick = pickRow(listing.worktrees, (w) => w.displayName, (w) => w.branch, context)
  return pick ? { workspaceKey: cliKey(pick), ...projectOf(listing, pick) } : null
}

/** The Orca project of the worktree stored under `key`, or null when the CLI does not list it. */
export function projectForKey(listing: OrcaListing, key: string): Pick<LocatedWorkspace, 'orcaProjectId' | 'orcaProjectName'> | null {
  const row = listing.worktrees.find((w) => cliKey(w) === key)
  return row ? projectOf(listing, row) : null
}

/** A row of the host's `workspace.list`. */
export interface HostWorkspaceRow {
  id: string
  kind: 'worktree' | 'folder'
  name: string
  branch: string | null
}

const HOST_ID_PREFIX = 'identity:'

/**
 * The link key for a `workspace.list` id: the host id is `identity:` + the CLI's `identity.key`
 * (checked on Orca 1.4.255). Any other shape is not trusted, so the caller falls back to the CLI.
 */
export function keyFromHostId(id: string): string | null {
  return id.startsWith(HOST_ID_PREFIX) && id.length > HOST_ID_PREFIX.length ? id.slice(HOST_ID_PREFIX.length) : null
}

/** The link key of the focused worktree in the host's listing, or null. Folders are never linked. */
export function matchHostWorkspace(rows: readonly HostWorkspaceRow[], context: FocusedContext): string | null {
  const worktrees = rows.filter((r) => r.kind === 'worktree')
  const pick = pickRow(worktrees, (r) => r.name, (r) => r.branch, context)
  return pick ? keyFromHostId(pick.id) : null
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
