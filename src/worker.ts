// The plugin's worker (Node). The only part with network access: it talks to the Redmine REST API
// and runs the `orca` CLI. The URL lives in the plugin settings; the API key in its encrypted
// secrets (OS keychain). Errors are thrown as RedmineError codes for the panel to translate.
import type { OrcaWorkerApi } from 'orca/worker'
import { systemLocale, translate, translateErrorCode } from './i18n'
import { detectRedmineCli, writeContextFile } from './agent-files'
import { asCommentsMode, buildContextBlock, buildLaunchPrompt, CONTEXT_MAX_CHARS, sendPrompt, workspaceNameFor } from './launch'
import {
  clearOrcaCache,
  createWorktree,
  describeWorktree,
  listOrca,
  keyFromHostId,
  matchHostWorkspace,
  matchWorktree,
  projectForKey,
  runOrcaJson,
  shortBranch,
  type CreatedWorktree,
  type CreateWorktreeOptions,
  type FocusedContext,
  type HostWorkspaceRow,
  type LocatedWorkspace,
  type OrcaListing
} from './orca-workspaces'
import type { ConnectionStatus } from './protocol'
import { normalizeBaseUrl, projectSubtree, RedmineClient, RedmineError, type IssueDetail, type OpenCounts } from './redmine'
import { branchFromTemplate, taskRefFromWorkspace } from './task-ref'
import { ISSUE_BY_WORKSPACE, PROJECT_BY_ORCA_PROJECT, type AssignedIssue } from './links'
import { pickPluginKey, type ListedPlugin } from './plugin-key'

let orcaLister: () => Promise<OrcaListing> = listOrca
let orcaCreator: (o: CreateWorktreeOptions) => Promise<CreatedWorktree> = createWorktree
let orcaRunner: (args: string[]) => Promise<unknown> = (args) => runOrcaJson(args)

/** Tests: replaces the Orca CLI listing. */
export function setOrcaLister(lister: () => Promise<OrcaListing>): void {
  orcaLister = lister
}

/** Tests: replaces `orca worktree create`. */
export function setOrcaCreator(creator: (o: CreateWorktreeOptions) => Promise<CreatedWorktree>): void {
  orcaCreator = creator
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

const URL_SETTING = 'url'
const LIMIT_SETTING = 'limit'
const API_KEY = 'apiKey'
const SEND_PROMPT_SETTING = 'sendPrompt'
const COMMENTS_SETTING = 'contextComments'
const MAX_CHARS_SETTING = 'contextMaxChars'
const BRANCH_TEMPLATE_SETTING = 'branchTemplate'
const ON_CREATED_SETTING = 'onWorkspaceCreated'
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
async function refreshStatusBar(orca: OrcaWorkerApi): Promise<void> {
  const locale = systemLocale()
  let update: { text?: string; tone?: 'neutral' | 'warning' | 'danger'; tooltip?: string; visible: boolean }
  try {
    const enabled = await orca.settings.get(STATUS_BAR_SETTING)
    if (enabled === false || !(await savedUrl(orca)) || !(await orca.secrets.get(API_KEY))) {
      update = { visible: false }
    } else {
      const counts = await (await client(orca)).openCounts()
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
async function hostWorkspaceKey(orca: OrcaWorkerApi, context: FocusedContext): Promise<string | null> {
  if (!orca.host.has('workspace.list')) return null
  try {
    const { workspaces } = (await orca.host.call('workspace.list', {})) as { workspaces: HostWorkspaceRow[]; truncated: boolean }
    return matchHostWorkspace(workspaces, context)
  } catch (error) {
    orca.log(`workspace.list: ${errorParts(error).errorDetail}`)
    return null
  }
}

/** The CLI-only lookup: key and Orca project from `orca worktree list`, asking again on a miss. */
async function locateWithCli(context: FocusedContext): Promise<LocatedWorkspace | null> {
  const located = matchWorktree(await orcaLister(), context)
  if (located) return located
  // It may be a brand-new workspace: ask again without the cache.
  clearOrcaCache()
  return matchWorktree(await orcaLister(), context)
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

export default function activate(orca: OrcaWorkerApi): void {
  /** Workspaces whose work start was already recorded in this run (the event may repeat). */
  const started = new Set<string>()

  // Status bar: one refresh at a time, whether a panel change or the interval asked for it, so a
  // slow Redmine is not asked twice for the same count.
  let refreshing: Promise<void> | null = null
  const refreshOnce = (): Promise<void> => {
    refreshing ??= refreshStatusBar(orca).finally(() => {
      refreshing = null
    })
    return refreshing
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
      if (started.has(key)) return
      started.add(key)
      await recordWorkStarted(orca, redmine, issue, name, shortBranch(branch))
    } catch (error) {
      orca.log(`workspace.created #${id}: ${errorParts(error).errorDetail}`)
    }
  })

  orca.panels.handle('redmine.status', () => status(orca))

  orca.panels.handle('redmine.configure', async ({ url, apiKey }) => {
    const base = normalizeBaseUrl(url)
    // Validate before saving, so a wrong key is never stored.
    await new RedmineClient(base, apiKey.trim()).currentUser()
    await orca.settings.set(URL_SETTING, base)
    await orca.secrets.set(API_KEY, apiKey.trim())
    await refreshOnce()
    return status(orca)
  })

  orca.panels.handle('redmine.disconnect', async () => {
    await orca.secrets.delete(API_KEY)
    await refreshOnce()
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
    const key = await hostWorkspaceKey(orca, context)
    if (key) {
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
      return located ? { located } : { located: null, errorCode: 'workspace_not_listed', errorDetail: context.displayName }
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
    await refreshOnce()
    return redmine.getIssue(id)
  })

  orca.panels.handle('redmine.comment', async ({ id, notes }) => {
    const redmine = await client(orca)
    await redmine.updateIssue(id, { notes })
    orca.panels.post('redmine.issueChanged', { id })
    await refreshOnce()
    return redmine.getIssue(id)
  })

  orca.panels.handle('redmine.logTime', async ({ id, hours, comments }) => {
    if (!(hours > 0 && hours <= 24)) throw new RedmineError('invalid_hours', `hours=${hours}`)
    const timeEntryId = await (await client(orca)).logTime(id, hours, comments)
    orca.panels.post('redmine.issueChanged', { id })
    await refreshOnce()
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
