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
import { issueIdFromBranch, type IssueDetail, type IssueStatus, type IssueSummary, type Project, type TimeEntry } from './redmine'

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

interface AssignedIssue {
  id: number
  subject: string
}

const connection = atom<ConnectionStatus | null>(null)
const issues = atom<IssueSummary[]>([])
const total = atom(0)
const loading = atom(false)
const error = atom<string | null>(null)
const notice = atom<string | null>(null)
const statuses = atom<IssueStatus[]>([])
const projects = atom<Project[]>([])
const detail = atom<IssueDetail | null>(null)
const workspace = atom<WorkspaceInfo | null>(null)
const busy = atom(false)
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

// Kept across panel runs.
const search = atom('redmine.search', '', { persist: 'plugin' })
const onlyMine = atom('redmine.onlyMine', true, { persist: 'plugin' })
/** Status filter for the list: `open` (default), `closed`, `*` or a status id. */
const statusFilter = atom('redmine.statusFilter', 'open', { persist: 'plugin' })

// The Redmine project is set per Orca project (repository) and shared by all its workspaces; the
// task is set per workspace (stable worktree id). Nothing is inherited from another workspace.
const ALL = '*'
const projectByOrcaProject = atom<Record<string, string>>('redmine.projectByOrcaProject', {}, { persist: 'plugin' })
const issueByWorkspace = atom<Record<string, AssignedIssue>>('redmine.issueByWorkspace', {}, { persist: 'plugin' })
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
  // Fires once on subscribe, then whenever the focused workspace or its terminals change.
  ctx.subscriptions.push(
    on('workspace.changed', ({ context }) => {
      const previous = read(workspace)
      if (!context) {
        set(workspace, null)
        if (previous) void locate(null)
        return
      }
      const info = { ...context, issueId: issueIdFromBranch(context.branch) }
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
  void loadSettings()
  ctx.subscriptions.push(
    settings.onDidChange(({ key }) => {
      void loadSettings()
      // The URL changed in Settings: check the connection again with the stored API key.
      if (key === 'url') void plugin.request('redmine.status').then(afterConnect, (e) => set(error, errorText(e)))
    })
  )
  void plugin.request('redmine.status').then(afterConnect, (e) => set(error, errorText(e)))
}

function ConnectForm() {
  const status = read(connection)
  return (
    <Stack gap="md">
      <Heading>{t('connect.title')}</Heading>
      <Text muted size="sm">
        {t('connect.help')}
      </Text>
      {status?.errorCode ? (
        <Callout tone="danger" title={t('connect.failed')}>
          <Text>{translateErrorCode(env.locale, status.errorCode, status.errorDetail ?? '') ?? status.errorDetail ?? ''}</Text>
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
          <Text size="sm" truncate>
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
        {items.length > 0 ? <List label={label}>{items}</List> : <Text muted size="sm">{t('picker.empty')}</Text>}
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
      {!loc && read(projects).length > 0 ? (
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

/** One task as a small card: number and state, the subject on its own lines, then the details. */
function IssueRow({ issue, assigned, showProject }: { issue: IssueSummary; assigned: boolean; showProject: boolean }) {
  const meta = [issue.priority, issue.assignee ?? t('issue.unassigned'), ...(showProject ? [issue.project] : [])]
  return (
    <ListItem key={`issue-${issue.id}`} current={assigned} onPress={() => openIssue(issue.id)}>
      <Stack gap="xs">
        <Row justify="between" align="center" gap="xs">
          <Text size="xs" muted truncate>
            {`#${issue.id} · ${issue.tracker}`}
          </Text>
          <Badge tone={statusTone(issue.status)}>{issue.status}</Badge>
        </Row>
        <Text size="sm" weight="medium">
          {issue.subject}
        </Text>
        <Text size="xs" muted truncate>
          {meta.join(' · ')}
        </Text>
      </Stack>
    </ListItem>
  )
}

function IssueList() {
  const assigned = assignedIssue()
  const list = read(issues)
  const filtered = currentProject() !== null
  return (
    <Stack gap="sm">
      <WorkspaceBar />
      <StatusPicker />
      <Input
        label={t('list.search')}
        labelHidden
        type="search"
        placeholder={t('list.searchPlaceholder')}
        value={read(search)}
        onChange={(v) => set(search, v)}
        onSubmit={() => loadIssues()}
      />
      <Row justify="between" align="center" gap="xs">
        <SectionHeader
          title={t('section.tasks')}
          count={read(loading) ? undefined : list.length < read(total) ? `${list.length}/${read(total)}` : list.length}
        />
        <Switch
          label={t('list.onlyMine')}
          checked={read(onlyMine)}
          onChange={(v) => {
            set(onlyMine, v)
            void loadIssues()
          }}
        />
      </Row>
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
            <IssueRow issue={issue} assigned={issue.id === assigned?.id} showProject={!filtered} />
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
        <Text muted size="sm">
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
          <Text muted size="sm">
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
        <Text muted size="sm">
          {failed}
        </Text>
      ) : entries.length === 0 ? (
        <Text muted size="sm">
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
  const urgent = /urgent|immediate|inmediat|alta|high/i.test(issue.priority)
  return (
    <Stack gap="md">
      {/* Header, like Orca's Checks panel: number and state, title, then a muted meta line. */}
      <Stack gap="xs">
        <Row justify="between" align="center">
          <Row gap="xs" align="center">
            <Button variant="ghost" size="sm" onPress={closeIssue}>
              {t('issue.back')}
            </Button>
            <Text size="sm" weight="semibold">{`#${issue.id}`}</Text>
            <Badge tone="accent">{issue.status}</Badge>
          </Row>
          <IconButton
            icon="open-external"
            size="sm"
            variant="ghost"
            label={t('issue.openInRedmine')}
            onPress={() => shell.openExternal(issue.url)}
          />
        </Row>
        <Text weight="medium">{issue.subject}</Text>
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
        <LaunchSection issue={issue} />
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
              <Text muted size="sm">
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
            <Text muted size="sm">
              {t('issue.noDescription')}
            </Text>
          )}
        </Tab>

        <Tab value="activity" label={t('tabs.activity', { count: issue.journals.length })} icon="activity">
          <Stack gap="sm">
            {issue.journals.length === 0 ? (
              <Text muted size="sm">
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
            <IconButton icon="close" size="sm" label={t('header.disconnect')} variant="ghost" onPress={disconnect} />
          </Row>
        </Row>
      ) : null}
      {err ? (
        <Callout tone="danger" icon="error">
          <Text>{err}</Text>
        </Callout>
      ) : null}
      {info ? (
        <Callout tone="success" icon="check">
          <Text>{info}</Text>
        </Callout>
      ) : null}
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
