// "Redmine" sidebar panel: connection, task list, task detail and actions.
// No network and no hooks: everything goes through the worker (plugin.request) and state lives in
// atoms. Every visible string goes through `t()`, in Orca's UI language (src/i18n).
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Collapsible,
  EmptyState,
  Field,
  env,
  Heading,
  IconButton,
  Input,
  KeyValue,
  Link,
  List,
  ListItem,
  Markdown,
  on,
  plugin,
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
import type { LocatedWorkspace } from './orca-workspaces'
import type { ConnectionStatus } from './protocol'
import { textileToMarkdown } from './textile'
import { ISSUE_BY_WORKSPACE, LINKS_MIGRATED, PROJECT_BY_ORCA_PROJECT, type AssignedIssue } from './links'
import { taskRefFromWorkspace } from './task-ref'
import type { Followup } from './followups'
import { type IssueDetail, type IssueStatus, type IssueSummary, type Project, type TimeEntry } from './redmine'

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
/** The action form open on one follow-up, if any. */
type FollowupAction = 'comment' | 'status' | 'time'
const followupAction = atom<{ id: string; action: FollowupAction } | null>(null)
const followupNote = atom('')
const followupHours = atom('')
const followupStatus = atom('')
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
const hereOpen = atom('redmine.hereOpen', false, { persist: 'plugin' })

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
  } catch (e) {
    set(error, errorText(e))
  } finally {
    set(loading, false)
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
  const mapped = identifier
    ? Object.entries(read(projectByOrcaProject)).find(([, redmine]) => redmine === identifier)?.[0]
    : undefined
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
    await plugin.request('redmine.logTime', { id: issue.id, hours: value, comments: read(timeComment) })
    set(hours, '')
    set(timeComment, '')
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
  if (action === 'time') set(followupHours, followup.hours === undefined ? '' : String(followup.hours))
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
    await plugin.request('redmine.logTime', { id: followup.issueId, hours: value, comments: '' })
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
async function locate(context: { displayName: string; branch: string } | null): Promise<void> {
  const seq = ++locateSeq
  let found: LocatedWorkspace | null = null
  let reason: string | null = null
  if (context) {
    try {
      const answer = await plugin.request('redmine.locateWorkspace', {
        displayName: context.displayName,
        branch: context.branch
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
      if (previous?.displayName !== info.displayName || previous?.branch !== info.branch) void locate(info)
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
        <Row gap="xs" align="end">
          <Box grow>
            <Input label={t('followup.hours')} placeholder="1.5" value={read(followupHours)} onChange={(v) => set(followupHours, v)} />
          </Box>
          <Button
            size="sm"
            icon="calendar"
            disabled={disabled || !read(followupHours).trim()}
            onPress={() => timeFollowup(followup)}
          >
            {t('followup.timeSubmit')}
          </Button>
        </Row>
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

function statusTone(status: string): 'neutral' | 'accent' | 'success' | 'warning' | 'danger' {
  if (BLOCKED_HINT.test(status)) return 'danger'
  if (CLOSED_HINT.test(status)) return 'success'
  if (ACTIVE_HINT.test(status)) return 'accent'
  return 'neutral'
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
function IssueRow({ issue, assigned, options }: { issue: IssueSummary; assigned: boolean; options: RowOptions }) {
  const urgent = URGENT_PRIORITY.test(issue.priority)
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
        {meta.length > 0 ? (
          <Text size="xs" muted truncate>
            {meta.join(' · ')}
          </Text>
        ) : null}
      </Stack>
    </ListItem>
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
      <Input
        label={t('list.search')}
        labelHidden
        type="search"
        placeholder={t('list.searchPlaceholder')}
        value={read(search)}
        onChange={(v) => set(search, v)}
        onSubmit={() => loadIssues()}
      />
      {/* Filters in one quiet card, label on the left and value on the right, as Orca's sidebars. */}
      <Box background="muted" radius="md" paddingX="sm" paddingY="xs" direction="column" gap="xs">
        <WorkspaceBar />
        <StatusPicker />
        <Switch
          label={t('list.onlyMine')}
          checked={read(onlyMine)}
          onChange={(v) => {
            set(onlyMine, v)
            void loadIssues()
          }}
        />
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

function LaunchSection({ issue }: { issue: IssueDetail }) {
  const noAgent = read(launchAgent) === NO_AGENT
  return (
    <Collapsible title={t('launch.title')} description={t('launch.subtitle')}>
      <Stack gap="sm">
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
    </Collapsible>
  )
}

/**
 * "Launch agent here": starts an agent in a new terminal of the focused workspace, with the same
 * instructions and context a new-workspace launch gets. Disabled without a workspace or when the
 * host cannot start agents; both say why.
 */
function HereSection({ issue }: { issue: IssueDetail }) {
  const available = read(launchHereAvailable)
  const ws = read(workspace)
  const agent = read(launchAgent) === NO_AGENT ? AGENTS[0].value : read(launchAgent)
  return (
    <Collapsible
      title={t('here.title')}
      description={t('here.subtitle')}
      open={read(hereOpen)}
      onChange={(open) => set(hereOpen, open)}
    >
      <Stack gap="sm">
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
    </Collapsible>
  )
}

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
      <Box background="muted" radius="md" padding="sm" direction="column" gap="sm">
        <Row gap="sm" align="end">
          <Box grow>
            <Input label={t('time.hours')} placeholder="1.5" value={read(hours)} onChange={(v) => set(hours, v)} />
          </Box>
          <Box grow>
            <Input
              label={t('time.comment')}
              value={read(timeComment)}
              onChange={(v) => set(timeComment, v)}
              onSubmit={() => logTime(issue)}
            />
          </Box>
        </Row>
        <Row justify="end">
          <Button size="sm" icon="calendar" disabled={read(busy) || !read(hours).trim()} onPress={() => logTime(issue)}>
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

function IssueView({ issue }: { issue: IssueDetail }) {
  const ws = read(workspace)
  const disabled = read(busy)
  const assigned = assignedIssue()
  const isWorkspaceTask = assigned?.id === issue.id
  const urgent = URGENT_PRIORITY.test(issue.priority)
  return (
    <Stack gap="md">
      {/* Header, like Orca's Checks panel: number and state, title, then a muted meta line. */}
      <Stack gap="xs">
        <Row justify="between" align="center">
          <Row gap="xs" align="center">
            <Button variant="ghost" size="xs" onPress={closeIssue}>
              {t('issue.back')}
            </Button>
            <Text size="sm" weight="semibold">{`#${issue.id}`}</Text>
            <Badge tone={statusTone(issue.status)}>{issue.status}</Badge>
          </Row>
          <IconButton
            icon="open-external"
            size="sm"
            variant="ghost"
            label={t('issue.openInRedmine')}
            onPress={() => shell.openExternal(issue.url)}
          />
        </Row>
        <Text size="sm" weight="semibold">
          {issue.subject}
        </Text>
        <Text muted size="xs">
          {`${issue.tracker} · ${t('issue.updated')} `}
          <RelativeTime at={Date.parse(issue.updatedOn) || Date.now()} />
        </Text>
      </Stack>

      <KeyValue
        items={[
          { label: t('issue.project'), value: issue.project },
          { label: t('issue.assignee'), value: issue.assignee ?? t('issue.unassigned') },
          { label: t('issue.priority'), value: issue.priority, ...(urgent ? { tone: 'warning' as const } : {}) },
          { label: t('issue.done'), value: `${issue.doneRatio}%` }
        ]}
      />

      {read(statuses).length > 0 ? (
        <Select
          label={t('issue.status')}
          value={String(issue.statusId)}
          options={read(statuses).map((s) => ({ value: String(s.id), label: s.name }))}
          disabled={disabled}
          onChange={(v) => changeStatus(issue, v)}
        />
      ) : null}

      {read(located) ? (
        isWorkspaceTask ? (
          <Row justify="between" align="center" gap="xs">
            <Badge tone="success">{t('issue.isWorkspaceTask')}</Badge>
            <Button size="sm" variant="ghost" onPress={() => assignIssue(null)}>
              {t('issue.unassign')}
            </Button>
          </Row>
        ) : (
          <Button variant="outline" icon="link" onPress={() => assignIssue(issue)}>
            {assigned ? t('issue.assignReplacing', { id: assigned.id }) : t('issue.assign')}
          </Button>
        )
      ) : null}

      <Separator />
      <Stack gap="xs">
        <SectionHeader title={t('section.agent')} />
        {read(redmineCli) === null ? (
          <Text muted size="xs">
            {t('agent.noCli')}
          </Text>
        ) : null}
        <LaunchSection issue={issue} />
        <HereSection issue={issue} />
        <Collapsible title={t('send.title')} description={t('send.subtitle')}>
          <Stack gap="sm">
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
            <Button icon="agent" disabled={disabled || !ws?.terminals.length} onPress={() => sendToAgent(issue)}>
              {t('send.submit')}
            </Button>
          </Stack>
        </Collapsible>
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
      {status?.configured ? (
        <Row justify="between" align="center">
          <Row gap="xs" align="center">
            <Text size="sm" weight="semibold">
              {t('header.title')}
            </Text>
            {status.user ? (
              <Text size="sm" muted truncate>
                {status.user.name || status.user.login}
              </Text>
            ) : null}
          </Row>
          <Row gap="none" align="center">
            <IconButton
              icon="refresh"
              size="sm"
              variant="ghost"
              label={t('header.reload')}
              onPress={() => (current ? openIssue(current.id) : loadIssues())}
            />
            <IconButton
              key="connection"
              icon="plug"
              size="sm"
              label={t('header.connection')}
              variant="ghost"
              onPress={() => update(confirmingDisconnect, (open) => !open)}
            />
          </Row>
        </Row>
      ) : null}
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
