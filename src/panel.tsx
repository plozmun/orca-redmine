// "Redmine" sidebar panel: connection, task list, task detail and actions.
// No network and no hooks: everything goes through the worker (plugin.request) and state lives in
// atoms. Every visible string goes through `t()`, in Orca's UI language (src/i18n).
import {
  atom,
  Badge,
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
  set,
  settings,
  shell,
  Spinner,
  Stack,
  Switch,
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
import { issueIdFromBranch, type IssueDetail, type IssueStatus, type IssueSummary, type Project } from './redmine'

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

// Kept across panel runs.
const search = atom('redmine.search', '', { persist: 'plugin' })
const onlyMine = atom('redmine.onlyMine', true, { persist: 'plugin' })

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

async function openIssue(id: number): Promise<void> {
  await run(async () => {
    const issue = await plugin.request('redmine.issue', { id })
    if (read(detail)?.id !== id) {
      set(launchInstructions, defaultInstructions(issue, env.locale, read(instructionsTemplate)))
      set(launchComments, read(defaultComments))
      set(launchProject, suggestedOrcaProject(issue))
      set(launchBase, '')
    }
    set(detail, issue)
  })
}

const connect = () =>
  run(async () => {
    await afterConnect(await plugin.request('redmine.configure', { url: read(formUrl), apiKey: read(formKey) }))
    set(formKey, '')
  })

const disconnect = () =>
  run(async () => {
    set(detail, null)
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
  if (read(connection)?.configured) await loadIssues()
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
  onChange: (value: string | null) => void
}

/**
 * A dropdown with a search box, built from Orca components (the components `Select` cannot search).
 * Closed: a button with the current value. Open: a search field and the first matches; choosing one,
 * or pressing Enter for the first match, closes it.
 */
function SearchPicker(props: PickerProps) {
  const { id, state, label, value, options, noneLabel, clearLabel, placeholder, onChange } = props
  const close = () => {
    set(state.open, false)
    set(state.filter, '')
  }
  const choose = (next: string | null) => {
    close()
    onChange(next)
  }
  const current = options.find((o) => o.value === value)

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

function ProjectPicker({ label }: { label: string }) {
  return (
    <SearchPicker
      id="redmine-project"
      state={redmineProjectPicker}
      label={label}
      value={currentProject()}
      options={read(projects).map((p) => ({ value: p.identifier, label: p.name }))}
      noneLabel={t('projects.all')}
      clearLabel={t('projects.clear')}
      onChange={(v) => chooseProject(v ?? ALL)}
    />
  )
}

function WorkspaceCard() {
  const ws = read(workspace)
  const loc = read(located)
  if (!ws) {
    return (
      <Text muted size="sm">
        {t('workspace.none')}
      </Text>
    )
  }
  const assigned = assignedIssue()
  const suggested = ws.issueId && ws.issueId !== assigned?.id ? ws.issueId : null
  const reason = read(locateError)
  return (
    <Card
      title={ws.displayName}
      description={
        loc?.orcaProjectName
          ? t('workspace.orcaProject', { name: loc.orcaProjectName })
          : reason
            ? t('workspace.orcaProjectUnknownReason', { reason })
            : t('workspace.orcaProjectUnknown')
      }
    >
      <Stack gap="sm">
        {loc?.orcaProjectId && read(projects).length > 0 ? (
          <ProjectPicker label={t('workspace.redmineProjectFor', { name: loc.orcaProjectName ?? '' })} />
        ) : null}
        {loc ? (
          assigned ? (
            <Row justify="between" gap="xs">
              <Text size="sm" truncate>
                <Link onPress={() => openIssue(assigned.id)}>{`#${assigned.id} ${assigned.subject}`}</Link>
              </Text>
              <IconButton icon="close" label={t('workspace.unassignTask')} variant="ghost" onPress={() => assignIssue(null)} />
            </Row>
          ) : (
            <Text muted size="sm">
              {t('workspace.noTask')}
            </Text>
          )
        ) : null}
        {loc && suggested ? (
          <Button size="sm" variant="outline" icon="branch" onPress={() => assignById(suggested)}>
            {t('workspace.assignFromBranch', { id: suggested })}
          </Button>
        ) : null}
      </Stack>
    </Card>
  )
}

function IssueList() {
  const assigned = assignedIssue()
  const list = read(issues)
  return (
    <Stack gap="sm">
      <WorkspaceCard />
      <Input
        label={t('list.search')}
        labelHidden
        type="search"
        placeholder={t('list.searchPlaceholder')}
        value={read(search)}
        onChange={(v) => set(search, v)}
        onSubmit={() => loadIssues()}
      />
      <Switch
        label={t('list.onlyMine')}
        checked={read(onlyMine)}
        onChange={(v) => {
          set(onlyMine, v)
          void loadIssues()
        }}
      />
      {read(loading) ? (
        <Spinner label={t('list.loading')} />
      ) : list.length === 0 ? (
        <EmptyState icon="check" title={t('list.empty')} description={t('list.emptyHint')} />
      ) : (
        <List label={t('list.count', { shown: list.length, total: read(total) })}>
          {list.map((issue) => (
            <ListItem
              title={`#${issue.id} ${issue.subject}`}
              description={`${issue.project} · ${issue.status} · ${issue.priority}`}
              icon={/bug|error/i.test(issue.tracker) ? 'bug' : 'file-text'}
              current={issue.id === assigned?.id}
              onPress={() => openIssue(issue.id)}
            />
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

function IssueView({ issue }: { issue: IssueDetail }) {
  const ws = read(workspace)
  const disabled = read(busy)
  const assigned = assignedIssue()
  return (
    <Stack gap="md">
      <Row justify="between">
        <Button variant="ghost" size="sm" onPress={() => set(detail, null)}>
          {t('issue.back')}
        </Button>
        <IconButton icon="open-external" label={t('issue.openInRedmine')} onPress={() => shell.openExternal(issue.url)} />
      </Row>
      <Heading level={2}>{`#${issue.id} ${issue.subject}`}</Heading>
      <Row gap="xs" wrap>
        <Badge>{issue.tracker}</Badge>
        <Badge tone="accent">{issue.status}</Badge>
        <Badge tone={/urgent|immediate|inmediat|alta|high/i.test(issue.priority) ? 'warning' : 'neutral'}>
          {issue.priority}
        </Badge>
        <Badge>{`${issue.doneRatio}%`}</Badge>
      </Row>
      {read(located) ? (
        assigned?.id === issue.id ? (
          <Row gap="xs">
            <Badge tone="success">{t('issue.isWorkspaceTask')}</Badge>
            <Button size="sm" variant="ghost" onPress={() => assignIssue(null)}>
              {t('issue.unassign')}
            </Button>
          </Row>
        ) : (
          <Button size="sm" variant="outline" icon="link" onPress={() => assignIssue(issue)}>
            {assigned ? t('issue.assignReplacing', { id: assigned.id }) : t('issue.assign')}
          </Button>
        )
      ) : null}
      <Text muted size="xs">
        {`${issue.project} · ${issue.assignee ?? t('issue.unassigned')} · ${t('issue.updated')} `}
        <RelativeTime at={Date.parse(issue.updatedOn) || Date.now()} />
      </Text>

      {read(statuses).length > 0 ? (
        <Select
          label={t('issue.status')}
          value={String(issue.statusId)}
          options={read(statuses).map((s) => ({ value: String(s.id), label: s.name }))}
          disabled={disabled}
          onChange={(v) => changeStatus(issue, v)}
        />
      ) : null}

      <Collapsible title={t('issue.description')} defaultOpen>
        {issue.description ? <Markdown content={issue.description} /> : <Text muted>{t('issue.noDescription')}</Text>}
      </Collapsible>

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

      <Collapsible title={t('time.title')}>
        <Stack gap="sm">
          <Input label={t('time.hours')} placeholder="1.5" value={read(hours)} onChange={(v) => set(hours, v)} />
          <Input label={t('time.comment')} value={read(timeComment)} onChange={(v) => set(timeComment, v)} />
          <Button icon="calendar" disabled={disabled} onPress={() => logTime(issue)}>
            {t('time.submit')}
          </Button>
        </Stack>
      </Collapsible>

      <Collapsible title={t('comment.title')}>
        <Stack gap="sm">
          <Textarea label={t('comment.label')} labelHidden rows={3} value={read(note)} onChange={(v) => set(note, v)} />
          <Button icon="edit" disabled={disabled} onPress={() => addNote(issue)}>
            {t('comment.submit')}
          </Button>
        </Stack>
      </Collapsible>

      <Collapsible title={t('issue.history', { count: issue.journals.length })}>
        {issue.journals.length === 0 ? (
          <Text muted>{t('issue.noComments')}</Text>
        ) : (
          <Stack gap="sm">
            {issue.journals.map((j) => (
              <Stack gap="xs">
                <Text size="xs" weight="medium">
                  {`${j.author} · `}
                  <RelativeTime at={Date.parse(j.createdOn) || Date.now()} />
                </Text>
                <Markdown content={j.notes} />
              </Stack>
            ))}
          </Stack>
        )}
      </Collapsible>
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
        <Row justify="between">
          <Row gap="xs">
            <Heading>{t('header.title')}</Heading>
            {status.user ? <Badge>{status.user.name || status.user.login}</Badge> : null}
          </Row>
          <Row gap="xs">
            <IconButton
              icon="refresh"
              label={t('header.reload')}
              onPress={() => (current ? openIssue(current.id) : loadIssues())}
            />
            <IconButton icon="close" label={t('header.disconnect')} variant="ghost" onPress={disconnect} />
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
      ) : (
        <IssueList />
      )}
    </Stack>
  )
}
