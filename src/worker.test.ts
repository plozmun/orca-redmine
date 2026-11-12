// Runs src/worker.ts's activate(orca) over a mock host, with `fetch` and the Orca CLI stubbed.
import { afterEach, assert, mockHost, mountWorker, test } from 'orca/testing'
import { systemLocale, translate } from './i18n'
import { runOrcaJson } from './orca-workspaces'
import { resetRedmineCaches } from './redmine'
import * as main from './worker'

const realFetch = globalThis.fetch
/** Set by the status bar tests' fake interval timers, restored after each test. */
let stopFakeTimers: (() => void) | null = null

function stubFetch(routes: Record<string, unknown>) {
  const calls: { url: string; method: string; body?: string }[] = []
  globalThis.fetch = (async (url: string, init: { method: string; body?: string }) => {
    calls.push({ url, method: init.method, body: init.body })
    const key = Object.keys(routes).find((k) => url.includes(k))
    const body = key ? routes[key] : undefined
    return { ok: Boolean(key), status: key ? 200 : 404, text: async () => (body ? JSON.stringify(body) : '') }
  }) as unknown as typeof fetch
  return calls
}

afterEach(() => {
  globalThis.fetch = realFetch
  resetRedmineCaches()
  stopFakeTimers?.()
  stopFakeTimers = null
  main.setOrcaRunner((args) => runOrcaJson(args))
})

const configured = {
  // The status bar is off here so the count refresh does not interleave with these requests;
  // its own tests below turn it on.
  settings: { url: 'https://redmine.test', limit: 50, statusBar: false },
  secrets: { apiKey: 'KEY' }
}
const issue = {
  id: 77,
  subject: 'Checkout screen',
  project: { id: 1, name: 'Shop' },
  tracker: { name: 'Feature' },
  status: { id: 1, name: 'New' },
  priority: { name: 'Normal' },
  updated_on: '2026-11-01T00:00:00Z',
  journals: []
}

test('not configured answers configured=false', async () => {
  const worker = await mountWorker(main, { host: mockHost() })
  assert.deepEqual(await worker.request('redmine.status'), { configured: false, url: null, user: null })
  await worker.deactivate()
})

test('a saved configuration that fails reports an error code', async () => {
  stubFetch({})
  const worker = await mountWorker(main, { host: mockHost(configured) })
  const status = await worker.request('redmine.status')
  assert.equal(status.configured, false)
  assert.equal(status.errorCode, 'not_found')
  await worker.deactivate()
})

test('configure validates the key and stores it encrypted', async () => {
  stubFetch({ '/users/current.json': { user: { id: 1, login: 'pablo', firstname: 'Pablo', lastname: 'L' } } })
  const host = mockHost()
  const worker = await mountWorker(main, { host })
  const status = await worker.request('redmine.configure', { url: 'https://redmine.test/', apiKey: ' KEY ' })
  assert.equal(status.configured, true)
  assert.equal(status.user?.name, 'Pablo L')
  assert.equal(host.data().settings.url, 'https://redmine.test')
  assert.equal(host.data().secrets.apiKey, 'KEY')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('lists issues and notifies panels after logging time', async () => {
  const calls = stubFetch({
    '/issues.json': { issues: [issue], total_count: 1 },
    '/time_entries.json': { time_entry: { id: 9 } }
  })
  const worker = await mountWorker(main, { host: mockHost(configured) })
  const list = await worker.request('redmine.issues', { mine: true })
  assert.equal(list.issues[0].subject, 'Checkout screen')
  assert.deepEqual(await worker.request('redmine.logTime', { id: 77, hours: 1.5, comments: 'review' }), { timeEntryId: 9 })
  assert.deepEqual(JSON.parse(calls.at(-1)!.body!), { time_entry: { issue_id: 77, hours: 1.5, comments: 'review' } })
  assert.deepEqual(worker.posts, [{ event: 'redmine.issueChanged', payload: { id: 77 } }])
  await assert.rejects(worker.request('redmine.logTime', { id: 77, hours: 30, comments: '' }), (e: { code: string }) => e.code === 'invalid_hours')
  await worker.deactivate()
})

test('types the task prompt into the terminal in the panel language, without Enter, with the context in a file', async () => {
  const { mkdtemp, readFile, stat } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'redmine-test-'))
  main.setContextDir(dir)
  main.setRedmineCliDetector(async () => null)
  stubFetch({ '/issues/77.json': { issue: { ...issue, description: 'Integrate payments' } } })
  const host = mockHost({ ...configured, results: { 'terminal.sendText': { accepted: true } } })
  const worker = await mountWorker(main, { host })
  assert.deepEqual(await worker.request('redmine.sendToAgent', { id: 77, terminalId: 't1', locale: 'es' }), { accepted: true })
  const [params] = host.callsOf('terminal.sendText') as { terminalId: string; text: string; enter: boolean }[]
  assert.equal(params.terminalId, 't1')
  assert.equal(params.enter, false)
  const file = join(dir, '77.md')
  assert.match(params.text, /^Trabaja en la tarea de Redmine #77 "Checkout screen"/)
  assert.ok(params.text.includes(`en ${file}`))
  assert.ok(!params.text.includes('redmine` CLI') && !params.text.includes('CLI `redmine`'))
  const context = await readFile(file, 'utf8')
  assert.ok(context.includes('--- BEGIN LINKED WORK ITEM CONTEXT ---'))
  assert.ok(context.includes('Integrate payments'))
  assert.equal((await stat(file)).mode & 0o777, 0o600)

  main.setRedmineCliDetector(async () => 'redmine version 2.14.0')
  await worker.request('redmine.sendToAgent', { id: 77, terminalId: 't1', locale: 'en' })
  const second = (host.callsOf('terminal.sendText') as { text: string }[])[1]
  assert.ok(second.text.includes('The `redmine` CLI is available to read or update task #77.'))
  assert.deepEqual(await worker.request('redmine.cli'), { version: 'redmine version 2.14.0' })
  main.setContextDir(undefined)
  await worker.deactivate()
})

test('palette command lists my tasks', async () => {
  stubFetch({ '/issues.json': { issues: [issue], total_count: 1 } })
  const worker = await mountWorker(main, { host: mockHost(configured), commands: ['redmine.myIssues', 'redmine.openPanel'] })
  const text = await worker.command('redmine.myIssues')
  assert.match(String(text), /#77 \[New\] Checkout screen \(Shop\)/)
  await worker.deactivate()
})

test('locates the focused workspace among Orca worktrees', async () => {
  main.setOrcaLister(async () => ({
    projects: [{ id: 'git:x/shop', displayName: 'shop' }],
    worktrees: [{ id: 'r::/p', identity: { key: 'wt-1' }, projectId: 'git:x/shop', displayName: 'pay', branch: 'refs/heads/feature/1-pay' }]
  }))
  const worker = await mountWorker(main, { host: mockHost() })
  assert.deepEqual(await worker.request('redmine.locateWorkspace', { displayName: 'pay', branch: 'feature/1-pay' }), {
    located: { workspaceKey: 'wt-1', orcaProjectId: 'git:x/shop', orcaProjectName: 'shop' }
  })
  assert.deepEqual(await worker.request('redmine.locateWorkspace', { displayName: 'other', branch: 'main' }), {
    located: null,
    errorCode: 'workspace_not_listed',
    errorDetail: 'other'
  })
  main.setOrcaLister(async () => {
    throw Object.assign(new Error('spawn orca ENOENT'), { code: 'orca_cli' })
  })
  assert.deepEqual(await worker.request('redmine.locateWorkspace', { displayName: 'pay', branch: 'x' }), {
    located: null,
    errorCode: 'orca_cli',
    errorDetail: 'spawn orca ENOENT'
  })
  await worker.deactivate()
})

test('creates the workspace with the task name and prompt', async () => {
  stubFetch({ '/issues/77.json': { issue: { ...issue, description: 'Integrate payments' } } })
  const seen: unknown[] = []
  main.setOrcaCreator(async (options) => {
    seen.push(options)
    return { workspaceKey: 'wt-new', displayName: '77-checkout-screen', branch: 'pablo/77-checkout-screen', path: '/p', launch: 'terminal' }
  })
  main.setRedmineCliDetector(async () => null)
  const worker = await mountWorker(main, { host: mockHost(configured) })
  const created = await worker.request('redmine.launchWorkspace', {
    issueId: 77,
    orcaProjectId: 'git:x/shop',
    agent: 'claude',
    instructions: 'Do it',
    activate: true,
    locale: 'en'
  })
  assert.equal(created.workspaceKey, 'wt-new')
  assert.equal(created.name, '77-checkout-screen')
  const options = seen[0] as { prompt: string; comment: string; orcaProjectId: string; agent: string }
  assert.equal(options.orcaProjectId, 'git:x/shop')
  assert.equal(options.agent, 'claude')
  assert.equal(options.comment, 'Redmine #77: Checkout screen')
  assert.ok(options.prompt.startsWith('Do it\n'))
  assert.ok(options.prompt.includes('Integrate payments'))
  assert.ok(!options.prompt.includes('CLI'))
  await worker.deactivate()
})


test('launch uses the contextComments and contextMaxChars settings unless the panel overrides them', async () => {
  const journals = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, user: { name: 'Ana' }, notes: `Note ${i + 1}`, created_on: '2026-10-01' }))
  stubFetch({ '/issues/77.json': { issue: { ...issue, journals } } })
  const prompts: string[] = []
  main.setOrcaCreator(async (options) => {
    prompts.push(options.prompt)
    return { workspaceKey: null, displayName: null, branch: null, path: null, launch: null }
  })
  const host = mockHost({ ...configured, settings: { ...configured.settings, contextComments: 'all', contextMaxChars: 20000 } })
  const worker = await mountWorker(main, { host })
  const input = { issueId: 77, orcaProjectId: 'p', agent: 'claude', instructions: 'Go', activate: false, locale: 'en' }
  await worker.request('redmine.launchWorkspace', input)
  assert.ok(prompts[0].includes('Note 1') && prompts[0].includes('Note 7'))
  await worker.request('redmine.launchWorkspace', { ...input, comments: 'none' })
  assert.ok(!prompts[1].includes('Note'))
  await worker.deactivate()
})

test('send to agent uses the sendPrompt setting template', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'redmine-test-'))
  main.setContextDir(dir)
  main.setRedmineCliDetector(async () => null)
  stubFetch({ '/issues/77.json': { issue } })
  const host = mockHost({
    ...configured,
    settings: { ...configured.settings, sendPrompt: 'Take #{id}:\n{subject}' },
    results: { 'terminal.sendText': { accepted: true } }
  })
  const worker = await mountWorker(main, { host })
  await worker.request('redmine.sendToAgent', { id: 77, terminalId: 't1', locale: 'en' })
  const [params] = host.callsOf('terminal.sendText') as { text: string }[]
  assert.equal(params.text, `Take #77: Checkout screen Read its description and comments in ${join(dir, '77.md')} first.`)
  main.setContextDir(undefined)
  await worker.deactivate()
})

test('the API key never reaches logs, errors, prompts, terminals or context files', async () => {
  const KEY = 'secret-key-3f9a1c'
  const { mkdtemp, readFile, readdir } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'redmine-key-test-'))
  main.setContextDir(dir)
  main.setRedmineCliDetector(async () => 'redmine 1.0')
  main.setOrcaLister(async () => {
    throw Object.assign(new Error('spawn orca ENOENT'), { code: 'orca_cli' })
  })
  const prompts: string[] = []
  main.setOrcaCreator(async (options) => {
    prompts.push(options.prompt, options.comment ?? '')
    throw Object.assign(new Error('orca worktree create failed'), { code: 'orca_cli' })
  })

  // Every Redmine answer the client maps to an error, plus a network failure and success.
  let mode: number | 'throw' | 'ok' = 'ok'
  globalThis.fetch = (async (url: string) => {
    if (mode === 'throw') throw new Error(`connect ECONNREFUSED ${url}`)
    if (mode === 'ok') {
      const body = url.includes('/issues/77.json')
        ? { issue: { ...issue, description: 'Pay', journals: [{ id: 1, user: { name: 'Ana' }, notes: 'Hi', created_on: '2026-10-01' }] } }
        : url.includes('/issues.json')
          ? { issues: [issue], total_count: 1 }
          : { user: { id: 1, login: 'pablo', firstname: 'P', lastname: 'L' } }
      return { ok: true, status: 200, text: async () => JSON.stringify(body) }
    }
    return { ok: false, status: mode, text: async () => JSON.stringify({ errors: ['Status is invalid'] }) }
  }) as unknown as typeof fetch

  const host = mockHost({
    settings: { url: 'https://redmine.test', limit: 50 },
    secrets: { apiKey: KEY },
    results: { 'terminal.sendText': { accepted: true } }
  })
  const worker = await mountWorker(main, { host })
  const seen: unknown[] = []
  const call = async (run: () => Promise<unknown>) => {
    try {
      seen.push(await run())
    } catch (error) {
      seen.push({ message: (error as Error).message, code: (error as { code?: string }).code })
    }
  }
  const requests = async () => {
    await call(() => worker.request('redmine.status'))
    await call(() => worker.request('redmine.issues', { mine: true }))
    await call(() => worker.request('redmine.issue', { id: 77 }))
    await call(() => worker.request('redmine.setStatus', { id: 77, statusId: 2 }))
    await call(() => worker.request('redmine.comment', { id: 77, notes: 'x' }))
    await call(() => worker.request('redmine.logTime', { id: 77, hours: 1, comments: '' }))
    await call(() => worker.command('redmine.myIssues'))
  }
  for (const m of [401, 403, 404, 422, 500, 'throw', 'ok'] as const) {
    mode = m
    await requests()
  }
  await call(() => worker.request('redmine.configure', { url: 'not a url', apiKey: KEY }))
  await call(() => worker.request('redmine.locateWorkspace', { displayName: 'pay', branch: 'main' }))
  await call(() =>
    worker.request('redmine.launchWorkspace', { issueId: 77, orcaProjectId: 'p', agent: 'claude', instructions: 'Go', activate: false, locale: 'en' })
  )
  await call(() => worker.request('redmine.sendToAgent', { id: 77, terminalId: 't1', locale: 'en' }))

  const files = await Promise.all((await readdir(dir)).map((f) => readFile(join(dir, f), 'utf8')))
  assert.ok(files.length > 0 && prompts.length > 0 && worker.logs.length > 0, 'the paths under test ran')
  const everything = JSON.stringify({
    logs: worker.logs,
    seen,
    posts: worker.posts,
    prompts,
    files,
    sent: host.callsOf('terminal.sendText'),
    settings: host.data().settings
  })
  assert.ok(!everything.includes(KEY), 'the API key leaked')
  main.setContextDir(undefined)
  await worker.deactivate()
})

test('locate takes the key from the host and only the Orca project from the CLI', async () => {
  const hostListing = {
    workspaces: [
      { id: 'identity:wt-1', kind: 'worktree', name: 'pay', path: '/p', branch: 'feature/1-pay', hostId: 'local' },
      { id: 'identity:wt-2', kind: 'worktree', name: 'fresh', path: '/f', branch: 'feature/2-fresh', hostId: 'local' }
    ],
    truncated: false
  }
  const cliListing = {
    projects: [{ id: 'git:x/shop', displayName: 'shop' }],
    worktrees: [{ id: 'r::/p', identity: { key: 'wt-1' }, projectId: 'git:x/shop', displayName: 'pay', branch: 'refs/heads/feature/1-pay' }]
  }
  let cli: () => Promise<OrcaListingLike> = async () => cliListing
  main.setOrcaLister(() => cli())
  const host = mockHost({ capabilities: ['workspace:read'], results: { 'workspace.list': hostListing } })
  const worker = await mountWorker(main, { host })
  const locate = (displayName: string, branch: string) => worker.request('redmine.locateWorkspace', { displayName, branch })

  assert.deepEqual(await locate('pay', 'feature/1-pay'), {
    located: { workspaceKey: 'wt-1', orcaProjectId: 'git:x/shop', orcaProjectName: 'shop' }
  })
  // Known to the host, not (yet) to the CLI: the key still links the task.
  assert.deepEqual(await locate('fresh', 'feature/2-fresh'), {
    located: { workspaceKey: 'wt-2', orcaProjectId: null, orcaProjectName: null },
    errorCode: 'workspace_not_listed',
    errorDetail: 'fresh'
  })
  // CLI missing: same key, project unknown with the reason.
  cli = async () => {
    throw Object.assign(new Error('spawn orca ENOENT'), { code: 'orca_cli' })
  }
  assert.deepEqual(await locate('pay', 'feature/1-pay'), {
    located: { workspaceKey: 'wt-1', orcaProjectId: null, orcaProjectName: null },
    errorCode: 'orca_cli',
    errorDetail: 'spawn orca ENOENT'
  })
  // Not in the host listing: the CLI decides, as before.
  cli = async () => cliListing
  assert.deepEqual(await locate('other', 'main'), { located: null, errorCode: 'workspace_not_listed', errorDetail: 'other' })
  await worker.deactivate()
})

test('locate falls back to the CLI when the host refuses workspace.list', async () => {
  main.setOrcaLister(async () => ({
    projects: [],
    worktrees: [{ id: 'r::/p', identity: { key: 'wt-1' }, projectId: null, displayName: 'pay', branch: 'main' }]
  }))
  const worker = await mountWorker(main, { host: mockHost({ capabilities: [] }) })
  assert.deepEqual(await worker.request('redmine.locateWorkspace', { displayName: 'pay', branch: 'main' }), {
    located: { workspaceKey: 'wt-1', orcaProjectId: null, orcaProjectName: null }
  })
  assert.ok(worker.logs.some((l) => l.startsWith('workspace.list:')))
  await worker.deactivate()
})

type OrcaListingLike = Awaited<ReturnType<Parameters<typeof main.setOrcaLister>[0]>>

// --- Workspace creation: branch convention, automatic link, optional task update ---

const task4077 = {
  ...issue,
  id: 4077,
  subject: 'Checkout with saved cards',
  tracker: { name: 'Feature' },
  project: { id: 2, name: 'iOS' },
  status: { id: 1, name: 'New' }
}

/** Redmine with task 4077 in project 2 (`ios`, child of `client`), recording writes. */
function redmineWith4077(delayMs = 0) {
  const writes: { url: string; method: string; body?: unknown }[] = []
  globalThis.fetch = (async (url: string, init: { method: string; body?: string }) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    if (init.method !== 'GET') {
      writes.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined })
      return { ok: true, status: 204, text: async () => '' }
    }
    const routes: Record<string, unknown> = {
      '/issues/4077.json': { issue: task4077 },
      '/issue_statuses.json': {
        issue_statuses: [
          { id: 1, name: 'New', is_closed: false },
          { id: 2, name: 'In progress', is_closed: false },
          { id: 5, name: 'Closed', is_closed: true }
        ]
      },
      '/projects.json': {
        projects: [
          { id: 1, identifier: 'client', name: 'Client', status: 1 },
          { id: 2, identifier: 'ios', name: 'iOS', parent: { id: 1 }, status: 1 },
          { id: 3, identifier: 'web', name: 'Web', status: 1 }
        ],
        total_count: 3
      }
    }
    const key = Object.keys(routes).find((k) => url.includes(k))
    return { ok: Boolean(key), status: key ? 200 : 404, text: async () => (key ? JSON.stringify(routes[key]) : '') }
  }) as unknown as typeof fetch
  return writes
}

const creation = { kind: 'worktree' as const, projectId: 'git:x/shop', name: '4077 checkout', branch: 'pablo/4077-checkout' }

test('workspace.create.before applies the branch template to a task workspace', async () => {
  redmineWith4077()
  const host = mockHost({ ...configured, settings: { ...configured.settings, branchTemplate: '{tracker}/{id}-{slug}' } })
  const worker = await mountWorker(main, { host })
  const decision = (await worker.hooks.fire('workspace.create.before', creation)) as { event?: unknown }
  assert.deepEqual(decision.event, { ...creation, branch: 'feature/4077-checkout-with-saved-cards' })
  await worker.deactivate()
})

test('workspace.create.before passes without a template, a task, Redmine or in time', async () => {
  const fire = async (settings: Record<string, unknown>, event = creation, delayMs = 0) => {
    redmineWith4077(delayMs)
    const worker = await mountWorker(main, { host: mockHost({ ...configured, settings: { ...configured.settings, ...settings } }) })
    const decision = await worker.hooks.fire('workspace.create.before', event)
    await worker.deactivate()
    return decision
  }
  const template = { branchTemplate: '{id}-{slug}' }
  // Passing: no refusal, and the event (if any) keeps Orca's branch.
  const passed = (d: unknown) => {
    const decision = (d ?? {}) as { deny?: string; event?: { branch?: string } }
    return !decision.deny && (decision.event?.branch ?? creation.branch) !== 'feature/4077-checkout-with-saved-cards' && !decision.event?.branch?.includes('saved')
  }
  assert.ok(passed(await fire({})))
  assert.ok(passed(await fire(template, { ...creation, name: 'login', branch: 'main' })))
  assert.ok(passed(await fire(template, { ...creation, name: '9999-x', branch: undefined as never })))
  assert.ok(passed(await fire(template, { ...creation, kind: 'folder' })))
  assert.ok(passed(await fire(template, creation, 1800)))
})

type Linked = Record<string, { id: number; subject: string }>
const created = (name: string, extra: Partial<{ kind: 'worktree' | 'folder'; branch: string; workspaceId: string }> = {}) => ({
  workspaceId: extra.workspaceId ?? `identity:wt-${name}`,
  kind: extra.kind ?? ('worktree' as const),
  path: `/repos/shop/${name}`,
  branch: extra.branch ?? `refs/heads/pablo/${name}`
})

async function createdWorker(options: { settings?: Record<string, unknown>; storage?: Record<string, unknown>; orcaProject?: string | null } = {}) {
  const writes = redmineWith4077()
  main.setOrcaLister(async () => ({
    projects: [],
    worktrees:
      options.orcaProject === null
        ? []
        : [{ id: 'r::/repos/shop/4081-ios-pass', identity: { key: 'wt-4081-ios-pass' }, projectId: options.orcaProject ?? 'git:x/shop', displayName: '4081-ios-pass' },
           { id: 'r::/repos/shop/4077-checkout', identity: { key: 'wt-4077-checkout' }, projectId: options.orcaProject ?? 'git:x/shop', displayName: '4077-checkout' }]
  }))
  const host = mockHost({
    ...configured,
    settings: { ...configured.settings, ...options.settings },
    storage: options.storage as never,
    results: { 'workspace.list': { workspaces: [], truncated: false } }
  })
  const worker = await mountWorker(main, { host })
  const links = () => host.data().storage['links.issueByWorkspace'] as Linked | undefined
  return { worker, host, writes, links }
}

test('a created workspace that names a task is linked to it, and Redmine is left alone by default', async () => {
  const { worker, writes, links } = await createdWorker()
  await worker.emit('workspace.created', created('4077-checkout'))
  assert.deepEqual(links(), { 'wt-4077-checkout': { id: 4077, subject: 'Checkout with saved cards' } })
  assert.deepEqual(writes, [])
  await worker.deactivate()
})

test('no link for folders, unknown tasks, other projects or workspaces already linked elsewhere', async () => {
  let w = await createdWorker()
  await w.worker.emit('workspace.created', created('4077-checkout', { kind: 'folder' }))
  await w.worker.emit('workspace.created', created('99999-test'))
  await w.worker.emit('workspace.created', created('login', { branch: 'refs/heads/main' }))
  assert.equal(w.links(), undefined)
  await w.worker.deactivate()

  // The Orca project is mapped to `web`; task 4077 is in `ios`.
  w = await createdWorker({ storage: { 'links.projectByOrcaProject': { 'git:x/shop': 'web' } } })
  await w.worker.emit('workspace.created', created('4077-checkout'))
  assert.equal(w.links(), undefined)
  await w.worker.deactivate()

  // Mapped to the parent project: subprojects count.
  w = await createdWorker({ storage: { 'links.projectByOrcaProject': { 'git:x/shop': 'client' } } })
  await w.worker.emit('workspace.created', created('4077-checkout'))
  assert.equal(w.links()?.['wt-4077-checkout']?.id, 4077)
  await w.worker.deactivate()

  const other = { 'wt-4077-checkout': { id: 1, subject: 'Other' } }
  w = await createdWorker({ storage: { 'links.issueByWorkspace': other }, settings: { onWorkspaceCreated: 'comment' } })
  await w.worker.emit('workspace.created', created('4077-checkout'))
  assert.deepEqual(w.links(), other)
  assert.deepEqual(w.writes, [])
  await w.worker.deactivate()
})

test('onWorkspaceCreated comments once, and start moves a New task to the next open status', async () => {
  let w = await createdWorker({ settings: { onWorkspaceCreated: 'comment' } })
  await w.worker.emit('workspace.created', created('4077-checkout'))
  await w.worker.emit('workspace.created', created('4077-checkout'))
  assert.equal(w.writes.length, 1)
  assert.match(JSON.stringify(w.writes[0].body), /workspace `4077-checkout` \(branch `pablo\/4077-checkout`\)/)
  await w.worker.deactivate()

  w = await createdWorker({ settings: { onWorkspaceCreated: 'start' } })
  await w.worker.emit('workspace.created', created('4077-checkout'))
  assert.deepEqual(
    w.writes.map((x) => x.body),
    [{ issue: { notes: 'Work started in Orca workspace `4077-checkout` (branch `pablo/4077-checkout`).' } }, { issue: { status_id: 2 } }]
  )
  assert.deepEqual(w.worker.posts.at(-1), { event: 'redmine.issueChanged', payload: { id: 4077 } })
  await w.worker.deactivate()

  // Already linked to the same task (the panel's own launch): still recorded once.
  w = await createdWorker({ settings: { onWorkspaceCreated: 'comment' }, storage: { 'links.issueByWorkspace': { 'wt-4077-checkout': { id: 4077, subject: 'x' } } } })
  await w.worker.emit('workspace.created', created('4077-checkout'))
  assert.equal(w.writes.length, 1)
  await w.worker.deactivate()
})

test('the created event names the workspace by its CLI id on current Orca; the link uses the stable key', async () => {
  const { worker, links } = await createdWorker()
  // As Orca 1.4.255 sends it: `<repoId>::<path>`.
  await worker.emit('workspace.created', created('4077-checkout', { workspaceId: 'r::/repos/shop/4077-checkout' }))
  assert.deepEqual(links(), { 'wt-4077-checkout': { id: 4077, subject: 'Checkout with saved cards' } })
  await worker.deactivate()
})

test('without a stable key for the created workspace nothing is linked', async () => {
  const { worker, links } = await createdWorker({ orcaProject: null })
  await worker.emit('workspace.created', created('4077-checkout', { workspaceId: 'r::/repos/shop/4077-checkout' }))
  assert.equal(links(), undefined)
  assert.ok(worker.logs.some((l) => l.startsWith('workspace.created: no link key')))
  await worker.deactivate()
})

// --- Status bar: my open task count, its tone and what the press does ---

const priorities = {
  issue_priorities: [
    { id: 1, name: 'Low' },
    { id: 2, name: 'Normal' },
    { id: 3, name: 'High' }
  ]
}

function jsonReply(body: unknown, status = 200) {
  return { ok: status < 400, status, text: async () => (status === 204 ? '' : JSON.stringify(body)) }
}

/** Redmine answering each status bar count by its filter. `counts` is read on every request. */
function statusBarRedmine(initial: { total: number; overdue?: number; urgent?: number }) {
  const counts = { overdue: 0, urgent: 0, ...initial }
  const requests: string[] = []
  globalThis.fetch = (async (url: string) => {
    requests.push(url)
    const parsed = new URL(url)
    if (parsed.pathname === '/enumerations/issue_priorities.json') return jsonReply(priorities)
    const params = parsed.searchParams
    const which = params.get('due_date') ? 'overdue' : params.get('priority_id') ? 'urgent' : 'total'
    return jsonReply({ issues: [], total_count: counts[which] })
  }) as unknown as typeof fetch
  return { counts, requests }
}

const counted = { settings: { url: 'https://redmine.test', statusBar: true }, secrets: { apiKey: 'KEY' } }

/** The item's latest state, as Orca would draw it. */
function statusBarItem(host: { callsOf(method: string): unknown[] }) {
  return (host.callsOf('statusBar.update').at(-1) as Record<string, unknown> | undefined) ?? null
}

/** Long timers are captured instead of firing, so a test decides when the interval ticks. */
function fakeTimers() {
  const real = globalThis.setTimeout
  const scheduled: { run: () => void; ms: number }[] = []
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    if ((ms ?? 0) > 1000) {
      scheduled.push({ run: fn, ms: ms ?? 0 })
      return 0 as unknown as ReturnType<typeof setTimeout>
    }
    return real(() => fn(), ms) as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout
  stopFakeTimers = () => {
    globalThis.setTimeout = real
  }
  return scheduled
}

/** Waits for the worker's promises (they run on microtasks and 0 ms timers) to settle. */
async function waitFor(check: () => boolean, what = 'the worker to settle') {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(check(), `waited for ${what}`)
}

/** Fires the pending interval and waits for the refresh it causes. */
async function tick(host: { callsOf(method: string): unknown[] }, scheduled: { run: () => void }[]) {
  const seen = host.callsOf('statusBar.update').length
  scheduled.at(-1)!.run()
  await waitFor(() => host.callsOf('statusBar.update').length > seen, 'the interval to refresh')
}

const text = (key: Parameters<typeof translate>[1], vars: Record<string, string | number>) => translate(systemLocale(), key, vars)

test('the item shows my open task count, in the tone of what needs attention', async () => {
  resetRedmineCaches()
  const scheduled = fakeTimers()
  const redmine = statusBarRedmine({ total: 7 })
  const host = mockHost({ ...counted, settings: { ...counted.settings, statusBarMinutes: 5 } })
  const worker = await mountWorker(main, { host })
  await waitFor(() => statusBarItem(host) !== null)
  assert.deepEqual(statusBarItem(host), {
    id: 'open-tasks',
    text: '7',
    tone: 'neutral',
    tooltip: text('statusBar.tooltip', { total: 7 }),
    visible: true
  })
  assert.equal(scheduled.at(-1)?.ms, 5 * 60_000)

  // One task past its due date: warning, and the tooltip says how many.
  redmine.counts.overdue = 1
  await tick(host, scheduled)
  assert.equal(statusBarItem(host)?.tone, 'warning')
  assert.equal(statusBarItem(host)?.tooltip, `${text('statusBar.tooltip', { total: 7 })} · ${text('statusBar.overdue', { count: 1 })}`)

  // Urgent work wins over overdue.
  redmine.counts.urgent = 2
  await tick(host, scheduled)
  assert.equal(statusBarItem(host)?.tone, 'danger')
  assert.ok(String(statusBarItem(host)?.tooltip).includes(text('statusBar.urgent', { count: 2 })))

  // Nothing open: 0 in the neutral tone.
  Object.assign(redmine.counts, { total: 0, overdue: 0, urgent: 0 })
  await tick(host, scheduled)
  assert.equal(statusBarItem(host)?.text, '0')
  assert.equal(statusBarItem(host)?.tone, 'neutral')
  await worker.deactivate()
})

test('the item is hidden without a saved connection, when turned off, and on disconnect', async () => {
  resetRedmineCaches()
  fakeTimers()
  // No API key: nothing to count.
  let host = mockHost({ settings: { url: 'https://redmine.test' } })
  let worker = await mountWorker(main, { host })
  await waitFor(() => statusBarItem(host) !== null)
  assert.deepEqual(statusBarItem(host), { id: 'open-tasks', visible: false })
  await worker.deactivate()

  // Turned off in Settings: no Redmine request at all.
  const requests = stubFetch({})
  host = mockHost({ settings: { url: 'https://redmine.test', statusBar: false }, secrets: { apiKey: 'KEY' } })
  worker = await mountWorker(main, { host })
  await waitFor(() => statusBarItem(host) !== null)
  assert.deepEqual(statusBarItem(host), { id: 'open-tasks', visible: false })
  assert.deepEqual(requests, [])
  await worker.deactivate()

  // Disconnecting hides it at once, without waiting for the interval.
  statusBarRedmine({ total: 3 })
  host = mockHost(counted)
  worker = await mountWorker(main, { host })
  await waitFor(() => statusBarItem(host)?.text === '3')
  await worker.request('redmine.disconnect')
  assert.deepEqual(statusBarItem(host), { id: 'open-tasks', visible: false })
  await worker.deactivate()
})

test('turning the item off in Settings hides it without waiting for the interval', async () => {
  resetRedmineCaches()
  fakeTimers()
  statusBarRedmine({ total: 2 })
  const host = mockHost(counted)
  const worker = await mountWorker(main, { host })
  await waitFor(() => statusBarItem(host)?.text === '2')

  const updates = host.callsOf('statusBar.update').length
  await host.worker.call('settings.set', { key: 'statusBar', value: false })
  await waitFor(() => host.callsOf('statusBar.update').length > updates, 'the item to hide')
  assert.deepEqual(statusBarItem(host), { id: 'open-tasks', visible: false })
  await worker.deactivate()
})

test('a failed refresh drops the count and says why, and the next one recovers', async () => {
  resetRedmineCaches()
  const scheduled = fakeTimers()
  statusBarRedmine({ total: 7 })
  const healthy = globalThis.fetch
  const host = mockHost(counted)
  const worker = await mountWorker(main, { host })
  await waitFor(() => statusBarItem(host)?.text === '7')

  globalThis.fetch = (async () => {
    throw new Error('connect ECONNREFUSED')
  }) as unknown as typeof fetch
  await tick(host, scheduled)
  assert.deepEqual([statusBarItem(host)?.text, statusBarItem(host)?.tone], ['', 'warning'])
  assert.match(String(statusBarItem(host)?.tooltip), /ECONNREFUSED/)
  assert.ok(worker.logs.some((line) => line.startsWith('statusBar:')))

  globalThis.fetch = healthy
  await tick(host, scheduled)
  assert.equal(statusBarItem(host)?.text, '7')
  assert.equal(statusBarItem(host)?.tone, 'neutral')
  await worker.deactivate()
})

test('closing a task from the panel updates the count without waiting for the interval', async () => {
  resetRedmineCaches()
  fakeTimers()
  const redmine = statusBarRedmine({ total: 7 })
  const counting = globalThis.fetch
  globalThis.fetch = (async (url: string, init: { method: string }) => {
    if (init.method !== 'GET') {
      redmine.counts.total = 6
      return jsonReply({}, 204)
    }
    return new URL(url).pathname === '/issues/77.json' ? jsonReply({ issue }) : counting(url as never, init as never)
  }) as unknown as typeof fetch
  const host = mockHost(counted)
  const worker = await mountWorker(main, { host })
  await waitFor(() => statusBarItem(host)?.text === '7')

  const detail = await worker.request('redmine.setStatus', { id: 77, statusId: 5 })
  assert.equal(detail.subject, 'Checkout screen')
  assert.equal(statusBarItem(host)?.text, '6')
  await worker.deactivate()
})

test('the interval comes from Settings, is re-read on every tick, and ticks do not stack', async () => {
  resetRedmineCaches()
  const scheduled = fakeTimers()
  statusBarRedmine({ total: 4 })
  const counting = globalThis.fetch
  // A Redmine that holds its answer until the test lets it go, counting what it was asked.
  let gate: Promise<void> | null = null
  let open: (() => void) | null = null
  let requests = 0
  globalThis.fetch = (async (url: string, init: unknown) => {
    requests += 1
    if (gate) await gate
    return counting(url as never, init as never)
  }) as unknown as typeof fetch

  const host = mockHost({ ...counted, settings: { ...counted.settings, statusBarMinutes: 5 } })
  const worker = await mountWorker(main, { host })
  await waitFor(() => statusBarItem(host)?.text === '4')
  assert.equal(scheduled.at(-1)?.ms, 5 * 60_000)

  // The interval tick while the three counts are still unanswered: no second set of requests.
  const updates = host.callsOf('statusBar.update').length
  gate = new Promise<void>((resolve) => {
    open = resolve
  })
  const before = requests
  scheduled.at(-1)!.run()
  await waitFor(() => requests > before, 'the counts to be asked')
  // The tick that arrives meanwhile arms the next interval and waits for the same answer instead
  // of starting a second set of requests.
  scheduled.at(-1)!.run()
  await waitFor(() => scheduled.length >= 3, 'the tick to arm the next interval')
  assert.equal(requests, before + 2)
  gate = null
  open!()
  await waitFor(() => host.callsOf('statusBar.update').length > updates, 'the held refresh to land')
  assert.equal(requests, before + 3)

  // A shorter interval in Settings applies at the next tick.
  await host.worker.call('settings.set', { key: 'statusBarMinutes', value: 1 })
  scheduled.at(-1)!.run()
  await waitFor(() => scheduled.at(-1)!.ms === 60_000, 'the new interval')
  await worker.deactivate()
})

test('the item opens the panel, finding the plugin key in the CLI listing', async () => {
  resetRedmineCaches()
  fakeTimers()
  stubFetch({ '/issues.json': { issues: [issue], total_count: 1 } })
  const runs: string[][] = []
  main.setOrcaRunner(async (args) => {
    runs.push([...args])
    if (args[1] === 'list') {
      return {
        plugins: [
          { pluginKey: 'acme.todos', status: 'running', statusBarItems: [] },
          { pluginKey: 'plozmun.redmine-tasks', status: 'disabled', statusBarItems: [] },
          { pluginKey: 'local.redmine-tasks', status: 'running', statusBarItems: [{ id: 'open-tasks' }] }
        ]
      }
    }
    return { pluginKey: args[2], kind: 'panel', panelId: 'redmine', title: 'Redmine' }
  })
  const worker = await mountWorker(main, {
    host: mockHost(configured),
    commands: ['redmine.myIssues', 'redmine.openPanel']
  })
  assert.equal(await worker.command('redmine.openPanel'), translate(systemLocale(), 'command.panelOpened'))
  assert.deepEqual(runs.at(-1), ['plugin', 'open', 'local.redmine-tasks', '--panel', 'redmine'])
  // The key is resolved once.
  await worker.command('redmine.openPanel')
  assert.equal(runs.filter((args) => args[1] === 'list').length, 1)
  await worker.deactivate()
  main.setOrcaRunner((args) => runOrcaJson(args))
})

test('without the Orca CLI the item shows my task list instead', async () => {
  resetRedmineCaches()
  fakeTimers()
  stubFetch({ '/issues.json': { issues: [issue], total_count: 1 } })
  main.setOrcaRunner(async () => {
    throw Object.assign(new Error('spawn orca ENOENT'), { code: 'orca_cli' })
  })
  const worker = await mountWorker(main, {
    host: mockHost(configured),
    commands: ['redmine.myIssues', 'redmine.openPanel']
  })
  const text = String(await worker.command('redmine.openPanel'))
  assert.match(text, /#77 \[New\] Checkout screen \(Shop\)/)
  assert.ok(worker.logs.some((line) => line.startsWith('openPanel:')))
  await worker.deactivate()
  main.setOrcaRunner((args) => runOrcaJson(args))
})
