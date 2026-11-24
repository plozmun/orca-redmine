// The plugin's worker (Node). The only part with network access: it talks to the Redmine REST API
// and runs the `orca` CLI. The URL lives in the plugin settings; the API key in its encrypted
// secrets (OS keychain). Errors are thrown as RedmineError codes for the panel to translate.
import type { OrcaWorkerApi } from 'orca/worker'
import { systemLocale, translate, translateErrorCode } from './i18n'
import { LaunchedTasks, pathFromCliId, withIssueEnv, withPromptPointer } from './agent-env'
import { detectRedmineCli, writeContextFile } from './agent-files'
import { asCommentsMode, buildContextBlock, buildLaunchPrompt, CONTEXT_MAX_CHARS, sendPrompt, workspaceNameFor } from './launch'
import {
  agentStatesFor,
  clearOrcaCache,
  describeWorktree,
  findWorkspaceId,
  findWorkspaceRow,
  listOrca,
  keyFromHostId,
  matchWorktreeWithRow,
  migrateProjectKeys,
  projectForKey,
  projectFromHostRow,
  unknownProjectKeys,
  runOrcaJson,
  shortBranch,
  type FocusedContext,
  type HostProjectRow,
  type HostWorkspaceRow,
  type LocatedWorkspace,
  type OrcaListing
} from './orca-workspaces'
import { contextFilePrompt, fitsLaunchPrompt } from './launch-here'
import type { ConnectionStatus, TaskAgent, TaskWorkspaceAgents } from './protocol'
import { isBookableDay } from './days'
import { normalizeBaseUrl, projectSubtree, RedmineClient, RedmineError, type IssueDetail, type OpenCounts } from './redmine'
import { branchFromTemplate, taskRefFromWorkspace, workspaceNameFor as workspaceNameFromTask } from './task-ref'
import { ISSUE_BY_WORKSPACE, PROJECT_BY_ORCA_PROJECT, PROJECT_KEYS_MIGRATED, WORKSPACE_IDS_BY_KEY, type AssignedIssue } from './links'
import {
  addFollowup,
  AgentRunTracker,
  asAgentNotification,
  asFollowups,
  createFollowup,
  dismissFollowup,
  FOLLOWUPS_KEY,
  recordsFollowup,
  shouldNotify,
  type AgentTransition,
  type Followup,
  type NewFollowup
} from './followups'
import { pickPluginKey, type ListedPlugin } from './plugin-key'

let orcaLister: () => Promise<OrcaListing> = listOrca
let orcaRunner: (args: string[]) => Promise<unknown> = (args) => runOrcaJson(args)

/** Tests: replaces the Orca CLI listing. */
export function setOrcaLister(lister: () => Promise<OrcaListing>): void {
  orcaLister = lister
}

/** Tests: replaces the `orca` CLI runner (panel opening). */
export function setOrcaRunner(runner: (args: string[]) => Promise<unknown>): void {
  orcaRunner = runner
}

let redmineCli: () => Promise<string | null> = detectRedmineCli
let contextDir: string | undefined

/** Tests: replaces the `redmine --version` check. */
export function setRedmineCliDetector(detector: () => Promise<string | null>): void {
  redmineCli = detector
}

/** Tests: where the context files for "Send to agent" go (default: `<tmp>/orca-redmine`). */
export function setContextDir(dir: string | undefined): void {
  contextDir = dir
}

/** Tests: pretends this Orca offers `workspace.rename` or not, as an older host would not. */
let renameOffered: boolean | null = null
export function setRenameOffered(offered: boolean | null): void {
  renameOffered = offered
}

/** Whether this Orca can rename a workspace (`workspace.rename`, host API 1.5). */
function hasRename(orca: OrcaWorkerApi): boolean {
  return renameOffered ?? orca.host.has('workspace.rename')
}

const URL_SETTING = 'url'
const LIMIT_SETTING = 'limit'
const API_KEY = 'apiKey'
const SEND_PROMPT_SETTING = 'sendPrompt'
const COMMENTS_SETTING = 'contextComments'
const MAX_CHARS_SETTING = 'contextMaxChars'
const BRANCH_TEMPLATE_SETTING = 'branchTemplate'
const WORKSPACE_NAME_SETTING = 'workspaceNameTemplate'
const ON_CREATED_SETTING = 'onWorkspaceCreated'
const PROMPT_POINTER_SETTING = 'promptPointer'
const AGENT_NOTIFICATION_SETTING = 'agentNotification'
const STATUS_BAR_SETTING = 'statusBar'
const STATUS_BAR_MINUTES_SETTING = 'statusBarMinutes'
/** The `contributes.statusBarItems` id this worker updates (`statusBar.update`). */
const STATUS_BAR_ID = 'open-tasks'
/** The `contributes.panels` id the item opens. */
const PANEL_ID = 'redmine'
/** Refresh interval when `statusBarMinutes` says nothing; the manifest offers 1–60. */
const STATUS_BAR_MINUTES = 5
/** A hook must answer within 2 s; the Redmine lookup gets this much of it. */
const HOOK_BUDGET_MS = 1500

async function stringSetting(orca: OrcaWorkerApi, key: string): Promise<string | null> {
  const value = await orca.settings.get(key)
  return typeof value === 'string' && value.trim() ? value : null
}

function errorParts(error: unknown): { errorCode: string; errorDetail: string } {
  const code = (error as { code?: unknown })?.code
  return {
    errorCode: typeof code === 'string' ? code : 'unknown',
    errorDetail: error instanceof Error ? error.message : String(error)
  }
}

async function savedUrl(orca: OrcaWorkerApi): Promise<string | null> {
  const url = await orca.settings.get(URL_SETTING)
  return typeof url === 'string' && url.trim() ? url.trim() : null
}

/** The context options from Settings, as the agent gets them. */
async function contextOptions(orca: OrcaWorkerApi) {
  const maxChars = await orca.settings.get(MAX_CHARS_SETTING)
  return {
    comments: asCommentsMode(await orca.settings.get(COMMENTS_SETTING)),
    maxChars: typeof maxChars === 'number' ? maxChars : CONTEXT_MAX_CHARS
  }
}

async function client(orca: OrcaWorkerApi): Promise<RedmineClient> {
  const url = await savedUrl(orca)
  const key = await orca.secrets.get(API_KEY)
  if (!url || !key) throw new RedmineError('not_configured', 'Missing Redmine URL or API key')
  return new RedmineClient(url, key)
}

async function status(orca: OrcaWorkerApi): Promise<ConnectionStatus> {
  const url = await savedUrl(orca)
  const key = await orca.secrets.get(API_KEY)
  if (!url || !key) return { configured: false, url, user: null }
  try {
    const user = await new RedmineClient(url, key).currentUser()
    return { configured: true, url, user: { login: user.login, name: user.name } }
  } catch (error) {
    return { configured: false, url, user: null, ...errorParts(error) }
  }
}

/** A workspace matched for the focused context: the link key plus the ids Orca events name it by. */
interface LocatedWorkspaceMatch {
  key: string
  id: string
  path: string | null
  /** The Orca project from the host row; null when this Orca does not report it (host API < 1.7). */
  project: Pick<LocatedWorkspace, 'orcaProjectId' | 'orcaProjectName'> | null
}

/** Minutes between status bar refreshes: the `statusBarMinutes` setting, 1–60, 5 by default. */
async function statusBarMinutes(orca: OrcaWorkerApi): Promise<number> {
  const value = await orca.settings.get(STATUS_BAR_MINUTES_SETTING)
  if (typeof value !== 'number' || !Number.isFinite(value)) return STATUS_BAR_MINUTES
  return Math.min(60, Math.max(1, Math.round(value)))
}

/** Urgent work first, then overdue, then nothing that needs attention. */
function statusBarTone(counts: OpenCounts): 'neutral' | 'warning' | 'danger' {
  if (counts.urgent > 0) return 'danger'
  return counts.overdue > 0 ? 'warning' : 'neutral'
}

/** The count, plus the overdue and urgent counts when there are any: what the tone is about. */
function statusBarTooltip(locale: string, counts: OpenCounts): string {
  const parts = [translate(locale, 'statusBar.tooltip', { total: counts.total })]
  if (counts.overdue > 0) parts.push(translate(locale, 'statusBar.overdue', { count: counts.overdue }))
  if (counts.urgent > 0) parts.push(translate(locale, 'statusBar.urgent', { count: counts.urgent }))
  return parts.join(' · ')
}

/**
 * Updates the `open-tasks` status bar item: the number of my open tasks, the tone of what needs
 * attention and a tooltip saying why. Hidden when the item is turned off or there is no saved
 * connection; a failed refresh shows the reason instead of a stale count. Never throws, and a
 * missing status bar (the web client) only logs: no panel request may fail for it.
 */
/** How long the list header reuses the last count before asking Redmine again. */
const COUNTS_MAX_AGE_MS = 60_000

async function refreshStatusBar(orca: OrcaWorkerApi, onCounts: (counts: OpenCounts) => void): Promise<void> {
  const locale = systemLocale()
  let update: { text?: string; tone?: 'neutral' | 'warning' | 'danger'; tooltip?: string; visible: boolean }
  try {
    const enabled = await orca.settings.get(STATUS_BAR_SETTING)
    if (enabled === false || !(await savedUrl(orca)) || !(await orca.secrets.get(API_KEY))) {
      update = { visible: false }
    } else {
      const counts = await (await client(orca)).openCounts()
      onCounts(counts)
      update = {
        text: String(counts.total),
        tone: statusBarTone(counts),
        tooltip: statusBarTooltip(locale, counts),
        visible: true
      }
    }
  } catch (error) {
    const parts = errorParts(error)
    orca.log(`statusBar: ${parts.errorDetail}`)
    const reason = translateErrorCode(locale, parts.errorCode, parts.errorDetail) ?? translate(locale, 'statusBar.error', { reason: parts.errorDetail })
    update = { text: '', tone: 'warning', tooltip: reason.slice(0, 250), visible: true }
  }
  try {
    await orca.host.call('statusBar.update', { id: STATUS_BAR_ID, ...update })
  } catch (error) {
    orca.log(`statusBar.update: ${errorParts(error).errorDetail}`)
  }
}

/** The palette text: my open tasks, or why there are none to list. */
async function myIssuesText(orca: OrcaWorkerApi, locale: string): Promise<string> {
  if (!(await savedUrl(orca)) || !(await orca.secrets.get(API_KEY))) return translate(locale, 'command.notConfigured')
  const { issues, total } = await (await client(orca)).listIssues({ mine: true, limit: 20 })
  if (issues.length === 0) return translate(locale, 'command.noIssues')
  const lines = issues.map((i) => `#${i.id} [${i.status}] ${i.subject} (${i.project})`)
  return [translate(locale, 'command.header', { total }), ...lines].join('\n')
}

/**
 * The focused workspace's link key from the host's `workspace.list`, without the CLI. Null when the
 * host cannot say (older Orca, a refusal, or a truncated listing without it): the CLI decides then.
 */
async function hostWorkspaceMatch(orca: OrcaWorkerApi, context: FocusedContext): Promise<LocatedWorkspaceMatch | null> {
  if (!orca.host.has('workspace.list')) return null
  try {
    const { workspaces } = (await orca.host.call('workspace.list', {})) as { workspaces: HostWorkspaceRow[]; truncated: boolean }
    const row = findWorkspaceRow(workspaces, context)
    const key = row ? keyFromHostId(row.id) : null
    if (!row || !key) return null
    return { key, id: row.id, path: row.path ?? null, project: projectFromHostRow(row) }
  } catch (error) {
    orca.log(`workspace.list: ${errorParts(error).errorDetail}`)
    return null
  }
}

/** The focused workspace's id from `workspace.list`: what `agent.launch` (and Orca's other methods) take. */
async function hostWorkspaceId(orca: OrcaWorkerApi, context: FocusedContext): Promise<string | null> {
  if (!orca.host.has('workspace.list')) return null
  try {
    const { workspaces } = (await orca.host.call('workspace.list', {})) as { workspaces: HostWorkspaceRow[] }
    return findWorkspaceId(workspaces, context)
  } catch (error) {
    orca.log(`workspace.list: ${errorParts(error).errorDetail}`)
    return null
  }
}

/** The CLI-only lookup: key, Orca project and row from `orca worktree list`, asking again on a miss. */
async function locateWithCli(context: FocusedContext) {
  const located = matchWorktreeWithRow(await orcaLister(), context)
  if (located) return located
  // It may be a brand-new workspace: ask again without the cache.
  clearOrcaCache()
  return matchWorktreeWithRow(await orcaLister(), context)
}

/**
 * Stores the ids a located workspace is named by, so a later `workspace.removed` can still find its
 * link. Best effort: a storage problem must not fail the locate, which the panel needs.
 */
function rememberLocatedIds(orca: OrcaWorkerApi, key: string, ids: readonly (string | null | undefined)[]): void {
  void rememberWorkspaceIds(orca, key, ids).catch((error) => orca.log(`locateWorkspace (ids): ${errorParts(error).errorDetail}`))
}

/** The Orca project of a workspace already identified by the host, asking again on a miss. */
async function projectWithCli(key: string) {
  const project = projectForKey(await orcaLister(), key)
  if (project) return project
  clearOrcaCache()
  return projectForKey(await orcaLister(), key)
}

/**
 * The host's project ids (repository ids): `project.list`, else the projects `workspace.list` names.
 */
async function hostProjectIds(orca: OrcaWorkerApi): Promise<Set<string>> {
  if (orca.host.has('project.list')) {
    const { projects } = (await orca.host.call('project.list', {})) as { projects: HostProjectRow[] }
    return new Set(projects.map((p) => p.id))
  }
  const { workspaces } = (await orca.host.call('workspace.list', {})) as { workspaces: HostWorkspaceRow[] }
  return new Set(workspaces.map((w) => w.projectId).filter((id): id is string => Boolean(id)))
}

/**
 * Up to 0.2.0 project mappings were stored under the CLI's project ids (`git:<host>/<path>`); the
 * host names projects by repository id. Copies each old mapping to its repositories' ids, once:
 * the flag is set only after the CLI answered (or nothing needed it), so a failure retries later.
 * Mappings could only be made with the CLI, so it is normally there for this one run.
 */
async function migrateProjectMappings(orca: OrcaWorkerApi): Promise<void> {
  if ((await orca.storage.get(PROJECT_KEYS_MIGRATED)) === true) return
  try {
    const map = await readMap<string>(orca, PROJECT_BY_ORCA_PROJECT)
    const hostIds = await hostProjectIds(orca)
    if (unknownProjectKeys(map, hostIds).length > 0) {
      const next = migrateProjectKeys(map, hostIds, (await orcaLister()).projects)
      if (next) {
        // Read again right before writing: the panel may have mapped a project meanwhile.
        await orca.storage.set(PROJECT_BY_ORCA_PROJECT, { ...next, ...(await readMap<string>(orca, PROJECT_BY_ORCA_PROJECT)) })
        orca.log(`project mappings: copied to the host project ids`)
      }
    }
    await orca.storage.set(PROJECT_KEYS_MIGRATED, true)
  } catch (error) {
    orca.log(`project mappings: ${errorParts(error).errorDetail}`)
  }
}

/** Rejects with `timeout` after `ms`; the work itself is not cancelled. */
function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RedmineError('timeout', `no answer in ${ms} ms`)), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

async function readMap<T>(orca: OrcaWorkerApi, key: string): Promise<Record<string, T>> {
  const value = await orca.storage.get(key)
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, T>) : {}
}

/**
 * Link key, name and Orca project of a just-created worktree. The event's `workspaceId` is the CLI
 * row id (`<repoId>::<path>`) on Orca 1.4.255, though the `identity:` form is accepted too; the host
 * listing (matched by id or path) and the CLI listing each fill in what they can.
 */
async function describeCreated(orca: OrcaWorkerApi, workspaceId: string, path: string) {
  let key = keyFromHostId(workspaceId)
  let name: string | null = null
  let orcaProjectId: string | null = null
  let projectKnown = false
  if (orca.host.has('workspace.list')) {
    try {
      const { workspaces } = (await orca.host.call('workspace.list', {})) as { workspaces: HostWorkspaceRow[] }
      const row = workspaces.find((w) => w.id === workspaceId) ?? workspaces.find((w) => w.path === path)
      if (row) {
        key ??= keyFromHostId(row.id)
        name = row.name
        const project = projectFromHostRow(row)
        if (project) {
          orcaProjectId = project.orcaProjectId
          projectKnown = true
        }
      }
    } catch (error) {
      orca.log(`workspace.list: ${errorParts(error).errorDetail}`)
    }
  }
  // Host API 1.7 told everything: no CLI.
  if (key && name && projectKnown) return { key, name, orcaProjectId }
  try {
    clearOrcaCache()
    const found = describeWorktree(await orcaLister(), { id: workspaceId, key })
    if (found) {
      key ??= found.workspaceKey
      name ??= found.name
      if (!projectKnown) orcaProjectId = found.orcaProjectId
    }
  } catch (error) {
    orca.log(`workspace.created (CLI): ${errorParts(error).errorDetail}`)
  }
  return { key, name: name ?? path.split(/[\\/]/).filter(Boolean).pop() ?? '', orcaProjectId }
}

/** Whether the task belongs to the Redmine project mapped to that Orca project (or no mapping). */
async function inMappedProject(orca: OrcaWorkerApi, redmine: RedmineClient, orcaProjectId: string | null, issue: IssueDetail) {
  const mapped = orcaProjectId ? (await readMap<string>(orca, PROJECT_BY_ORCA_PROJECT))[orcaProjectId] : undefined
  if (!mapped) return true
  return projectSubtree(await redmine.listProjects(), mapped).has(issue.projectId)
}

/**
 * The `onWorkspaceCreated` setting: a comment naming the workspace, and with `start` a move from
 * the first open status (New) to the next open one. A refused move keeps the comment.
 */
async function recordWorkStarted(orca: OrcaWorkerApi, redmine: RedmineClient, issue: IssueDetail, name: string, branch: string) {
  const mode = await orca.settings.get(ON_CREATED_SETTING)
  if (mode !== 'comment' && mode !== 'start') return
  await redmine.updateIssue(issue.id, { notes: translate(systemLocale(), 'redmine.workStarted', { name, branch }) })
  if (mode === 'start') {
    const open = (await redmine.statuses()).filter((s) => !s.isClosed)
    if (open.length > 1 && issue.statusId === open[0].id) {
      try {
        await redmine.updateIssue(issue.id, { statusId: open[1].id })
      } catch (error) {
        orca.log(`#${issue.id} start: ${errorParts(error).errorDetail}`)
      }
    }
  }
  orca.panels.post('redmine.issueChanged', { id: issue.id })
}

/**
 * The link key of a workspace named in `agent.launch.before`: the `identity:` form carries it; the
 * CLI form (`<repoId>::<path>`) needs the host listing, by id or path, as `describeCreated` does.
 * No CLI and no network: an agent start is never slowed down.
 */
async function launchWorkspaceKey(orca: OrcaWorkerApi, workspaceId: string | null): Promise<string | null> {
  if (!workspaceId) return null
  const key = keyFromHostId(workspaceId)
  if (key) return key
  const path = pathFromCliId(workspaceId)
  if (!path || !orca.host.has('workspace.list')) return null
  try {
    const { workspaces } = (await orca.host.call('workspace.list', {})) as { workspaces: HostWorkspaceRow[] }
    const row = workspaces.find((w) => w.id === workspaceId) ?? workspaces.find((w) => w.path === path)
    return row ? keyFromHostId(row.id) : null
  } catch (error) {
    orca.log(`workspace.list: ${errorParts(error).errorDetail}`)
    return null
  }
}

/** The task linked to an `agent.launch.before` workspace, read from the plugin's storage only. */
async function linkedTask(orca: OrcaWorkerApi, workspaceId: string | null): Promise<AssignedIssue | null> {
  const key = await launchWorkspaceKey(orca, workspaceId)
  if (!key) return null
  return (await readMap<AssignedIssue>(orca, ISSUE_BY_WORKSPACE))[key] ?? null
}

// --- Follow-ups: agent finished, workspace removed ---

async function storedFollowups(orca: OrcaWorkerApi): Promise<Followup[]> {
  return asFollowups(await orca.storage.get(FOLLOWUPS_KEY))
}

/** Writes the list and tells open panels; follow-ups are the worker's, the panel only shows them. */
async function saveFollowups(orca: OrcaWorkerApi, followups: Followup[]): Promise<void> {
  await orca.storage.set(FOLLOWUPS_KEY, followups)
  orca.panels.post('redmine.followupsChanged', { followups })
}

async function recordFollowup(orca: OrcaWorkerApi, input: NewFollowup): Promise<void> {
  await saveFollowups(orca, addFollowup(await storedFollowups(orca), createFollowup(input)))
}

function lastPathSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/**
 * Remembers which Orca ids name a linked workspace: `workspace.created` and `agent.status.changed`
 * use the CLI id (`<repoId>::<path>`) or `identity:<key>`, and `workspace.removed` arrives after the
 * worktree is gone from the listings, so the path is the only way back to the link key.
 */
async function rememberWorkspaceIds(orca: OrcaWorkerApi, key: string, ids: readonly (string | null | undefined)[]): Promise<void> {
  const map = await readMap<string>(orca, WORKSPACE_IDS_BY_KEY)
  const next = { ...map }
  let changed = false
  for (const id of ids) {
    if (!id || !id.trim() || next[id] === key) continue
    next[id] = key
    changed = true
  }
  if (changed) await orca.storage.set(WORKSPACE_IDS_BY_KEY, next)
}

/** Drops a removed workspace's ids (and anything else still pointing at its key). */
async function forgetWorkspaceIds(orca: OrcaWorkerApi, key: string | null, ids: readonly (string | null | undefined)[]): Promise<void> {
  const map = await readMap<string>(orca, WORKSPACE_IDS_BY_KEY)
  const next = { ...map }
  let changed = false
  for (const [alias, value] of Object.entries(next)) {
    if ((key !== null && value === key) || ids.includes(alias)) {
      delete next[alias]
      changed = true
    }
  }
  if (changed) await orca.storage.set(WORKSPACE_IDS_BY_KEY, next)
}

async function mappedWorkspaceKey(orca: OrcaWorkerApi, workspaceId: string, path?: string | null): Promise<string | null> {
  const map = await readMap<string>(orca, WORKSPACE_IDS_BY_KEY)
  const fromId = pathFromCliId(workspaceId)
  return map[workspaceId] ?? (fromId ? map[fromId] : null) ?? (path ? (map[path] ?? null) : null)
}

/** The `workspace.list` id an event names the workspace by (host API 1.7), when Orca sends it. */
function listedId(event: object): string | null {
  const id = (event as { workspaceListId?: unknown }).workspaceListId
  return typeof id === 'string' && id ? id : null
}

/**
 * The link key an Orca workspace event names: `identity:<key>` directly, else the alias map, else
 * the CLI listing while the worktree still exists. Null when the workspace is unknown.
 */
async function eventWorkspaceKey(orca: OrcaWorkerApi, workspaceId: string, path?: string | null): Promise<string | null> {
  const direct = keyFromHostId(workspaceId)
  if (direct) return direct
  const mapped = await mappedWorkspaceKey(orca, workspaceId, path)
  if (mapped) return mapped
  try {
    const found = describeWorktree(await orcaLister(), { id: workspaceId })
    if (found) return found.workspaceKey
  } catch (error) {
    orca.log(`workspace event (CLI): ${errorParts(error).errorDetail}`)
  }
  return null
}

/** A workspace's name and path, from the host listing when it knows the workspace, else the CLI. */
async function workspaceInfoFor(orca: OrcaWorkerApi, workspaceId: string, key: string): Promise<{ name: string; path: string | null }> {
  if (orca.host.has('workspace.list')) {
    try {
      const { workspaces } = (await orca.host.call('workspace.list', {})) as { workspaces: HostWorkspaceRow[] }
      const row = workspaces.find((w) => w.id === workspaceId) ?? workspaces.find((w) => keyFromHostId(w.id) === key)
      if (row) return { name: row.name, path: row.path ?? null }
    } catch (error) {
      orca.log(`workspace.list: ${errorParts(error).errorDetail}`)
    }
  }
  try {
    const found = describeWorktree(await orcaLister(), { id: workspaceId, key })
    if (found?.name) return { name: found.name, path: null }
  } catch (error) {
    orca.log(`workspace event (CLI): ${errorParts(error).errorDetail}`)
  }
  return { name: key, path: null }
}

// --- Agents of a task's linked workspaces, and resuming one from a follow-up ---

/** A task can be linked to several workspaces; its detail lists at most this many, newest first. */
const MAX_TASK_WORKSPACES = 5

/** A row of the host's `agents.list` (host API 1.10). */
interface HostAgentRow {
  terminalId: string | null
  title: string | null
  agent: string | null
  state: TaskAgent['state']
  stateStartedAt: number
  sessionId?: string | null
}

/** Agent kinds `agent.resume` takes (host API 1.10). Any other kind leaves the follow-up without one. */
const RESUMABLE_AGENTS: ReadonlySet<string> = new Set([
  'claude',
  'codebuddy',
  'codex',
  'qoder',
  'qoder-cn',
  'qwen-code',
  'gemini',
  'antigravity',
  'opencode',
  'opencode2',
  'pi',
  'mimo-code',
  'droid',
  'grok',
  'devin',
  'omp',
  'prime-agent',
  'copilot',
  'cursor',
  'kimi',
  'muse',
  'zcode',
  'dsh',
  'jcode',
  'kiro',
  'hermes'
])

function resumableAgentKind(kind: string | null | undefined): string | null {
  return kind && RESUMABLE_AGENTS.has(kind) ? kind : null
}

/** The host row without its task and session: what the panel lists. */
function taskAgentOf(row: HostAgentRow): TaskAgent {
  return {
    terminalId: row.terminalId,
    title: row.title,
    agent: row.agent,
    state: row.state,
    stateStartedAt: row.stateStartedAt
  }
}

/**
 * `agents.list` for one workspace: the agents Orca reports there, or null when this Orca does not
 * offer the method or refuses the id (a workspace removed while Orca was closed, say).
 */
async function listedAgents(orca: OrcaWorkerApi, workspaceId: string): Promise<HostAgentRow[] | null> {
  if (!orca.host.has('agents.list')) return null
  try {
    const { agents } = (await orca.host.call('agents.list', { workspaceId })) as { agents: HostAgentRow[] }
    return agents
  } catch (error) {
    orca.log(`agents.list ${workspaceId}: ${errorParts(error).errorDetail}`)
    return null
  }
}

/** The names of the host's workspaces by `workspace.list` id; empty when Orca cannot list them. */
async function hostWorkspaceNames(orca: OrcaWorkerApi): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  if (!orca.host.has('workspace.list')) return names
  try {
    const { workspaces } = (await orca.host.call('workspace.list', {})) as { workspaces: HostWorkspaceRow[] }
    for (const row of workspaces) names.set(row.id, row.name)
  } catch (error) {
    orca.log(`workspace.list: ${errorParts(error).errorDetail}`)
  }
  return names
}

/**
 * The agent kind of a finished pane: the workspace's agent with that terminal, else with that
 * session. Null when Orca no longer lists it, or lists a kind `agent.resume` does not take.
 */
async function agentKindFor(
  orca: OrcaWorkerApi,
  workspaceId: string,
  terminalId: string | null,
  sessionId: string | null
): Promise<string | null> {
  const agents = await listedAgents(orca, workspaceId)
  if (!agents) return null
  const row =
    (terminalId ? agents.find((a) => a.terminalId === terminalId) : undefined) ??
    (sessionId ? agents.find((a) => a.sessionId === sessionId) : undefined)
  return resumableAgentKind(row?.agent)
}

/** The session an `agent.status.changed` event names (host API 1.8), when it comes. */
function sessionIdOf(event: object): string | null {
  const id = (event as { sessionId?: unknown }).sessionId
  return typeof id === 'string' && id ? id : null
}

/** A terminal an `agent.status.changed` event names, when it comes. */
function terminalIdOf(event: object): string | null {
  const id = (event as { terminalId?: unknown }).terminalId
  return typeof id === 'string' && id ? id : null
}

/** A desktop notification naming the task, in the machine's language. Never description text. */
async function notifyAgent(orca: OrcaWorkerApi, transition: AgentTransition['transition'], issue: AssignedIssue): Promise<void> {
  const key = transition === 'done' ? 'notification.agentDone' : 'notification.agentBlocked'
  try {
    await orca.host.call('notifications.show', { title: translate(systemLocale(), key, { id: issue.id, subject: issue.subject }) })
  } catch (error) {
    orca.log(`notifications.show: ${errorParts(error).errorDetail}`)
  }
}

// --- Creating with the host (`workspace.create`) and showing a workspace (`workspace.open`) ---

/**
 * Links a workspace key to the task. Reads the store again right before writing: the panel may have
 * linked the workspace meanwhile (a launch answers after the workspace exists).
 */
async function linkWorkspace(orca: OrcaWorkerApi, key: string, issue: Pick<IssueDetail, 'id' | 'subject'>): Promise<void> {
  const links = await readMap<AssignedIssue>(orca, ISSUE_BY_WORKSPACE)
  await orca.storage.set(ISSUE_BY_WORKSPACE, { ...links, [key]: { id: issue.id, subject: issue.subject } })
}

/**
 * The `identity:<key>` workspace id an error names: `workspace.create` reports that form when the
 * workspace exists but the agent failed to start. Null for any other error.
 */
function workspaceIdInError(error: unknown): string | null {
  const text = error instanceof Error ? error.message : String(error)
  const match = text.match(/identity:[^\s"'`,;)]+/)
  return match ? match[0].replace(/[.,:;]+$/, '') : null
}

/** Whether this Orca offers `workspace.open` and the person approved `workspace:write`. */
function canOpenWorkspace(orca: OrcaWorkerApi): boolean {
  return orca.host.has('workspace.open') && orca.grantedCapabilities.includes('workspace:write')
}

/** A workspace key linked to the task (any of them), or null. */
async function linkedKeyForTask(orca: OrcaWorkerApi, issueId: number): Promise<string | null> {
  const links = await readMap<AssignedIssue>(orca, ISSUE_BY_WORKSPACE)
  return Object.keys(links).find((key) => links[key]?.id === issueId) ?? null
}

export default function activate(orca: OrcaWorkerApi): void {
  /** Workspaces whose work start was already recorded in this run (the event may repeat). */
  const started = new Set<string>()
  /** First `working` time per pane, for the working time pre-filled when the agent finishes. */
  const agentRuns = new AgentRunTracker()

  // The last count of my tasks, shared by the status bar and the list header's tiles. Panels hear
  // every new count, so a refresh for the status bar also updates an open list.
  let lastCounts: { counts: OpenCounts; at: number } | null = null
  const rememberCounts = (counts: OpenCounts): void => {
    lastCounts = { counts, at: Date.now() }
    orca.panels.post('redmine.countsChanged', counts)
  }

  // Status bar: one refresh at a time, whether a panel change or the interval asked for it, so a
  // slow Redmine is not asked twice for the same count.
  let refreshing: Promise<void> | null = null
  let refreshAgain = false
  const refreshOnce = (afterChange = false): Promise<void> => {
    if (refreshing) {
      // A refresh already under way may have counted before a panel change: run one more after it.
      if (afterChange) refreshAgain = true
      return refreshing
    }
    refreshing = refreshStatusBar(orca, rememberCounts).finally(() => {
      refreshing = null
      if (refreshAgain) {
        refreshAgain = false
        void refreshOnce()
      }
    })
    return refreshing
  }
  /**
   * After a change made from the panel: the panel's answer never waits for the count. The cached
   * count is dropped, so the list header asks again even with the status bar turned off.
   */
  const refreshSoon = (): void => {
    lastCounts = null
    void refreshOnce(true)
  }
  /**
   * Refreshes the item now and again after `statusBarMinutes` (re-read on every tick, so a change in
   * Settings applies at the next one). The next tick is armed before the refresh: a slow Redmine
   * never stops the loop, and Orca's process is not kept alive by it.
   */
  let statusBarTimer: ReturnType<typeof setTimeout> | undefined
  const statusBarTick = async (): Promise<void> => {
    try {
      const minutes = await statusBarMinutes(orca)
      // One loop only: a tick asked for by a Settings change replaces the pending one.
      if (statusBarTimer !== undefined) clearTimeout(statusBarTimer)
      statusBarTimer = setTimeout(() => void statusBarTick(), minutes * 60_000)
      ;(statusBarTimer as { unref?: () => void }).unref?.()
      await refreshOnce()
    } catch (error) {
      orca.log(`statusBar: ${errorParts(error).errorDetail}`)
    }
  }
  void statusBarTick()

  // Turning the item off or changing the interval takes hold now, not at the next interval.
  orca.settings.onDidChange(({ key }) => {
    if (key === STATUS_BAR_SETTING || key === STATUS_BAR_MINUTES_SETTING) void statusBarTick()
  })

  // Team branch convention: never refuses a creation, and passes when anything is missing or slow.
  orca.hooks.on('workspace.create.before', async (event, next) => {
    if (event.kind !== 'worktree') return
    const template = await stringSetting(orca, BRANCH_TEMPLATE_SETTING)
    const id = template ? taskRefFromWorkspace(event.name, event.branch) : null
    if (!template || !id) return
    try {
      const issue = await within(HOOK_BUDGET_MS, client(orca).then((r) => r.getIssue(id)))
      const branch = branchFromTemplate(template, issue)
      if (!branch || branch === event.branch) return
      orca.log(`workspace.create.before #${id}: branch ${branch}`)
      return next({ ...event, branch })
    } catch (error) {
      orca.log(`workspace.create.before #${id}: ${errorParts(error).errorDetail}`)
    }
  })

  // Any agent started in a linked workspace gets the task number in its environment, whoever started
  // it (Orca's new tab, automations, orchestration, the CLI). Local decisions only, no network.
  const launched = new LaunchedTasks()
  orca.hooks.on('agent.launch.before', async (event, next) => {
    const issue = await linkedTask(orca, event.workspaceId)
    if (!issue) return
    if (event.terminalId) launched.remember(event.terminalId, issue)
    return next({ ...event, env: withIssueEnv(event.env, issue.id) })
  })

  // Optional: name the task in the prompt Orca submits right after launching the agent there.
  orca.hooks.on('agent.prompt.before', async (event, next) => {
    if (event.inputKind !== 'launch') return
    if ((await orca.settings.get(PROMPT_POINTER_SETTING)) !== true) return
    const issue = launched.taskFor(event.terminalId)
    if (!issue) return
    const prompt = withPromptPointer(event.prompt, issue, await savedUrl(orca))
    if (!prompt) return
    return next({ ...event, prompt })
  })

  // Any new worktree that names a task the user can see gets linked to it, whoever created it.
  orca.events.on('workspace.created', async (event) => {
    const { workspaceId, kind, path, branch } = event
    if (kind !== 'worktree') return
    const listId = listedId(event)
    const { key, name, orcaProjectId } = await describeCreated(orca, listId ?? workspaceId, path)
    if (!key) {
      orca.log(`workspace.created: no link key for ${workspaceId}`)
      return
    }
    const id = taskRefFromWorkspace(name, branch)
    if (!id) return
    const linked = (await readMap<AssignedIssue>(orca, ISSUE_BY_WORKSPACE))[key]
    if (linked && linked.id !== id) return
    try {
      const redmine = await client(orca)
      const issue = await redmine.getIssue(id)
      if (!(await inMappedProject(orca, redmine, orcaProjectId, issue))) return
      if (!linked) {
        // Read again right before writing: the panel may have linked meanwhile.
        const links = await readMap<AssignedIssue>(orca, ISSUE_BY_WORKSPACE)
        if (!links[key]) await orca.storage.set(ISSUE_BY_WORKSPACE, { ...links, [key]: { id: issue.id, subject: issue.subject } })
        orca.log(`workspace.created: linked ${key} to #${issue.id}`)
      }
      // Keep the ids Orca's later events (and the removal, when the worktree is gone) may name it by.
      await rememberWorkspaceIds(orca, key, [workspaceId, listId, path])
      if (started.has(key)) return
      started.add(key)
      await recordWorkStarted(orca, redmine, issue, name, shortBranch(branch))
    } catch (error) {
      orca.log(`workspace.created #${id}: ${errorParts(error).errorDetail}`)
    }
  })

  // The main agent of a linked workspace finished or needs input: a follow-up (and maybe a
  // notification). Nothing is written to Redmine here: only the person's actions in the panel are.
  orca.events.on('agent.status.changed', async (event) => {
    const change = agentRuns.observe(event)
    const workspaceId = listedId(event) ?? event.workspaceId
    if (!change || !workspaceId) return
    try {
      const key = await eventWorkspaceKey(orca, workspaceId)
      if (!key) return
      const linked = (await readMap<AssignedIssue>(orca, ISSUE_BY_WORKSPACE))[key]
      if (!linked) return
      const info = await workspaceInfoFor(orca, workspaceId, key)
      await rememberWorkspaceIds(orca, key, [event.workspaceId, workspaceId, info.path])
      const mode = asAgentNotification(await orca.settings.get(AGENT_NOTIFICATION_SETTING))
      if (change.transition === 'blocked') {
        if (shouldNotify(mode, 'blocked')) await notifyAgent(orca, 'blocked', linked)
        return
      }
      // A cancellation, supersede or interruption means the person stopped it and is looking.
      if (!recordsFollowup(change.outcome)) return
      // What resuming the session needs: the workspace's host id, the session, and the kind (which
      // the event does not carry, so Orca's agent list is asked). Missing parts just mean no Resume.
      const listId = listedId(event)
      const sessionId = sessionIdOf(event)
      const agent = listId ? await agentKindFor(orca, listId, terminalIdOf(event), sessionId) : null
      await recordFollowup(orca, {
        kind: 'agentDone',
        issueId: linked.id,
        workspaceName: info.name,
        at: event.receivedAt,
        ...(change.hours === undefined ? {} : { hours: change.hours }),
        ...(listId ? { workspaceId: listId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(agent ? { agent } : {})
      })
      if (shouldNotify(mode, 'done')) await notifyAgent(orca, 'done', linked)
    } catch (error) {
      orca.log(`agent.status.changed: ${errorParts(error).errorDetail}`)
    }
  })

  // A linked worktree went away: its link would otherwise stay forever and the task never gets closed.
  orca.events.on('workspace.removed', async (event) => {
    const { workspaceId, kind, path } = event
    if (kind !== 'worktree') return
    try {
      const listId = listedId(event)
      // The listed id carries the link key itself (host API 1.7); older Orca needs the alias map.
      const key = (listId ? keyFromHostId(listId) : null) ?? (await eventWorkspaceKey(orca, workspaceId, path))
      await forgetWorkspaceIds(orca, key, [workspaceId, listId, path])
      if (!key) return
      const links = await readMap<AssignedIssue>(orca, ISSUE_BY_WORKSPACE)
      const linked = links[key]
      if (!linked) return
      const next = { ...links }
      delete next[key]
      await orca.storage.set(ISSUE_BY_WORKSPACE, next)
      await recordFollowup(orca, {
        kind: 'workspaceRemoved',
        issueId: linked.id,
        workspaceName: lastPathSegment(path ?? key),
        at: Date.now()
      })
    } catch (error) {
      orca.log(`workspace.removed: ${errorParts(error).errorDetail}`)
    }
  })

  orca.panels.handle('redmine.followups.get', async () => ({ followups: await storedFollowups(orca) }))

  orca.panels.handle('redmine.followups.dismiss', async ({ id }) => {
    const followups = dismissFollowup(await storedFollowups(orca), id)
    await saveFollowups(orca, followups)
    return { followups }
  })

  orca.panels.handle('redmine.status', () => status(orca))

  orca.panels.handle('redmine.configure', async ({ url, apiKey }) => {
    const base = normalizeBaseUrl(url)
    // Validate before saving, so a wrong key is never stored.
    await new RedmineClient(base, apiKey.trim()).currentUser()
    await orca.settings.set(URL_SETTING, base)
    await orca.secrets.set(API_KEY, apiKey.trim())
    refreshSoon()
    return status(orca)
  })

  orca.panels.handle('redmine.disconnect', async () => {
    await orca.secrets.delete(API_KEY)
    refreshSoon()
    return status(orca)
  })

  orca.panels.handle('redmine.issues', async ({ mine, search, projectId, status }) => {
    const limit = await orca.settings.get(LIMIT_SETTING)
    return (await client(orca)).listIssues({
      mine,
      search,
      projectId: projectId || undefined,
      status,
      limit: typeof limit === 'number' ? limit : 50
    })
  })

  orca.panels.handle('redmine.projects', async () => (await client(orca)).listProjects())

  orca.panels.handle('redmine.locateWorkspace', async (context) => {
    const found = await hostWorkspaceMatch(orca, context)
    if (found) {
      // Remembered for a later `workspace.removed`, even for a workspace the panel linked by hand.
      rememberLocatedIds(orca, found.key, [found.id, found.path])
      const key = found.key
      // Host API 1.7 names the project too: no CLI at all, after moving old mappings to its ids.
      if (found.project) {
        await migrateProjectMappings(orca)
        return { located: { workspaceKey: key, ...found.project } }
      }
      // The workspace is known; only its Orca project needs the CLI, and failing that is not fatal.
      try {
        const project = await projectWithCli(key)
        if (project) return { located: { workspaceKey: key, ...project } }
        return { located: { workspaceKey: key, orcaProjectId: null, orcaProjectName: null }, errorCode: 'workspace_not_listed', errorDetail: context.displayName }
      } catch (error) {
        const parts = errorParts(error)
        orca.log(`locateWorkspace (project): ${parts.errorDetail}`)
        return { located: { workspaceKey: key, orcaProjectId: null, orcaProjectName: null }, ...parts }
      }
    }
    try {
      const located = await locateWithCli(context)
      if (!located) return { located: null, errorCode: 'workspace_not_listed', errorDetail: context.displayName }
      rememberLocatedIds(orca, located.located.workspaceKey, [located.id, located.path])
      return { located: located.located }
    } catch (error) {
      const parts = errorParts(error)
      orca.log(`locateWorkspace: ${parts.errorDetail}`)
      return { located: null, ...parts }
    }
  })

  orca.panels.handle('redmine.issue', async ({ id }) => (await client(orca)).getIssue(id))

  orca.panels.handle('redmine.statuses', async () => (await client(orca)).statuses())

  orca.panels.handle('redmine.setStatus', async ({ id, statusId }) => {
    const redmine = await client(orca)
    await redmine.updateIssue(id, { statusId })
    orca.panels.post('redmine.issueChanged', { id })
    refreshSoon()
    return redmine.getIssue(id)
  })

  orca.panels.handle('redmine.comment', async ({ id, notes }) => {
    const redmine = await client(orca)
    await redmine.updateIssue(id, { notes })
    orca.panels.post('redmine.issueChanged', { id })
    refreshSoon()
    return redmine.getIssue(id)
  })

  orca.panels.handle('redmine.logTime', async ({ id, hours, comments, spentOn }) => {
    if (!(hours > 0 && hours <= 24)) throw new RedmineError('invalid_hours', `hours=${hours}`)
    if (spentOn !== undefined && !isBookableDay(spentOn)) throw new RedmineError('invalid_day', `spentOn=${spentOn}`)
    const timeEntryId = await (await client(orca)).logTime(id, hours, comments, spentOn)
    orca.panels.post('redmine.issueChanged', { id })
    refreshSoon()
    return { timeEntryId }
  })

  // A count younger than a minute is reused: the list asks on every reload.
  orca.panels.handle('redmine.counts', async () => {
    if (lastCounts && Date.now() - lastCounts.at < COUNTS_MAX_AGE_MS) return lastCounts.counts
    const counts = await (await client(orca)).openCounts()
    rememberCounts(counts)
    return counts
  })

  orca.panels.handle('redmine.timeEntries', async ({ id }) => (await client(orca)).myTimeEntries(id))

  orca.panels.handle('redmine.cli', async () => ({ version: await redmineCli() }))

  // Git projects a workspace can be created in: the host's projects (same ids as `workspace.create`
  // takes). No CLI: `project.list` is host API 1.7, which every Orca this plugin runs on has.
  orca.panels.handle('redmine.orcaProjects', async () => {
    const { projects } = (await orca.host.call('project.list', {})) as { projects: HostProjectRow[] }
    return projects
      .filter((p) => p.kind === 'git' && !p.hidden)
      .map((p) => ({ id: p.id, name: p.name || p.id }))
      .sort((a, b) => a.name.localeCompare(b.name))
  })

  // Which linked tasks have an agent working, waiting for permission, or done and unseen. Empty when
  // this Orca does not report agent status (`includeStatus` is host API 1.7; older hosts refuse it).
  orca.panels.handle('redmine.agentStates', async () => {
    if (!orca.host.has('workspace.list')) return {}
    try {
      const { workspaces } = (await orca.host.call('workspace.list', { includeStatus: true })) as { workspaces: HostWorkspaceRow[] }
      return agentStatesFor(workspaces, await readMap<AssignedIssue>(orca, ISSUE_BY_WORKSPACE))
    } catch (error) {
      orca.log(`agentStates: ${errorParts(error).errorDetail}`)
      return {}
    }
  })

  orca.panels.handle('redmine.launchWorkspace', async (input) => {
    if (!orca.host.has('workspace.create')) throw new RedmineError('workspace_create_unavailable', 'workspace.create')
    const issue = await (await client(orca)).getIssue(input.issueId)
    const name = workspaceNameFor(issue)
    // Same text and cap as "Launch agent here": `workspace.create` hands the prompt to the agent,
    // which refuses more than 4,096 characters, so a long one moves the context to a file.
    const options = await contextOptions(orca)
    const comments = input.comments ?? options.comments
    const redmineCliInstalled = Boolean(await redmineCli())
    const full = buildLaunchPrompt(issue, input.instructions, input.locale, { ...options, comments, redmineCli: redmineCliInstalled })
    let prompt = full
    if (input.agent && !fitsLaunchPrompt(full)) {
      const contextFile = await writeContextFile(issue.id, buildContextBlock(issue, { ...options, comments }), contextDir)
      prompt = contextFilePrompt(issue, input.instructions, input.locale, { contextFile, redmineCli: redmineCliInstalled })
      orca.log(`launchWorkspace #${issue.id}: prompt too long, context in ${contextFile}`)
    }
    const params: { projectId: string; name: string; baseBranch?: string; agent?: string; prompt?: string; open?: boolean } = {
      projectId: input.orcaProjectId,
      name,
      open: input.activate
    }
    if (input.baseBranch?.trim()) params.baseBranch = input.baseBranch.trim()
    if (input.agent) {
      params.agent = input.agent
      params.prompt = prompt
    }
    let workspaceId: string
    try {
      workspaceId = ((await orca.host.call('workspace.create', params)) as { workspaceId: string }).workspaceId
    } catch (error) {
      const parts = errorParts(error)
      // The workspace exists and the agent failed to start: link it anyway and report the agent error.
      const createdKey = keyFromHostId(workspaceIdInError(error) ?? '')
      if (createdKey) {
        try {
          await linkWorkspace(orca, createdKey, issue)
        } catch (linkError) {
          orca.log(`launchWorkspace #${issue.id} (link): ${errorParts(linkError).errorDetail}`)
        }
        orca.log(`launchWorkspace #${issue.id} -> ${createdKey}, agent failed: ${parts.errorDetail}`)
        throw new RedmineError(parts.errorCode === 'unknown' ? 'action_failed' : parts.errorCode, parts.errorDetail)
      }
      orca.log(`launchWorkspace #${issue.id}: ${parts.errorDetail}`)
      throw new RedmineError('workspace_create', parts.errorDetail)
    }
    // Linked before answering, so the panel and `workspace.created` agree (that handler skips a
    // workspace already linked to the task).
    const workspaceKey = keyFromHostId(workspaceId)
    if (workspaceKey) await linkWorkspace(orca, workspaceKey, issue)
    orca.log(`launchWorkspace #${issue.id} -> ${workspaceKey ?? workspaceId}`)
    return { workspaceKey, name }
  })

  orca.panels.handle('redmine.sendToAgent', async ({ id, terminalId, locale }) => {
    const issue = await (await client(orca)).getIssue(id)
    // The terminal gets one line; the description and comments go in a file the line points to.
    const contextFile = await writeContextFile(issue.id, buildContextBlock(issue, await contextOptions(orca)), contextDir)
    const text = sendPrompt(issue, locale, await stringSetting(orca, SEND_PROMPT_SETTING), {
      contextFile,
      redmineCli: Boolean(await redmineCli())
    })
    // No Enter: the person reviews the text in the terminal before submitting it.
    return orca.host.call('terminal.sendText', { terminalId, text, enter: false })
  })

  orca.panels.handle('redmine.launchHereSupport', async () => ({ available: orca.host.has('agent.launch') }))

  orca.panels.handle('redmine.launchHere', async (input) => {
    if (!orca.host.has('agent.launch')) throw new RedmineError('agent_launch_unavailable', 'agent.launch')
    const context = await orca.host.call('workspace.readContext', {})
    if (!context) throw new RedmineError('no_workspace', 'no focused workspace')
    const workspaceId = await hostWorkspaceId(orca, context)
    if (!workspaceId) throw new RedmineError('workspace_not_listed', context.displayName)
    const issue = await (await client(orca)).getIssue(input.issueId)
    // Same text as a new-workspace launch; `agent.launch` caps it, so a long one moves the context to a file.
    const options = await contextOptions(orca)
    const comments = input.comments ?? options.comments
    const redmineCliHere = Boolean(await redmineCli())
    const full = buildLaunchPrompt(issue, input.instructions, input.locale, { ...options, comments, redmineCli: redmineCliHere })
    let prompt = full
    if (!fitsLaunchPrompt(full)) {
      const contextFile = await writeContextFile(issue.id, buildContextBlock(issue, { ...options, comments }), contextDir)
      prompt = contextFilePrompt(issue, input.instructions, input.locale, { contextFile, redmineCli: redmineCliHere })
      orca.log(`launchHere #${issue.id}: prompt too long, context in ${contextFile}`)
    }
    const launched = await orca.host.call('agent.launch', { workspaceId, agent: input.agent, prompt })
    orca.log(`launchHere #${issue.id} -> ${workspaceId} (${input.agent})`)
    return { terminalId: launched.terminalId, workspaceKey: keyFromHostId(workspaceId) }
  })

  orca.panels.handle('redmine.renameWorkspaceSupport', async () => ({ available: hasRename(orca) }))

  // The person's explicit action only: the name comes from the task, and nothing is renamed on its own.
  orca.panels.handle('redmine.renameWorkspace', async ({ workspaceKey, issue }) => {
    if (!hasRename(orca)) throw new RedmineError('workspace_rename_unavailable', 'workspace.rename')
    const template = await stringSetting(orca, WORKSPACE_NAME_SETTING)
    const name = workspaceNameFromTask(template ?? '', issue)
    // The link key is what `workspace.rename` calls `identity:<key>`.
    const renamed = await orca.host.call('workspace.rename', { workspaceId: `identity:${workspaceKey}`, name })
    orca.log(`renameWorkspace ${workspaceKey}: ${renamed.name}`)
    return { name: renamed.name }
  })

  // The agents of a task's linked workspaces: one `agents.list` per workspace, in parallel, newest
  // links first. A workspace Orca no longer knows is left out (and logged), never an error here.
  /** Terminals the last `redmine.taskAgents` answer named, plus any a resume reported. */
  let listedAgentTerminals = new Set<string>()

  orca.panels.handle('redmine.taskAgents', async ({ issueId }) => {
    const links = await readMap<AssignedIssue>(orca, ISSUE_BY_WORKSPACE)
    const keys = Object.keys(links)
      .filter((key) => links[key]?.id === issueId)
      .reverse()
      .slice(0, MAX_TASK_WORKSPACES)
    const names = keys.length > 0 ? await hostWorkspaceNames(orca) : new Map<string, string>()
    const found = await Promise.all(
      keys.map(async (key): Promise<TaskWorkspaceAgents | null> => {
        const workspaceId = `identity:${key}`
        const agents = await listedAgents(orca, workspaceId)
        if (!agents) return null
        return { key, name: names.get(workspaceId) ?? key, agents: agents.map(taskAgentOf) }
      })
    )
    const workspaces = found.filter((w): w is TaskWorkspaceAgents => w !== null)
    listedAgentTerminals = new Set(
      workspaces
        .flatMap((w) => w.agents.map((a) => a.terminalId))
        .filter((id): id is string => Boolean(id))
    )
    return { workspaces }
  })

  orca.panels.handle('redmine.agentActionsSupport', async () => ({
    show: orca.host.has('terminal.focus') && orca.grantedCapabilities.includes('workspace:write'),
    resume: orca.host.has('agent.resume')
  }))

  orca.panels.handle('redmine.showAgent', async ({ terminalId }) => {
    // Only a terminal the last `taskAgents` answer listed, or one a resume reported: the panel
    // cannot focus an arbitrary terminal.
    if (!listedAgentTerminals.has(terminalId)) throw new RedmineError('invalid_params', `terminal not listed: ${terminalId}`)
    if (!orca.host.has('terminal.focus')) throw new RedmineError('unknown_method', 'terminal.focus')
    const { focused } = (await orca.host.call('terminal.focus', { terminalId })) as { focused: boolean }
    return { focused }
  })

  orca.panels.handle('redmine.resumeAgent', async ({ followupId }) => {
    const followup = (await storedFollowups(orca)).find((f) => f.id === followupId)
    if (!followup?.workspaceId || !followup.agent || !followup.sessionId) {
      throw new RedmineError('agent_resume', 'the follow-up has no workspace, agent and session')
    }
    if (!orca.host.has('agent.resume')) throw new RedmineError('agent_resume', 'agent.resume')
    try {
      const resumed = (await orca.host.call('agent.resume', {
        workspaceId: followup.workspaceId,
        agent: followup.agent,
        sessionId: followup.sessionId
      })) as { terminalId: string; started: boolean }
      // "Already running" names the terminal that has it: the panel may show that one.
      listedAgentTerminals.add(resumed.terminalId)
      return resumed
    } catch (error) {
      throw new RedmineError('agent_resume', errorParts(error).errorDetail)
    }
  })

  orca.panels.handle('redmine.openWorkspaceSupport', async () => ({ available: canOpenWorkspace(orca) }))

  // "Go to workspace": shows the workspace linked to the task, as clicking it in Orca's sidebar does.
  orca.panels.handle('redmine.openWorkspace', async ({ issueId }) => {
    if (!canOpenWorkspace(orca)) throw new RedmineError('unknown_method', 'workspace.open')
    const key = await linkedKeyForTask(orca, issueId)
    if (!key) throw new RedmineError('workspace_not_listed', `no workspace linked to #${issueId}`)
    const answer = (await orca.host.call('workspace.open', { workspaceId: `identity:${key}` })) as { opened: boolean }
    orca.log(`openWorkspace #${issueId} -> ${key}`)
    return { opened: answer.opened }
  })

  // Command palette. No panel asked, so it answers in the machine's language.
  orca.commands.register('redmine.myIssues', async () => myIssuesText(orca, systemLocale()))

  // Pressing the status bar item. `orca plugin open` needs the plugin's key, which the worker is not
  // told (a dev folder loads as local.redmine-tasks), so it is read once from the CLI and cached.
  let panelKey: string | null = null
  orca.commands.register('redmine.openPanel', async () => {
    const locale = systemLocale()
    try {
      panelKey ??= pickPluginKey(((await orcaRunner(['plugin', 'list'])) as { plugins?: ListedPlugin[] })?.plugins ?? [], STATUS_BAR_ID)
      if (!panelKey) throw new RedmineError('orca_cli', 'no redmine-tasks plugin in `orca plugin list`')
      await orcaRunner(['plugin', 'open', panelKey, '--panel', PANEL_ID])
      return translate(locale, 'command.panelOpened')
    } catch (error) {
      // No CLI, or the panel cannot be opened: the press still shows the task list.
      orca.log(`openPanel: ${errorParts(error).errorDetail}`)
      return myIssuesText(orca, locale)
    }
  })
}
