// The plugin's worker (Node). The only part with network access: it talks to the Redmine REST API
// and runs the `orca` CLI. The URL lives in the plugin settings; the API key in its encrypted
// secrets (OS keychain). Errors are thrown as RedmineError codes for the panel to translate.
import type { OrcaWorkerApi } from 'orca/worker'
import { systemLocale, translate } from './i18n'
import { LaunchedTasks, pathFromCliId, withIssueEnv, withPromptPointer } from './agent-env'
import { detectRedmineCli, writeContextFile } from './agent-files'
import { asCommentsMode, buildContextBlock, buildLaunchPrompt, CONTEXT_MAX_CHARS, sendPrompt, workspaceNameFor } from './launch'
import {
  clearOrcaCache,
  createWorktree,
  describeWorktree,
  listOrca,
  keyFromHostId,
  matchHostWorkspace,
  matchWorktreeWithRow,
  projectForKey,
  shortBranch,
  type CreatedWorktree,
  type CreateWorktreeOptions,
  type FocusedContext,
  type HostWorkspaceRow,
  type OrcaListing
} from './orca-workspaces'
import type { ConnectionStatus } from './protocol'
import { normalizeBaseUrl, projectSubtree, RedmineClient, RedmineError, type IssueDetail } from './redmine'
import { branchFromTemplate, taskRefFromWorkspace } from './task-ref'
import { ISSUE_BY_WORKSPACE, PROJECT_BY_ORCA_PROJECT, WORKSPACE_IDS_BY_KEY, type AssignedIssue } from './links'
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
  type Followup
} from './followups'

let orcaLister: () => Promise<OrcaListing> = listOrca
let orcaCreator: (o: CreateWorktreeOptions) => Promise<CreatedWorktree> = createWorktree

/** Tests: replaces the Orca CLI listing. */
export function setOrcaLister(lister: () => Promise<OrcaListing>): void {
  orcaLister = lister
}

/** Tests: replaces `orca worktree create`. */
export function setOrcaCreator(creator: (o: CreateWorktreeOptions) => Promise<CreatedWorktree>): void {
  orcaCreator = creator
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

const URL_SETTING = 'url'
const LIMIT_SETTING = 'limit'
const API_KEY = 'apiKey'
const SEND_PROMPT_SETTING = 'sendPrompt'
const COMMENTS_SETTING = 'contextComments'
const MAX_CHARS_SETTING = 'contextMaxChars'
const BRANCH_TEMPLATE_SETTING = 'branchTemplate'
const ON_CREATED_SETTING = 'onWorkspaceCreated'
const PROMPT_POINTER_SETTING = 'promptPointer'
const AGENT_NOTIFICATION_SETTING = 'agentNotification'
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
}

/**
 * The focused workspace's link key from the host's `workspace.list`, without the CLI. Null when the
 * host cannot say (older Orca, a refusal, or a truncated listing without it): the CLI decides then.
 */
async function hostWorkspaceMatch(orca: OrcaWorkerApi, context: FocusedContext): Promise<LocatedWorkspaceMatch | null> {
  if (!orca.host.has('workspace.list')) return null
  try {
    const { workspaces } = (await orca.host.call('workspace.list', {})) as { workspaces: HostWorkspaceRow[]; truncated: boolean }
    const key = matchHostWorkspace(workspaces, context)
    if (!key) return null
    const row = workspaces.find((w) => keyFromHostId(w.id) === key)
    return { key, id: row?.id ?? `identity:${key}`, path: row?.path ?? null }
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
  if (orca.host.has('workspace.list')) {
    try {
      const { workspaces } = (await orca.host.call('workspace.list', {})) as { workspaces: HostWorkspaceRow[] }
      const row = workspaces.find((w) => w.id === workspaceId) ?? workspaces.find((w) => w.path === path)
      if (row) {
        key ??= keyFromHostId(row.id)
        name = row.name
      }
    } catch (error) {
      orca.log(`workspace.list: ${errorParts(error).errorDetail}`)
    }
  }
  let orcaProjectId: string | null = null
  try {
    clearOrcaCache()
    const found = describeWorktree(await orcaLister(), { id: workspaceId, key })
    if (found) {
      key ??= found.workspaceKey
      name ??= found.name
      orcaProjectId = found.orcaProjectId
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

async function recordFollowup(
  orca: OrcaWorkerApi,
  input: { kind: Followup['kind']; issueId: number; workspaceName: string; at: number; hours?: number }
): Promise<void> {
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

/** A desktop notification naming the task, in the machine's language. Never description text. */
async function notifyAgent(orca: OrcaWorkerApi, transition: AgentTransition['transition'], issue: AssignedIssue): Promise<void> {
  const key = transition === 'done' ? 'notification.agentDone' : 'notification.agentBlocked'
  try {
    await orca.host.call('notifications.show', { title: translate(systemLocale(), key, { id: issue.id, subject: issue.subject }) })
  } catch (error) {
    orca.log(`notifications.show: ${errorParts(error).errorDetail}`)
  }
}

export default function activate(orca: OrcaWorkerApi): void {
  /** Workspaces whose work start was already recorded in this run (the event may repeat). */
  const started = new Set<string>()
  /** First `working` time per pane, for the working time pre-filled when the agent finishes. */
  const agentRuns = new AgentRunTracker()

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
  orca.events.on('workspace.created', async ({ workspaceId, kind, path, branch }) => {
    if (kind !== 'worktree') return
    const { key, name, orcaProjectId } = await describeCreated(orca, workspaceId, path)
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
      await rememberWorkspaceIds(orca, key, [workspaceId, path])
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
    if (!change || !event.workspaceId) return
    try {
      const key = await eventWorkspaceKey(orca, event.workspaceId)
      if (!key) return
      const linked = (await readMap<AssignedIssue>(orca, ISSUE_BY_WORKSPACE))[key]
      if (!linked) return
      const info = await workspaceInfoFor(orca, event.workspaceId, key)
      await rememberWorkspaceIds(orca, key, [event.workspaceId, info.path])
      const mode = asAgentNotification(await orca.settings.get(AGENT_NOTIFICATION_SETTING))
      if (change.transition === 'blocked') {
        if (shouldNotify(mode, 'blocked')) await notifyAgent(orca, 'blocked', linked)
        return
      }
      // A cancellation, supersede or interruption means the person stopped it and is looking.
      if (!recordsFollowup(change.outcome)) return
      await recordFollowup(orca, {
        kind: 'agentDone',
        issueId: linked.id,
        workspaceName: info.name,
        at: event.receivedAt,
        ...(change.hours === undefined ? {} : { hours: change.hours })
      })
      if (shouldNotify(mode, 'done')) await notifyAgent(orca, 'done', linked)
    } catch (error) {
      orca.log(`agent.status.changed: ${errorParts(error).errorDetail}`)
    }
  })

  // A linked worktree went away: its link would otherwise stay forever and the task never gets closed.
  orca.events.on('workspace.removed', async ({ workspaceId, kind, path }) => {
    if (kind !== 'worktree') return
    try {
      const key = await eventWorkspaceKey(orca, workspaceId, path)
      await forgetWorkspaceIds(orca, key, [workspaceId, path])
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
    return status(orca)
  })

  orca.panels.handle('redmine.disconnect', async () => {
    await orca.secrets.delete(API_KEY)
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
    return redmine.getIssue(id)
  })

  orca.panels.handle('redmine.comment', async ({ id, notes }) => {
    const redmine = await client(orca)
    await redmine.updateIssue(id, { notes })
    orca.panels.post('redmine.issueChanged', { id })
    return redmine.getIssue(id)
  })

  orca.panels.handle('redmine.logTime', async ({ id, hours, comments }) => {
    if (!(hours > 0 && hours <= 24)) throw new RedmineError('invalid_hours', `hours=${hours}`)
    const timeEntryId = await (await client(orca)).logTime(id, hours, comments)
    orca.panels.post('redmine.issueChanged', { id })
    return { timeEntryId }
  })

  orca.panels.handle('redmine.timeEntries', async ({ id }) => (await client(orca)).myTimeEntries(id))

  orca.panels.handle('redmine.cli', async () => ({ version: await redmineCli() }))

  orca.panels.handle('redmine.orcaProjects', async () =>
    (await orcaLister()).projects
      .map((p) => ({ id: p.id, name: p.displayName ?? p.id }))
      .sort((a, b) => a.name.localeCompare(b.name))
  )

  orca.panels.handle('redmine.launchWorkspace', async (input) => {
    const issue = await (await client(orca)).getIssue(input.issueId)
    const name = workspaceNameFor(issue)
    const options = await contextOptions(orca)
    const created = await orcaCreator({
      orcaProjectId: input.orcaProjectId,
      name,
      agent: input.agent,
      prompt: buildLaunchPrompt(issue, input.instructions, input.locale, {
        ...options,
        comments: input.comments ?? options.comments,
        redmineCli: Boolean(await redmineCli())
      }),
      baseBranch: input.baseBranch,
      comment: `Redmine #${issue.id}: ${issue.subject}`,
      activate: input.activate
    })
    orca.log(`launchWorkspace #${issue.id} -> ${created.workspaceKey ?? '?'} (${created.branch ?? '?'})`)
    return { ...created, name }
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

  // Command palette. No panel asked, so it answers in the machine's language.
  orca.commands.register('redmine.myIssues', async () => {
    const locale = systemLocale()
    if (!(await savedUrl(orca)) || !(await orca.secrets.get(API_KEY))) return translate(locale, 'command.notConfigured')
    const { issues, total } = await (await client(orca)).listIssues({ mine: true, limit: 20 })
    if (issues.length === 0) return translate(locale, 'command.noIssues')
    const lines = issues.map((i) => `#${i.id} [${i.status}] ${i.subject} (${i.project})`)
    return [translate(locale, 'command.header', { total }), ...lines].join('\n')
  })
}
