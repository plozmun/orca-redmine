// "Redmine" sidebar panel: connection, task list, task detail and actions.
// No network and no hooks: everything goes through the worker (plugin.request) and state lives in
// atoms. Every visible string goes through `t()`, in Orca's UI language (src/i18n).
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  EmptyState,
  Field,
  Grid,
  env,
  Heading,
  IconButton,
  Image,
  Input,
  Link,
  List,
  ListItem,
  Markdown,
  on,
  plugin,
  Progress,
  RadioGroup,
  read,
  RelativeTime,
  Row,
  Select,
  Separator,
  set,
  settings,
  shell,
  Spinner,
  Stack,
  storage,
  Switch,
  Tab,
  Tabs,
  Text,
  Textarea,
  update,
  type Atom,
  type PanelContext
} from 'orca'
import { translate, translateErrorCode, type MessageKey } from './i18n'
import { asCommentsMode, defaultInstructions, RECENT_COMMENTS, workspaceNameFor, type CommentsMode } from './launch'
import type { AgentState, LocatedWorkspace } from './orca-workspaces'
import type { ConnectionStatus } from './protocol'
import { textileToMarkdown } from './textile'
import { ISSUE_BY_WORKSPACE, LINKS_MIGRATED, PROJECT_BY_ORCA_PROJECT, type AssignedIssue } from './links'
import { taskRefFromWorkspace } from './task-ref'
import type { Followup } from './followups'
import { isBookableDay, localDateDaysAgo, recentDays } from './days'
import { type IssueDetail, type IssueStatus, type IssueSummary, type OpenCounts, type Project, type TimeEntry } from './redmine'

function t(key: MessageKey, vars?: Record<string, string | number>): string {
  return translate(env.locale, key, vars)
}

/** An error the panel raises itself, translated like the worker's. */
function panelError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

function errorText(e: unknown): string {
  const code = (e as { code?: unknown })?.code
  const detail = e instanceof Error ? e.message : String(e)
  return (typeof code === 'string' && translateErrorCode(env.locale, code, detail)) || detail
}

interface WorkspaceInfo {
  branch: string
  displayName: string
  /** The focused workspace's `workspace.list` id, when Orca gives it (host API 1.7). */
  workspaceId?: string
  terminals: { id: string; title?: string }[]
  issueId: number | null
}

const connection = atom<ConnectionStatus | null>(null)
const issues = atom<IssueSummary[]>([])
const total = atom(0)
const loading = atom(false)
const error = atom<string | null>(null)
const notice = atom<string | null>(null)
const statuses = atom<IssueStatus[]>([])
const projects = atom<Project[]>([])
/** Pending follow-ups the worker recorded: agents that finished, linked workspaces removed. */
const followups = atom<Followup[]>([])
/** Agent state of linked tasks, by task number (host API 1.7); empty when Orca does not report it. */
const agentStates = atom<Record<string, AgentState>>({})
/** My open, overdue and urgent tasks, for the tiles above the list; null until the worker answers. */
const counts = atom<OpenCounts | null>(null)
/** The action form open on one follow-up, if any. */
type FollowupAction = 'comment' | 'status' | 'time'
const followupAction = atom<{ id: string; action: FollowupAction } | null>(null)
const followupNote = atom('')
const followupHours = atom('')
const followupStatus = atom('')
const followupDay = atom('')
const followupOtherDay = atom('')
const detail = atom<IssueDetail | null>(null)
const workspace = atom<WorkspaceInfo | null>(null)
const busy = atom(false)
/** The disconnect confirmation is open (the header button only asks; this callout disconnects). */
const confirmingDisconnect = atom(false)
/** The detail's tab; a newly opened task starts on its description. */
type DetailTab = 'description' | 'activity' | 'time'
const detailTab = atom<DetailTab>('description')
function asDetailTab(value: string): DetailTab {
  return value === 'activity' || value === 'time' ? value : 'description'
}
/** The current user's time entries on the open task; null while loading. */
const timeEntries = atom<TimeEntry[] | null>(null)
const timeEntriesError = atom<string | null>(null)
/** Opening the focused workspace's task: the panel shows a spinner instead of the list. */
const issueLoading = atom(false)
/** `redmine --version`, null when redmine-cli is not installed, undefined until known. */
const redmineCli = atom<string | null | undefined>(undefined)

// Kept across panel runs.
const search = atom('redmine.search', '', { persist: 'plugin' })
const onlyMine = atom('redmine.onlyMine', true, { persist: 'plugin' })
/** Status filter for the list: `open` (default), `closed`, `*` or a status id. */
const statusFilter = atom('redmine.statusFilter', 'open', { persist: 'plugin' })

// The Redmine project is set per Orca project (repository) and shared by all its workspaces; the
// task is set per workspace (stable worktree id). Nothing is inherited from another workspace.
// Both live in the plugin's storage, shared with the worker, which links workspaces at creation.
const ALL = '*'
const projectByOrcaProject = atom<Record<string, string>>(PROJECT_BY_ORCA_PROJECT, {}, { persist: 'storage' })
const issueByWorkspace = atom<Record<string, AssignedIssue>>(ISSUE_BY_WORKSPACE, {}, { persist: 'storage' })
const linksMigrated = atom(LINKS_MIGRATED, false, { persist: 'storage' })
// Where 0.1.x kept them (panel-only). Copied once into storage and left as they are, so going back
// to 0.1.x still finds them; to be removed in a later release.
const legacyProjectByOrcaProject = atom<Record<string, string>>('redmine.projectByOrcaProject', {}, { persist: 'plugin' })
const legacyIssueByWorkspace = atom<Record<string, AssignedIssue>>('redmine.issueByWorkspace', {}, { persist: 'plugin' })

/** One-time copy of the 0.1.x links into storage; links already in storage win. */
function migrateLinks(): void {
  if (read(linksMigrated)) return
  set(issueByWorkspace, { ...read(legacyIssueByWorkspace), ...read(issueByWorkspace) })
  set(projectByOrcaProject, { ...read(legacyProjectByOrcaProject), ...read(projectByOrcaProject) })
  set(linksMigrated, true)
}
const located = atom<LocatedWorkspace | null>(null)
const locateError = atom<string | null>(null)

/** Open/closed state and search text of one SearchPicker. */
interface PickerState {
  open: Atom<boolean>
  filter: Atom<string>
}
function pickerState(): PickerState {
  return { open: atom(false), filter: atom('') }
}
const PICKER_LIMIT = 8
const redmineProjectPicker = pickerState()
const orcaProjectPicker = pickerState()
const statusPicker = pickerState()

// Launching an agent in a new workspace. Orca cannot list installed agents, so this list is fixed.
const NO_AGENT = 'none'
const AGENTS = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'gemini', label: 'Gemini' }
]
const orcaProjects = atom<{ id: string; name: string }[]>([])
const launchProject = atom('')
const launchAgent = atom('redmine.agent', 'claude', { persist: 'plugin' })
const launchActivate = atom('redmine.activate', true, { persist: 'plugin' })
const launchBase = atom('')
const launchInstructions = atom('')
const launchComments = atom<CommentsMode>('recent')
/** Whether this Orca can start an agent in a workspace (`agent.launch`); null until the worker says. */
const launchHereAvailable = atom<boolean | null>(null)
/** "Launch agent here" stays open once the person opens it, like the other sections keep their place. */
type AgentSheet = 'launch' | 'send'
/** Which agent form is open under the detail's two buttons, if any; remembered between sessions. */
const agentSheet = atom<AgentSheet | null>('redmine.agentSheet', null, { persist: 'plugin' })
type LaunchWhere = 'new' | 'here'
/** Where "Launch agent" starts the agent: in a new workspace or the focused one. */
const launchWhere = atom<LaunchWhere>('redmine.launchWhere', 'new', { persist: 'plugin' })

// Plugin settings (Settings → Plugins → Redmine), read once and kept current.
const instructionsTemplate = atom<string | null>(null)
const defaultComments = atom<CommentsMode>('recent')

async function loadSettings(): Promise<void> {
  try {
    const template = await settings.get('launchInstructions')
    set(instructionsTemplate, typeof template === 'string' && template.trim() ? template : null)
    set(defaultComments, asCommentsMode(await settings.get('contextComments')))
  } catch {
    // Settings unavailable: keep the defaults.
  }
}

// Forms.
const formUrl = atom('')
const formKey = atom('')
/** The URL comes from Settings; the form shows it read-only until the person asks to change it. */
const editingUrl = atom(false)
const terminalId = atom('')
const hours = atom('')
const timeComment = atom('')
/** The day to book: '' is today, OTHER_DAY reads `timeOtherDay`. */
const timeDay = atom('')
const timeOtherDay = atom('')
const note = atom('')

function currentProject(): string | null {
  const key = read(located)?.orcaProjectId
  return key ? (read(projectByOrcaProject)[key] ?? null) : null
}

function chooseProject(value: string): void {
  const key = read(located)?.orcaProjectId
  if (!key) return
  update(projectByOrcaProject, (map) => {
    const next = { ...map }
    if (value === ALL) delete next[key]
    else next[key] = value
    return next
  })
  void loadIssues()
}

function assignedIssue(): AssignedIssue | null {
  const key = read(located)?.workspaceKey
  return key ? (read(issueByWorkspace)[key] ?? null) : null
}

function assignIssue(issue: AssignedIssue | null): void {
  const key = read(located)?.workspaceKey
  if (!key) return
  update(issueByWorkspace, (map) => {
    const next = { ...map }
    if (issue) next[key] = { id: issue.id, subject: issue.subject }
    else delete next[key]
    return next
  })
  set(notice, issue ? t('assign.done', { id: issue.id }) : t('assign.removed'))
}

function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

async function run(task: () => Promise<void>): Promise<void> {
  set(busy, true)
  set(error, null)
  set(notice, null)
  try {
    await task()
  } catch (e) {
    set(error, errorText(e))
  } finally {
    set(busy, false)
  }
}

async function loadIssues(): Promise<void> {
  set(loading, true)
  set(error, null)
  try {
    const project = currentProject()
    const answer = await plugin.request('redmine.issues', {
      mine: read(onlyMine),
      ...(read(statusFilter) !== 'open' ? { status: read(statusFilter) } : {}),
      search: read(search),
      ...(project ? { projectId: project } : {})
    })
    set(issues, answer.issues)
    set(total, answer.total)
    void loadCounts()
    void loadAgentStates()
  } catch (e) {
    set(error, errorText(e))
  } finally {
    set(loading, false)
  }
}

/** The badges are secondary too: on failure the rows simply show none. */
async function loadAgentStates(): Promise<void> {
  try {
    set(agentStates, await plugin.request('redmine.agentStates'))
  } catch {
    set(agentStates, {})
  }
}

let agentStatesTimer: ReturnType<typeof setTimeout> | undefined
/** Agent status changes come in bursts: ask the worker once they settle, at most every 1.5 s. */
function agentStatesSoon(): void {
  if (agentStatesTimer !== undefined) return
  agentStatesTimer = setTimeout(() => {
    agentStatesTimer = undefined
    void loadAgentStates()
  }, AGENT_STATES_DEBOUNCE_MS)
}
const AGENT_STATES_DEBOUNCE_MS = 1500

/** The tiles are secondary: when the count fails, they just stay hidden. */
async function loadCounts(): Promise<void> {
  try {
    set(counts, await plugin.request('redmine.counts'))
  } catch {
    set(counts, null)
  }
}

async function afterConnect(status: ConnectionStatus): Promise<void> {
  set(connection, status)
  // The URL saved in Settings fills the form, so the panel only asks for the API key.
  if (status.url) set(formUrl, status.url)
  if (!status.configured) return
  showWorkspaceTask()
  await loadIssues()
  plugin.request('redmine.statuses').then((s) => set(statuses, s), () => set(statuses, []))
  plugin.request('redmine.projects').then((p) => set(projects, p), () => set(projects, []))
  plugin.request('redmine.orcaProjects').then((p) => set(orcaProjects, p), () => set(orcaProjects, []))
}

/** The Orca project tied to the task's Redmine project; otherwise the focused workspace's. */
function suggestedOrcaProject(issue: IssueDetail): string {
  const identifier = read(projects).find((p) => p.id === issue.projectId)?.identifier
  // Since 0.2.1 a mapping may sit under both the CLI and the host id: suggest one the picker lists.
  const offered = new Set(read(orcaProjects).map((p) => p.id))
  const keys = identifier
    ? Object.entries(read(projectByOrcaProject)).filter(([, redmine]) => redmine === identifier).map(([key]) => key)
    : []
  const mapped = keys.find((key) => offered.has(key)) ?? keys[0]
  return mapped ?? read(located)?.orcaProjectId ?? ''
}

let openSeq = 0

async function openIssue(id: number): Promise<void> {
  const seq = ++openSeq
  await run(async () => {
    const issue = await plugin.request('redmine.issue', { id })
    // Another task was opened meanwhile (e.g. the person switched workspaces): keep that one.
    if (seq !== openSeq) return
    if (read(detail)?.id !== id) {
      set(launchInstructions, defaultInstructions(issue, env.locale, read(instructionsTemplate)))
      set(launchComments, read(defaultComments))
      set(launchProject, suggestedOrcaProject(issue))
      set(launchBase, '')
      set(detailTab, 'description')
      set(timeEntries, null)
    }
    set(detail, issue)
    void loadTimeEntries(id)
  })
}

async function loadTimeEntries(id: number): Promise<void> {
  set(timeEntriesError, null)
  try {
    const entries = await plugin.request('redmine.timeEntries', { id })
    if (read(detail)?.id === id) set(timeEntries, entries)
  } catch (e) {
    if (read(detail)?.id === id) {
      set(timeEntries, [])
      set(timeEntriesError, errorText(e))
    }
  }
}

function closeIssue(): void {
  openSeq++
  set(detail, null)
}

/**
 * The focused workspace decides what the panel shows: its assigned task, or the list when it has
 * none. Runs when the workspace changes (and on connect); Back still lets you browse the list.
 */
function showWorkspaceTask(): void {
  const assigned = assignedIssue()
  if (!assigned) {
    closeIssue()
    return
  }
  if (read(detail)?.id === assigned.id) return
  set(detail, null)
  set(issueLoading, true)
  void openIssue(assigned.id).finally(() => set(issueLoading, false))
}

const connect = () =>
  run(async () => {
    await afterConnect(await plugin.request('redmine.configure', { url: read(formUrl), apiKey: read(formKey) }))
    set(formKey, '')
  })

const disconnect = () =>
  run(async () => {
    set(confirmingDisconnect, false)
    closeIssue()
    set(issues, [])
    set(connection, await plugin.request('redmine.disconnect'))
  })

function changeStatus(issue: IssueDetail, value: string): Promise<void> {
  return run(async () => {
    set(detail, await plugin.request('redmine.setStatus', { id: issue.id, statusId: Number(value) }))
    set(notice, t('status.done'))
    await loadIssues()
  })
}

function addNote(issue: IssueDetail): Promise<void> {
  return run(async () => {
    if (!read(note).trim()) throw panelError('need_comment')
    set(detail, await plugin.request('redmine.comment', { id: issue.id, notes: read(note) }))
    set(note, '')
    set(notice, t('comment.done'))
  })
}

function logTime(issue: IssueDetail): Promise<void> {
  return run(async () => {
    const value = Number(read(hours).replace(',', '.'))
    if (!Number.isFinite(value) || value <= 0) throw panelError('need_hours')
    const spentOn = chosenDay(timeDay, timeOtherDay)
    if (!spentOn) throw panelError('invalid_day')
    await plugin.request('redmine.logTime', { id: issue.id, hours: value, comments: read(timeComment), spentOn })
    set(hours, '')
    set(timeComment, '')
    set(timeDay, '')
    set(timeOtherDay, '')
    set(notice, t('time.done', { hours: value, id: issue.id }))
    await loadTimeEntries(issue.id)
  })
}

// --- Follow-ups ---

async function loadFollowups(): Promise<void> {
  try {
    set(followups, (await plugin.request('redmine.followups.get')).followups)
  } catch {
    // Follow-ups are secondary: if they cannot be read, the task list still works.
  }
}

/** Statuses a follow-up offers: every one, but only closed ones when the workspace is gone. */
function followupStatusOptions(followup: Followup): { value: string; label: string }[] {
  const all = read(statuses)
  const allowed = followup.kind === 'workspaceRemoved' ? all.filter((s) => s.isClosed) : all
  return allowed.map((s) => ({ value: String(s.id), label: s.name }))
}

function startFollowupAction(followup: Followup, action: FollowupAction): void {
  if (action === 'comment') set(followupNote, '')
  if (action === 'time') {
    set(followupHours, followup.hours === undefined ? '' : String(followup.hours))
    set(followupDay, '')
    set(followupOtherDay, '')
  }
  if (action === 'status') set(followupStatus, followupStatusOptions(followup)[0]?.value ?? '')
  set(followupAction, { id: followup.id, action })
}

/** Removes a follow-up once its action succeeded; the worker owns the store. */
async function completeFollowup(followup: Followup): Promise<void> {
  const answer = await plugin.request('redmine.followups.dismiss', { id: followup.id })
  set(followups, answer.followups)
  set(followupAction, null)
}

function dismissFollowup(followup: Followup): Promise<void> {
  return run(async () => {
    await completeFollowup(followup)
  })
}

function commentFollowup(followup: Followup): Promise<void> {
  return run(async () => {
    const notes = read(followupNote).trim()
    if (!notes) throw panelError('need_comment')
    await plugin.request('redmine.comment', { id: followup.issueId, notes })
    set(followupNote, '')
    await completeFollowup(followup)
    set(notice, t('comment.done'))
  })
}

function statusFollowup(followup: Followup): Promise<void> {
  return run(async () => {
    const statusId = Number(read(followupStatus))
    if (!statusId) throw panelError('need_status')
    await plugin.request('redmine.setStatus', { id: followup.issueId, statusId })
    await completeFollowup(followup)
    set(notice, t('status.done'))
  })
}

function timeFollowup(followup: Followup): Promise<void> {
  return run(async () => {
    const value = Number(read(followupHours).replace(',', '.'))
    if (!Number.isFinite(value) || value <= 0) throw panelError('need_hours')
    const spentOn = chosenDay(followupDay, followupOtherDay)
    if (!spentOn) throw panelError('invalid_day')
    await plugin.request('redmine.logTime', { id: followup.issueId, hours: value, comments: '', spentOn })
    set(followupHours, '')
    await completeFollowup(followup)
    set(notice, t('time.done', { hours: value, id: followup.issueId }))
  })
}

function sendToAgent(issue: IssueDetail): Promise<void> {
  return run(async () => {
    const target = read(terminalId) || read(workspace)?.terminals[0]?.id
    if (!target) throw panelError('no_terminals')
    const { accepted } = await plugin.request('redmine.sendToAgent', {
      id: issue.id,
      terminalId: target,
      locale: env.locale
    })
    set(notice, accepted ? t('send.accepted') : t('send.rejected'))
  })
}

function launchWorkspace(issue: IssueDetail): Promise<void> {
  return run(async () => {
    const orcaProjectId = read(launchProject)
    if (!orcaProjectId) throw panelError('need_orca_project')
    const agent = read(launchAgent) === NO_AGENT ? null : read(launchAgent)
    const base = read(launchBase).trim()
    const created = await plugin.request(
      'redmine.launchWorkspace',
      {
        issueId: issue.id,
        orcaProjectId,
        agent,
        instructions: read(launchInstructions),
        activate: read(launchActivate),
        locale: env.locale,
        comments: read(launchComments),
        ...(base ? { baseBranch: base } : {})
      },
      { timeoutMs: 120_000 }
    )
    if (created.workspaceKey) {
      const key = created.workspaceKey
      update(issueByWorkspace, (map) => ({ ...map, [key]: { id: issue.id, subject: issue.subject } }))
    }
    const name = created.displayName ?? created.name
    const parts = [created.branch ? t('launch.doneBranch', { name, branch: created.branch }) : t('launch.done', { name })]
    if (agent) parts.push(t('launch.doneAgent', { agent: AGENTS.find((a) => a.value === agent)?.label ?? agent }))
    if (created.workspaceKey) parts.push(t('launch.assigned'))
    set(notice, parts.join(' '))
  })
}

/**
 * Starts the chosen agent in a new terminal of the focused workspace, with the same prompt as a
 * new-workspace launch. The worker resolves the workspace id from the host's listing.
 */
function launchHere(issue: IssueDetail): Promise<void> {
  return run(async () => {
    // `agent.launch` needs a real agent: "no agent" is not an option here.
    const agent = read(launchAgent) === NO_AGENT ? AGENTS[0].value : read(launchAgent)
    const answer = await plugin.request('redmine.launchHere', {
      issueId: issue.id,
      agent,
      instructions: read(launchInstructions),
      locale: env.locale,
      comments: read(launchComments)
    })
    const label = AGENTS.find((a) => a.value === agent)?.label ?? agent
    // Assign only a workspace without a task: another task's link stays as it is.
    const key = answer.workspaceKey ?? read(located)?.workspaceKey
    if (key && !read(issueByWorkspace)[key]) {
      update(issueByWorkspace, (map) => (map[key] ? map : { ...map, [key]: { id: issue.id, subject: issue.subject } }))
      set(notice, `${t('here.done', { agent: label })} ${t('launch.assigned')}`)
    } else {
      set(notice, t('here.done', { agent: label }))
    }
  })
}

function assignById(id: number): Promise<void> {
  return run(async () => {
    assignIssue(await plugin.request('redmine.issue', { id }))
  })
}

let locateSeq = 0

/** Finds which Orca project the workspace comes from, then reloads the list with its project. */
async function locate(context: { displayName: string; branch: string; workspaceId?: string } | null): Promise<void> {
  const seq = ++locateSeq
  let found: LocatedWorkspace | null = null
  let reason: string | null = null
  if (context) {
    try {
      const answer = await plugin.request('redmine.locateWorkspace', {
        displayName: context.displayName,
        branch: context.branch,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {})
      })
      found = answer.located
      if (answer.errorCode) reason = translateErrorCode(env.locale, answer.errorCode, answer.errorDetail ?? '') ?? answer.errorDetail ?? null
    } catch (e) {
      reason = errorText(e)
    }
  }
  if (seq !== locateSeq) return
  set(located, found)
  set(locateError, reason)
  if (!read(connection)?.configured) return
  showWorkspaceTask()
  await loadIssues()
}

export function setup(ctx: PanelContext): void {
  migrateLinks()
  // The worker linked a workspace (at creation): if it is the focused one, open its task.
  ctx.subscriptions.push(
    storage.onDidChange(({ key }) => {
      if (key !== ISSUE_BY_WORKSPACE) return
      // Read the store itself: the atom may not hold the new value yet.
      void storage.get(ISSUE_BY_WORKSPACE).then((links) => {
        const workspaceKey = read(located)?.workspaceKey
        const linked = workspaceKey ? (links as Record<string, AssignedIssue> | null)?.[workspaceKey] : undefined
        if (!linked || read(detail) || read(issueLoading)) return
        set(issueLoading, true)
        void openIssue(linked.id).finally(() => set(issueLoading, false))
      })
    })
  )
  // Fires once on subscribe, then whenever the focused workspace or its terminals change.
  ctx.subscriptions.push(
    on('workspace.changed', ({ context }) => {
      const previous = read(workspace)
      if (!context) {
        set(workspace, null)
        if (previous) void locate(null)
        return
      }
      const info = { ...context, issueId: taskRefFromWorkspace(context.displayName, context.branch) }
      set(workspace, info)
      // Another workspace may belong to another Orca project: locate it and reload the list.
      if (previous?.displayName !== info.displayName || previous?.branch !== info.branch || previous?.workspaceId !== info.workspaceId) {
        void locate(info)
      }
      if (!info.terminals.some((term) => term.id === read(terminalId))) set(terminalId, info.terminals[0]?.id ?? '')
    })
  )
  ctx.subscriptions.push(
    plugin.on('redmine.issueChanged', ({ id }) => {
      if (read(detail)?.id === id) void openIssue(id)
    })
  )
  ctx.subscriptions.push(
    plugin.on('redmine.followupsChanged', ({ followups: next }) => set(followups, next))
  )
  ctx.subscriptions.push(plugin.on('redmine.countsChanged', (next) => set(counts, next)))
  ctx.subscriptions.push(on('agent.status.changed', () => agentStatesSoon()))
  ctx.subscriptions.push({
    dispose: () => {
      if (agentStatesTimer !== undefined) clearTimeout(agentStatesTimer)
      agentStatesTimer = undefined
    }
  })
  void loadFollowups()
  void loadSettings()
  ctx.subscriptions.push(
    settings.onDidChange(({ key }) => {
      void loadSettings()
      // The URL changed in Settings: check the connection again with the stored API key.
      if (key === 'url') void plugin.request('redmine.status').then(afterConnect, (e) => set(error, errorText(e)))
    })
  )
  void plugin.request('redmine.status').then(afterConnect, (e) => set(error, errorText(e)))
  // Only for a hint: on failure, say nothing.
  void plugin.request('redmine.cli').then(({ version }) => set(redmineCli, version), () => undefined)
  // The panel's own `host.has` is surface-scoped (`agent.launch` is a worker method), so the worker answers.
  void plugin.request('redmine.launchHereSupport').then(
    ({ available }) => set(launchHereAvailable, available),
    () => set(launchHereAvailable, false)
  )
}

function ConnectForm() {
  const status = read(connection)
  return (
    <Stack gap="md">
      <Heading>{t('connect.title')}</Heading>
      <Text muted size="xs">
        {t('connect.help')}
      </Text>
      {status?.errorCode ? (
        <Callout tone="danger" title={t('connect.failed')}>
          <Text size="sm">{translateErrorCode(env.locale, status.errorCode, status.errorDetail ?? '') ?? status.errorDetail ?? ''}</Text>
        </Callout>
      ) : null}
      {status?.url && !read(editingUrl) ? (
        <Row justify="between" gap="xs">
          <Text size="sm" truncate>
            {t('connect.urlFromSettings', { url: status.url })}
          </Text>
          <Link onPress={() => set(editingUrl, true)}>{t('connect.changeUrl')}</Link>
        </Row>
      ) : (
        <Input
          label={t('connect.url')}
          placeholder="https://redmine.example.com"
          value={read(formUrl)}
          onChange={(v) => set(formUrl, v)}
        />
      )}
      <Input
        label={t('connect.apiKey')}
        type="password"
        value={read(formKey)}
        onChange={(v) => set(formKey, v)}
        onSubmit={connect}
      />
      <Button tone="accent" icon="link" disabled={read(busy) || !read(formUrl) || !read(formKey)} onPress={connect}>
        {t('connect.submit')}
      </Button>
      <Text muted size="xs">
        {t('connect.whyNotSettings')}
      </Text>
    </Stack>
  )
}

interface PickerOption {
  value: string
  label: string
}

interface PickerProps {
  /** Prefix for list item keys (tests find items as `testId: '<id>-<value>'`). */
  id: string
  state: PickerState
  label: string
  value: string | null
  options: readonly PickerOption[]
  /** Shown when nothing is chosen; when given, the picker offers to clear the value. */
  noneLabel?: string
  clearLabel?: string
  placeholder?: string
  /** Closed, draw a compact label/value row (as in Orca's sidebars) with this visible label. */
  inlineLabel?: string
  onChange: (value: string | null) => void
}

/**
 * A dropdown with a search box, built from Orca components (the components `Select` cannot search).
 * Closed: a button with the current value. Open: a search field and the first matches; choosing one,
 * or pressing Enter for the first match, closes it.
 */
function SearchPicker(props: PickerProps) {
  const { id, state, label, value, options, noneLabel, clearLabel, placeholder, inlineLabel, onChange } = props
  const close = () => {
    set(state.open, false)
    set(state.filter, '')
  }
  const choose = (next: string | null) => {
    close()
    onChange(next)
  }
  const current = options.find((o) => o.value === value)

  if (!read(state.open) && inlineLabel) {
    // A label and the value as a link that truncates, so a long project name never widens the panel.
    return (
      <Row justify="between" align="center" gap="sm">
        <Box shrink={false}>
          <Text size="xs" muted>
            {inlineLabel}
          </Text>
        </Box>
        <Row gap="none" align="center">
          <Text size="xs" truncate>
            <Link key={`${id}-open`} onPress={() => set(state.open, true)}>
              {current?.label ?? noneLabel ?? placeholder ?? ''}
            </Link>
          </Text>
          <IconButton icon="expand" size="xs" variant="ghost" label={label} onPress={() => set(state.open, true)} />
          {value && noneLabel ? (
            <IconButton
              key={`${id}-clear`}
              icon="close"
              size="xs"
              label={clearLabel ?? noneLabel}
              variant="ghost"
              onPress={() => choose(null)}
            />
          ) : null}
        </Row>
      </Row>
    )
  }

  if (!read(state.open)) {
    return (
      <Field label={label}>
        <Row gap="xs">
          <Button key={`${id}-open`} variant="outline" icon="expand" onPress={() => set(state.open, true)}>
            {current?.label ?? noneLabel ?? placeholder ?? ''}
          </Button>
          {value && noneLabel ? (
            <IconButton
              key={`${id}-clear`}
              icon="close"
              label={clearLabel ?? noneLabel}
              variant="ghost"
              onPress={() => choose(null)}
            />
          ) : null}
        </Row>
      </Field>
    )
  }

  const filter = normalize(read(state.filter).trim())
  const matches = filter ? options.filter((o) => normalize(`${o.label} ${o.value}`).includes(filter)) : options
  const shown = matches.slice(0, PICKER_LIMIT)
  const items = [
    ...(noneLabel && !filter
      ? [<ListItem key={`${id}-none`} title={noneLabel} icon="close" current={!value} onPress={() => choose(null)} />]
      : []),
    ...shown.map((o) => (
      <ListItem key={`${id}-${o.value}`} title={o.label} current={o.value === value} onPress={() => choose(o.value)} />
    ))
  ]
  return (
    <Field label={label}>
      <Stack gap="xs">
        <Input
          label={t('picker.search', { label })}
          labelHidden
          type="search"
          placeholder={t('picker.searchPlaceholder', { count: options.length })}
          value={read(state.filter)}
          onChange={(v) => set(state.filter, v)}
          onSubmit={() => (shown[0] ? choose(shown[0].value) : undefined)}
        />
        {items.length > 0 ? <List label={label}>{items}</List> : <Text muted size="xs">{t('picker.empty')}</Text>}
        <Row justify="between" gap="xs">
          <Text muted size="xs">
            {matches.length > shown.length
              ? t('picker.more', { shown: shown.length, total: matches.length })
              : t('picker.count', { total: matches.length })}
          </Text>
          <Button size="sm" variant="ghost" onPress={close}>
            {t('picker.cancel')}
          </Button>
        </Row>
      </Stack>
    </Field>
  )
}

/** A small uppercase section title, like Orca's sidebars ("COMMITTED ON BRANCH 8"), with an optional action. */
function SectionHeader({ title, count, action }: { title: string; count?: number | string; action?: unknown }) {
  const label = title.toLocaleUpperCase(env.locale)
  return (
    <Row justify="between" align="center" gap="xs">
      <Text size="xs" weight="semibold" muted>
        {count === undefined ? label : `${label}  ${count}`}
      </Text>
      {action ?? null}
    </Row>
  )
}

/** One pending follow-up: what happened, then the actions that would bring Redmine up to date. */
function FollowupCard({ followup, open }: { followup: Followup; open: FollowupAction | null }) {
  const removed = followup.kind === 'workspaceRemoved'
  const options = followupStatusOptions(followup)
  const disabled = read(busy)
  return (
    <Box background="muted" radius="md" padding="sm" direction="column" gap="xs">
      <Row justify="between" align="center" gap="xs">
        <Text size="xs" weight="semibold">
          {t(removed ? 'followup.workspaceRemoved' : 'followup.agentDone', { id: followup.issueId })}
        </Text>
        <RelativeTime at={followup.at} muted />
      </Row>
      <Text size="xs" muted>
        {t('followup.workspace', { name: followup.workspaceName })}
      </Text>
      {followup.hours === undefined ? null : (
        <Text size="xs" muted>
          {t('followup.hoursSeen', { hours: Number(followup.hours.toFixed(2)) })}
        </Text>
      )}
      <Row wrap gap="xs">
        <Button size="xs" variant="outline" icon="open-external" onPress={() => openIssue(followup.issueId)}>
          {t('followup.open')}
        </Button>
        <Button size="xs" variant="outline" icon="edit" disabled={disabled} onPress={() => startFollowupAction(followup, 'comment')}>
          {t('followup.comment')}
        </Button>
        <Button size="xs" variant="outline" icon="check" disabled={disabled} onPress={() => startFollowupAction(followup, 'status')}>
          {t(removed ? 'followup.close' : 'followup.status')}
        </Button>
        <Button size="xs" variant="outline" icon="calendar" disabled={disabled} onPress={() => startFollowupAction(followup, 'time')}>
          {t('followup.time')}
        </Button>
        <Button size="xs" variant="ghost" icon="close" disabled={disabled} onPress={() => dismissFollowup(followup)}>
          {t('followup.dismiss')}
        </Button>
      </Row>
      {open === 'comment' ? (
        <Stack gap="xs">
          <Textarea
            label={t('comment.label')}
            labelHidden
            placeholder={t('followup.commentPlaceholder')}
            rows={3}
            value={read(followupNote)}
            onChange={(v) => set(followupNote, v)}
          />
          <Row justify="end">
            <Button size="xs" icon="edit" disabled={disabled || !read(followupNote).trim()} onPress={() => commentFollowup(followup)}>
              {t('followup.commentSubmit')}
            </Button>
          </Row>
        </Stack>
      ) : null}
      {open === 'status' ? (
        options.length === 0 ? (
          <Text muted size="xs">
            {t('followup.noClosedStatuses')}
          </Text>
        ) : (
          <Row gap="xs" align="end">
            <Box grow>
              <Select
                label={t('followup.statusLabel')}
                value={read(followupStatus)}
                options={options}
                onChange={(v) => set(followupStatus, v)}
              />
            </Box>
            <Button
              size="sm"
              icon="check"
              disabled={disabled || !read(followupStatus)}
              onPress={() => statusFollowup(followup)}
            >
              {t(removed ? 'followup.closeSubmit' : 'followup.statusSubmit')}
            </Button>
          </Row>
        )
      ) : null}
      {open === 'time' ? (
        <Stack gap="xs">
          <Grid columns={2} gap="xs">
            <Input label={t('followup.hours')} placeholder="1.5" value={read(followupHours)} onChange={(v) => set(followupHours, v)} />
            <DayPicker day={followupDay} other={followupOtherDay} />
          </Grid>
          <Row justify="end">
            <Button
              size="sm"
              icon="calendar"
              disabled={disabled || !read(followupHours).trim() || chosenDay(followupDay, followupOtherDay) === null}
              onPress={() => timeFollowup(followup)}
            >
              {t('followup.timeSubmit')}
            </Button>
          </Row>
        </Stack>
      ) : null}
    </Box>
  )
}

/** Pending follow-ups at the top of the task list; each opens or completes a task's after-work. */
function FollowupStrip() {
  const list = read(followups)
  if (list.length === 0) return null
  const open = read(followupAction)
  return (
    <Stack gap="sm">
      <SectionHeader title={t('followup.section')} count={list.length} />
      {list.map((followup) => (
        <FollowupCard key={followup.id} followup={followup} open={open?.id === followup.id ? open.action : null} />
      ))}
      <Text muted size="xs">
        {t('followup.hint')}
      </Text>
    </Stack>
  )
}

function ProjectPicker({ label }: { label: string }) {
  return (
    <SearchPicker
      id="redmine-project"
      state={redmineProjectPicker}
      label={label}
      inlineLabel={t('workspace.redmineProject')}
      value={currentProject()}
      options={read(projects).map((p) => ({ value: p.identifier, label: p.name }))}
      noneLabel={t('projects.all')}
      clearLabel={t('projects.clear')}
      onChange={(v) => chooseProject(v ?? ALL)}
    />
  )
}

/**
 * The focused workspace, kept short: its Redmine project (shared by the Orca project) and, when the
 * branch names a task not yet assigned, an offer to assign it. The workspace name and branch are
 * already in Orca's own sidebar.
 */
function WorkspaceBar() {
  const ws = read(workspace)
  const loc = read(located)
  if (!ws) {
    return (
      <Text muted size="xs">
        {t('workspace.none')}
      </Text>
    )
  }
  const assigned = assignedIssue()
  const suggested = loc && ws.issueId && ws.issueId !== assigned?.id ? ws.issueId : null
  const reason = read(locateError)
  return (
    <Stack gap="xs">
      {loc?.orcaProjectId && read(projects).length > 0 ? (
        <ProjectPicker label={t('workspace.redmineProjectFor', { name: loc.orcaProjectName ?? '' })} />
      ) : null}
      {!loc?.orcaProjectId && read(projects).length > 0 ? (
        <Text muted size="xs">
          {reason ? t('workspace.orcaProjectUnknownReason', { reason }) : t('workspace.orcaProjectUnknown')}
        </Text>
      ) : null}
      {suggested ? (
        <Button size="sm" variant="outline" icon="branch" onPress={() => assignById(suggested)}>
          {t('workspace.assignFromBranch', { id: suggested })}
        </Button>
      ) : null}
    </Stack>
  )
}

/** Which tasks the list shows: open (default), closed, any, or one status. */
function StatusPicker() {
  const value = read(statusFilter)
  return (
    <SearchPicker
      id="status-filter"
      state={statusPicker}
      label={t('statusFilter.label')}
      inlineLabel={t('statusFilter.label')}
      value={value === 'open' ? null : value}
      options={[
        { value: 'closed', label: t('statusFilter.closed') },
        { value: '*', label: t('statusFilter.any') },
        ...read(statuses).map((s) => ({ value: String(s.id), label: s.name }))
      ]}
      noneLabel={t('statusFilter.open')}
      clearLabel={t('statusFilter.clear')}
      onChange={(v) => {
        set(statusFilter, v ?? 'open')
        void loadIssues()
      }}
    />
  )
}

const CLOSED_HINT = /closed|cerrad|resuel|resolved|done|hecho|finaliz/i
const BLOCKED_HINT = /block|bloque|rechaz|reject/i
const ACTIVE_HINT = /progress|curso|doing|desarroll/i

/**
 * A tone per status, outlined with a dot like the priority badge: open work (new, to do, feedback)
 * green, in progress amber, blocked red. Finished tasks stay grey: they are rarely listed and need
 * nothing.
 */
function statusTone(status: string): 'neutral' | 'success' | 'warning' | 'danger' {
  if (BLOCKED_HINT.test(status)) return 'danger'
  if (CLOSED_HINT.test(status)) return 'neutral'
  if (ACTIVE_HINT.test(status)) return 'warning'
  return 'success'
}

/** Priorities worth pointing out in a list; the usual one is left out to keep rows quiet. */
const URGENT_PRIORITY = /urgent|immediate|inmediat|alta|high/i

interface RowOptions {
  showProject: boolean
  /** Every listed task has the same assignee when only mine are listed: not repeated. */
  showAssignee: boolean
}

/**
 * One task, compact: number, tracker and anything unusual (state, a high priority) on one line, the
 * subject, then the project and assignee when the list mixes them.
 */
/** Agent badges: waiting on the person stands out, working is calm, done is good news. */
const AGENT_TONE: Record<AgentState, 'neutral' | 'warning' | 'success'> = { working: 'neutral', permission: 'warning', done: 'success' }
const AGENT_LABEL: Record<AgentState, MessageKey> = {
  working: 'agentState.working',
  permission: 'agentState.permission',
  done: 'agentState.done'
}

function IssueRow({ issue, assigned, options }: { issue: IssueSummary; assigned: boolean; options: RowOptions }) {
  const urgent = URGENT_PRIORITY.test(issue.priority)
  const agent = read(agentStates)[String(issue.id)]
  const meta = [
    ...(options.showProject ? [issue.project] : []),
    ...(options.showAssignee ? [issue.assignee ?? t('issue.unassigned')] : [])
  ]
  return (
    <ListItem key={`issue-${issue.id}`} current={assigned} onPress={() => openIssue(issue.id)}>
      <Stack gap="xs">
        <Row justify="between" align="center" gap="xs">
          <Row gap="xs" align="center">
            <Text size="xs" weight="semibold" tone="accent">{`#${issue.id}`}</Text>
            <Text size="xs" muted truncate>
              {issue.tracker}
            </Text>
          </Row>
          <Row gap="xs" align="center">
            {urgent ? <Badge tone="warning">{issue.priority}</Badge> : null}
            <Badge tone={statusTone(issue.status)}>{issue.status}</Badge>
          </Row>
        </Row>
        <Text size="xs" weight="medium">
          {issue.subject}
        </Text>
        {meta.length > 0 || agent ? (
          <Row gap="xs" align="center">
            {agent ? <Badge tone={AGENT_TONE[agent]}>{t(AGENT_LABEL[agent])}</Badge> : null}
            {meta.length > 0 ? (
              <Text size="xs" muted truncate>
                {meta.join(' · ')}
              </Text>
            ) : null}
          </Row>
        ) : null}
      </Stack>
    </ListItem>
  )
}

/** One count above the list: the number large, in its tone when it is not zero, the label small. */
function StatTile({ value, label, tone }: { value: number; label: string; tone?: 'warning' | 'danger' }) {
  return (
    <Box border radius="md" background="card" paddingX="sm" paddingY="xs" direction="column" gap="none">
      <Heading level={3}>
        <Text weight="semibold" tone={value > 0 ? tone : undefined}>
          {String(value)}
        </Text>
      </Heading>
      <Text size="xs" muted truncate>
        {label.toLocaleUpperCase(env.locale)}
      </Text>
    </Box>
  )
}

/** My open, overdue and urgent tasks, whatever the list below is filtered by. */
function StatTiles() {
  const c = read(counts)
  if (!c) return null
  return (
    <Grid columns={3} gap="xs">
      <StatTile value={c.total} label={t('stats.open')} />
      <StatTile value={c.overdue} label={t('stats.overdue')} tone="warning" />
      <StatTile value={c.urgent} label={t('stats.urgent')} tone="danger" />
    </Grid>
  )
}

function IssueList() {
  const assigned = assignedIssue()
  const list = read(issues)
  const filtered = currentProject() !== null
  const rowOptions: RowOptions = {
    showProject: !filtered,
    showAssignee: !read(onlyMine)
  }
  return (
    <Stack gap="sm">
      <StatTiles />
      <Input
        label={t('list.search')}
        labelHidden
        type="search"
        placeholder={t('list.searchPlaceholder')}
        value={read(search)}
        onChange={(v) => set(search, v)}
        onSubmit={() => loadIssues()}
      />
      <RadioGroup
        label={t('list.scope')}
        labelHidden
        orientation="horizontal"
        value={read(onlyMine) ? 'mine' : 'all'}
        options={[
          { value: 'mine', label: t('list.scopeMine') },
          { value: 'all', label: t('list.scopeAll') }
        ]}
        onChange={(v) => {
          set(onlyMine, v === 'mine')
          void loadIssues()
        }}
      />
      {/* Filters in one quiet card, label on the left and value on the right, as Orca's sidebars. */}
      <Box background="muted" radius="md" paddingX="sm" paddingY="xs" direction="column" gap="xs">
        <WorkspaceBar />
        <StatusPicker />
      </Box>
      <SectionHeader
        title={t('section.tasks')}
        count={read(loading) ? undefined : list.length < read(total) ? `${list.length}/${read(total)}` : list.length}
      />
      {read(loading) ? (
        <Spinner label={t('list.loading')} />
      ) : list.length === 0 ? (
        <EmptyState
          icon="check"
          title={read(statusFilter) === 'open' ? t('list.empty') : t('list.emptyAny')}
          description={t('list.emptyHint')}
        />
      ) : (
        <List label={t('list.count', { shown: list.length, total: read(total) })}>
          {list.map((issue) => (
            <IssueRow issue={issue} assigned={issue.id === assigned?.id} options={rowOptions} />
          ))}
        </List>
      )}
    </Stack>
  )
}

function LaunchForm({ issue }: { issue: IssueDetail }) {
  const noAgent = read(launchAgent) === NO_AGENT
  return (
      <Stack gap="sm">
        <Text muted size="xs">
          {t('launch.subtitle')}
        </Text>
        <Text muted size="xs">
          {t('launch.name', { name: workspaceNameFor(issue) })}
        </Text>
        {read(orcaProjects).length > 0 ? (
          <SearchPicker
            id="orca-project"
            state={orcaProjectPicker}
            label={t('launch.orcaProject')}
            placeholder={t('launch.orcaProjectPlaceholder')}
            value={read(launchProject) || null}
            options={read(orcaProjects).map((p) => ({ value: p.id, label: p.name }))}
            onChange={(v) => set(launchProject, v ?? '')}
          />
        ) : (
          <Text muted size="xs">
            {t('launch.noOrcaProjects')}
          </Text>
        )}
        <Select
          label={t('launch.agent')}
          value={read(launchAgent)}
          options={[...AGENTS, { value: NO_AGENT, label: t('launch.noAgent') }]}
          onChange={(v) => set(launchAgent, v)}
        />
        <Input
          label={t('launch.baseBranch')}
          placeholder={t('launch.baseBranchPlaceholder')}
          value={read(launchBase)}
          onChange={(v) => set(launchBase, v)}
        />
        {noAgent ? null : (
          <Textarea
            label={t('launch.instructions')}
            rows={3}
            value={read(launchInstructions)}
            onChange={(v) => set(launchInstructions, v)}
          />
        )}
        {noAgent ? null : (
          <Select
            label={t('launch.comments')}
            value={read(launchComments)}
            options={[
              { value: 'none', label: t('launch.commentsNone') },
              { value: 'recent', label: t('launch.commentsRecent', { count: Math.min(RECENT_COMMENTS, issue.journals.length) }) },
              { value: 'all', label: t('launch.commentsAll', { count: issue.journals.length }) }
            ]}
            onChange={(v) => set(launchComments, asCommentsMode(v))}
          />
        )}
        <Switch label={t('launch.activate')} checked={read(launchActivate)} onChange={(v) => set(launchActivate, v)} />
        <Button
          tone="accent"
          icon="rocket"
          disabled={read(busy) || !read(launchProject)}
          onPress={() => launchWorkspace(issue)}
        >
          {noAgent ? t('launch.submitNoAgent') : t('launch.submit')}
        </Button>
        {noAgent ? null : (
          <Text muted size="xs">
            {t('launch.contextHint')}
          </Text>
        )}
        <Text muted size="xs">
          {t('launch.settingsHint')}
        </Text>
      </Stack>
  )
}

/**
 * "Launch agent here": starts an agent in a new terminal of the focused workspace, with the same
 * instructions and context a new-workspace launch gets. Disabled without a workspace or when the
 * host cannot start agents; both say why.
 */
function HereForm({ issue }: { issue: IssueDetail }) {
  const available = read(launchHereAvailable)
  const ws = read(workspace)
  const agent = read(launchAgent) === NO_AGENT ? AGENTS[0].value : read(launchAgent)
  return (
      <Stack gap="sm">
        <Text muted size="xs">
          {t('here.subtitle')}
        </Text>
        <Select label={t('launch.agent')} value={agent} options={AGENTS} onChange={(v) => set(launchAgent, v)} />
        <Textarea
          label={t('launch.instructions')}
          rows={3}
          value={read(launchInstructions)}
          onChange={(v) => set(launchInstructions, v)}
        />
        <Select
          label={t('launch.comments')}
          value={read(launchComments)}
          options={[
            { value: 'none', label: t('launch.commentsNone') },
            { value: 'recent', label: t('launch.commentsRecent', { count: Math.min(RECENT_COMMENTS, issue.journals.length) }) },
            { value: 'all', label: t('launch.commentsAll', { count: issue.journals.length }) }
          ]}
          onChange={(v) => set(launchComments, asCommentsMode(v))}
        />
        <Button tone="accent" icon="agent" disabled={read(busy) || !ws || available !== true} onPress={() => launchHere(issue)}>
          {t('here.submit')}
        </Button>
        {!ws ? (
          <Text muted size="xs">
            {t('here.noWorkspace')}
          </Text>
        ) : available === false ? (
          <Text muted size="xs">
            {t('here.unsupported')}
          </Text>
        ) : (
          <Text muted size="xs">
            {t('launch.contextHint')}
          </Text>
        )}
      </Stack>
  )
}

/** "Send to terminal": types the task prompt into a terminal of the focused workspace. */
function SendForm({ issue }: { issue: IssueDetail }) {
  const ws = read(workspace)
  return (
    <Stack gap="sm">
      <Text muted size="xs">
        {t('send.subtitle')}
      </Text>
      {ws && ws.terminals.length > 0 ? (
        <Select
          label={t('send.terminal')}
          value={read(terminalId)}
          options={ws.terminals.map((term) => ({ value: term.id, label: term.title ?? term.id }))}
          onChange={(v) => set(terminalId, v)}
        />
      ) : (
        <Text muted size="xs">
          {t('send.noTerminals')}
        </Text>
      )}
      <Button icon="agent" disabled={read(busy) || !ws?.terminals.length} onPress={() => sendToAgent(issue)}>
        {t('send.submit')}
      </Button>
    </Stack>
  )
}

/**
 * The open agent form, drawn as a sheet under the two buttons (components panels have no popups):
 * a bordered card with its title and a close button.
 */
function AgentSheetView({ issue, sheet }: { issue: IssueDetail; sheet: AgentSheet }) {
  const where = read(launchWhere)
  const title = sheet === 'send' ? t('send.title') : where === 'here' ? t('here.title') : t('launch.title')
  return (
    <Box border radius="md" background="card" padding="sm" direction="column" gap="sm">
      <Row justify="between" align="center" gap="xs">
        <Text size="sm" weight="semibold">
          {title}
        </Text>
        <IconButton icon="close" size="xs" variant="ghost" label={t('agent.close')} onPress={() => set(agentSheet, null)} />
      </Row>
      {sheet === 'launch' ? (
        <RadioGroup
          label={t('agent.where')}
          labelHidden
          orientation="horizontal"
          value={where}
          options={[
            { value: 'new', label: t('agent.whereNew') },
            { value: 'here', label: t('agent.whereHere') }
          ]}
          onChange={(v) => set(launchWhere, v === 'here' ? 'here' : 'new')}
        />
      ) : null}
      {sheet === 'send' ? <SendForm issue={issue} /> : where === 'here' ? <HereForm issue={issue} /> : <LaunchForm issue={issue} />}
    </Box>
  )
}

/** The day picker's last choice: type a date. */
const OTHER_DAY = 'other'

/** The day a time entry goes to, or null while a typed date is not a bookable day. */
function chosenDay(day: Atom<string>, other: Atom<string>): string | null {
  const value = read(day)
  if (value === OTHER_DAY) {
    const typed = read(other).trim()
    return isBookableDay(typed) ? typed : null
  }
  return value || localDateDaysAgo(0)
}

function dayOptionLabel(day: string, index: number): string {
  if (index === 0) return t('time.today')
  if (index === 1) return t('time.yesterday')
  try {
    return new Date(`${day}T00:00:00`).toLocaleDateString(env.locale, { weekday: 'short', day: 'numeric', month: 'short' })
  } catch {
    return day
  }
}

/** Today, yesterday, the five days before, or a typed date (checked as it is typed). */
function DayPicker({ day, other }: { day: Atom<string>; other: Atom<string> }) {
  const days = recentDays()
  const value = read(day) || days[0]
  const typed = read(other).trim()
  return (
    <Stack gap="xs">
      <Select
        label={t('time.day')}
        value={value}
        options={[...days.map((d, i) => ({ value: d, label: dayOptionLabel(d, i) })), { value: OTHER_DAY, label: t('time.otherDay') }]}
        onChange={(v) => set(day, v)}
      />
      {value === OTHER_DAY ? (
        <Input
          label={t('time.otherDayLabel')}
          placeholder={localDateDaysAgo(RECENT_PLACEHOLDER_DAYS)}
          value={read(other)}
          invalid={typed !== '' && !isBookableDay(typed)}
          onChange={(v) => set(other, v)}
        />
      ) : null}
    </Stack>
  )
}

/** The typed-date placeholder shows a day just before the ones the picker lists. */
const RECENT_PLACEHOLDER_DAYS = 10

function hoursText(hours: number): string {
  return t('time.hours.value', { hours: Number(hours.toFixed(2)) })
}

function dayText(day: string): string {
  const date = new Date(`${day}T00:00:00`)
  if (Number.isNaN(date.getTime())) return day
  try {
    return date.toLocaleDateString(env.locale, { day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return day
  }
}

/** Time tab: log time, then the current user's entries on this task with their total. */
function TimeTab({ issue }: { issue: IssueDetail }) {
  const entries = read(timeEntries)
  const failed = read(timeEntriesError)
  const totalHours = (entries ?? []).reduce((sum, e) => sum + e.hours, 0)
  return (
    <Stack gap="sm">
      <Box border radius="md" padding="sm" direction="column" gap="sm">
        <Grid columns={2} gap="sm">
          <Input label={t('time.hours')} placeholder="1.5" value={read(hours)} onChange={(v) => set(hours, v)} />
          <DayPicker day={timeDay} other={timeOtherDay} />
        </Grid>
        <Input
          label={t('time.comment')}
          value={read(timeComment)}
          onChange={(v) => set(timeComment, v)}
          onSubmit={() => logTime(issue)}
        />
        <Row justify="end">
          <Button
            size="sm"
            variant="solid"
            icon="calendar"
            disabled={read(busy) || !read(hours).trim() || chosenDay(timeDay, timeOtherDay) === null}
            onPress={() => logTime(issue)}
          >
            {t('time.submit')}
          </Button>
        </Row>
      </Box>
      <SectionHeader title={t('time.mine')} count={entries ? hoursText(totalHours) : undefined} />
      {entries === null ? (
        <Spinner label={t('time.loading')} />
      ) : failed ? (
        <Text muted size="xs">
          {failed}
        </Text>
      ) : entries.length === 0 ? (
        <Text muted size="xs">
          {t('time.none')}
        </Text>
      ) : (
        <Stack gap="xs">
          {entries.map((e) => (
            <Row key={`time-${e.id}`} justify="between" align="start" gap="sm">
              <Stack gap="none">
                <Text size="sm">{e.comments || e.activity}</Text>
                <Text size="xs" muted>
                  {e.comments && e.activity ? `${dayText(e.spentOn)} · ${e.activity}` : dayText(e.spentOn)}
                </Text>
              </Stack>
              <Box shrink={false}>
                <Text size="sm" weight="semibold">
                  {hoursText(e.hours)}
                </Text>
              </Box>
            </Row>
          ))}
        </Stack>
      )}
    </Stack>
  )
}

/** One detail line: a small muted label in a fixed column, then the value. */
function DetailRow({ label, children }: { label: string; children: unknown }) {
  return (
    <Row gap="sm" align="center">
      <Box width={72} shrink={false}>
        <Text size="xs" muted>
          {label}
        </Text>
      </Box>
      <Box grow shrink>
        {children}
      </Box>
    </Row>
  )
}

function IssueView({ issue }: { issue: IssueDetail }) {
  const disabled = read(busy)
  const assigned = assignedIssue()
  const isWorkspaceTask = assigned?.id === issue.id
  const urgent = URGENT_PRIORITY.test(issue.priority)
  const sheet = read(agentSheet)
  const toggleSheet = (next: AgentSheet) => set(agentSheet, sheet === next ? null : next)
  return (
    <Stack gap="md">
      {/* Header: back, number and tracker on the left; status, reload and Redmine on the right. */}
      <Row justify="between" align="center" gap="xs">
        <Row gap="xs" align="center">
          <Button variant="outline" size="xs" onPress={closeIssue}>
            {t('issue.back')}
          </Button>
          <Text size="sm" weight="semibold" tone="accent">{`#${issue.id}`}</Text>
          <Text size="xs" muted truncate>
            {issue.tracker}
          </Text>
        </Row>
        <Row gap="none" align="center">
          <Badge tone={statusTone(issue.status)}>{issue.status}</Badge>
          <IconButton icon="refresh" size="sm" variant="ghost" label={t('header.reload')} onPress={() => openIssue(issue.id)} />
          <IconButton
            icon="open-external"
            size="sm"
            variant="ghost"
            label={t('issue.openInRedmine')}
            onPress={() => shell.openExternal(issue.url)}
          />
        </Row>
      </Row>

      {/* The task card: title, when it changed, its fields and progress. */}
      <Box border radius="md" background="card" padding="sm" direction="column" gap="sm">
        <Stack gap="none">
          <Text size="sm" weight="semibold">
            {issue.subject}
          </Text>
          <Text muted size="xs">
            {`${t('issue.updated')} `}
            <RelativeTime at={Date.parse(issue.updatedOn) || Date.now()} />
          </Text>
        </Stack>
        <Stack gap="xs">
          <DetailRow label={t('issue.project')}>
            <Text size="xs" truncate>
              {issue.project}
            </Text>
          </DetailRow>
          <DetailRow label={t('issue.assignee')}>
            <Text size="xs" truncate>
              {issue.assignee ?? t('issue.unassigned')}
            </Text>
          </DetailRow>
          <DetailRow label={t('issue.priority')}>
            {urgent ? <Badge tone="warning">{issue.priority}</Badge> : <Text size="xs">{issue.priority}</Text>}
          </DetailRow>
          <DetailRow label={t('issue.done')}>
            <Stack gap="xs">
              <Text size="xs">{`${issue.doneRatio}%`}</Text>
              <Progress label={t('issue.done')} labelHidden value={issue.doneRatio} />
            </Stack>
          </DetailRow>
        </Stack>
        {read(statuses).length > 0 ? (
          <Select
            label={t('issue.status')}
            labelHidden
            value={String(issue.statusId)}
            options={read(statuses).map((s) => ({ value: String(s.id), label: s.name }))}
            disabled={disabled}
            onChange={(v) => changeStatus(issue, v)}
          />
        ) : null}
      </Box>

      {read(located) ? (
        isWorkspaceTask ? (
          <Row justify="between" align="center" gap="xs">
            <Badge tone="success">{t('issue.isWorkspaceTask')}</Badge>
            <Button size="xs" variant="ghost" onPress={() => assignIssue(null)}>
              {t('issue.unassign')}
            </Button>
          </Row>
        ) : (
          <Button size="sm" variant="outline" icon="link" onPress={() => assignIssue(issue)}>
            {assigned ? t('issue.assignReplacing', { id: assigned.id }) : t('issue.assign')}
          </Button>
        )
      ) : null}

      {/* The agent actions: two buttons, each opening its form as a sheet underneath. */}
      <Stack gap="sm">
        <Grid columns={2} gap="sm">
          <Button variant="solid" icon="play" onPress={() => toggleSheet('launch')}>
            {t('agent.launch')}
          </Button>
          <Button variant="outline" icon="terminal" onPress={() => toggleSheet('send')}>
            {t('agent.send')}
          </Button>
        </Grid>
        {read(redmineCli) === null ? (
          <Text muted size="xs">
            {t('agent.noCli')}
          </Text>
        ) : null}
        {sheet ? <AgentSheetView issue={issue} sheet={sheet} /> : null}
      </Stack>

      <Tabs label={t('tabs.label')} value={read(detailTab)} onChange={(v) => set(detailTab, asDetailTab(v))}>
        <Tab value="description" label={t('issue.description')} icon="file-text">
          {issue.description ? (
            <Box background="muted" radius="md" padding="sm">
              <Markdown content={textileToMarkdown(issue.description)} />
            </Box>
          ) : (
            <Text muted size="xs">
              {t('issue.noDescription')}
            </Text>
          )}
        </Tab>

        <Tab value="activity" label={t('tabs.activity', { count: issue.journals.length })} icon="activity">
          <Stack gap="sm">
            {issue.journals.length === 0 ? (
              <Text muted size="xs">
                {t('issue.noComments')}
              </Text>
            ) : (
              issue.journals.map((j) => (
                // One comment per grey box, author and time on top, as in GitLab.
                <Box background="muted" radius="md" padding="sm" direction="column" gap="xs">
                  <Row justify="between" align="center" gap="xs">
                    <Text size="xs" weight="semibold" truncate>
                      {j.author}
                    </Text>
                    <RelativeTime at={Date.parse(j.createdOn) || Date.now()} muted />
                  </Row>
                  <Markdown content={textileToMarkdown(j.notes)} />
                </Box>
              ))
            )}
            <Textarea
              label={t('comment.label')}
              labelHidden
              placeholder={t('comment.placeholder')}
              rows={3}
              value={read(note)}
              onChange={(v) => set(note, v)}
            />
            <Row justify="end">
              <Button size="sm" icon="edit" disabled={disabled || !read(note).trim()} onPress={() => addNote(issue)}>
                {t('comment.submit')}
              </Button>
            </Row>
          </Stack>
        </Tab>

        <Tab value="time" label={t('tabs.time')} icon="calendar">
          <TimeTab issue={issue} />
        </Tab>
      </Tabs>
    </Stack>
  )
}

/** The server without its scheme, as the header's second line shows it. */
function hostOf(url: string | undefined): string {
  return (url ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '')
}

/** Logo, "Redmine", then the server and the connected user; refresh and connection on the right. */
function ListHeader({ status }: { status: ConnectionStatus }) {
  const user = status.user ? status.user.name || status.user.login : null
  const line = [hostOf(status.url ?? undefined), user].filter(Boolean).join(' · ')
  return (
    <Row justify="between" align="center" gap="sm">
      <Row gap="sm" align="center">
        <Image src="assets/icon.png" alt="" size="xs" rounded />
        <Stack gap="none">
          <Text size="sm" weight="semibold">
            {t('header.title')}
          </Text>
          {line ? (
            <Text size="xs" muted truncate>
              {line}
            </Text>
          ) : null}
        </Stack>
      </Row>
      <Row gap="xs" align="center">
        <IconButton icon="refresh" size="sm" variant="outline" label={t('header.reload')} onPress={() => loadIssues()} />
        <IconButton
          key="connection"
          icon="plug"
          size="sm"
          label={t('header.connection')}
          variant="outline"
          onPress={() => update(confirmingDisconnect, (open) => !open)}
        />
      </Row>
    </Row>
  )
}

/** Disconnecting deletes the API key, so it takes a second, explicit press. */
function DisconnectConfirm({ status }: { status: ConnectionStatus }) {
  const user = status.user ? status.user.name || status.user.login : '?'
  return (
    <Callout tone="warning" icon="warning" title={t('disconnect.title')}>
      <Stack gap="sm">
        <Text size="sm">{t('disconnect.body', { url: status.url ?? '', user })}</Text>
        <Row gap="sm">
          <Button key="disconnect-confirm" size="sm" variant="solid" tone="danger" icon="close" disabled={read(busy)} onPress={disconnect}>
            {t('disconnect.confirm')}
          </Button>
          <Button key="disconnect-cancel" size="sm" variant="ghost" onPress={() => set(confirmingDisconnect, false)}>
            {t('disconnect.cancel')}
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}

export default function Panel() {
  const status = read(connection)
  const current = read(detail)
  const err = read(error)
  const info = read(notice)
  return (
    <Stack gap="md">
      {status?.configured && !current ? <ListHeader status={status} /> : null}
      {status?.configured && read(confirmingDisconnect) ? <DisconnectConfirm status={status} /> : null}
      {err ? (
        <Callout tone="danger" icon="error">
          <Text size="sm">{err}</Text>
        </Callout>
      ) : null}
      {info ? (
        <Callout tone="success" icon="check">
          <Text size="sm">{info}</Text>
        </Callout>
      ) : null}
      {status?.configured ? <FollowupStrip /> : null}
      {status === null ? (
        <Spinner label={t('connecting')} />
      ) : !status.configured ? (
        <ConnectForm />
      ) : current ? (
        <IssueView issue={current} />
      ) : read(issueLoading) ? (
        <Spinner label={t('issue.loading')} />
      ) : (
        <IssueList />
      )}
    </Stack>
  )
}
