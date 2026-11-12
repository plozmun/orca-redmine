// Runs src/worker.ts's activate(orca) over a mock host, with `fetch` and the Orca CLI stubbed.
import { afterEach, assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'
import { createFollowup, MAX_FOLLOWUPS, type Followup } from './followups'

const realFetch = globalThis.fetch

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
})

const configured = {
  settings: { url: 'https://redmine.test', limit: 50 },
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
  const worker = await mountWorker(main, { host: mockHost(configured), commands: ['redmine.myIssues'] })
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

// --- Launch in the focused workspace (agent.launch) ---

const hostWorkspace = { branch: 'feature/1-pay', displayName: 'pay', terminals: [] }
const hostRows = {
  workspaces: [
    { id: 'identity:wt-1', kind: 'worktree', name: 'pay', path: '/p', branch: 'feature/1-pay', hostId: null },
    { id: 'identity:wt-2', kind: 'worktree', name: 'pay', path: '/q', branch: 'other', hostId: null }
  ],
  truncated: false
}

function launchHereHost(extra: Record<string, unknown> = {}, context: unknown = hostWorkspace) {
  return mockHost({
    ...configured,
    capabilities: ['settings:own', 'secrets:own', 'workspace:read', 'agent:launch'],
    results: {
      'workspace.readContext': context,
      'workspace.list': hostRows,
      'agent.launch': { terminalId: 't9' },
      ...extra
    }
  })
}

test('launch here starts the agent in the focused workspace with the task prompt', async () => {
  stubFetch({ '/issues/77.json': { issue: { ...issue, description: 'Integrate payments' } } })
  main.setRedmineCliDetector(async () => null)
  const host = launchHereHost()
  const worker = await mountWorker(main, { host })
  assert.deepEqual(await worker.request('redmine.launchHereSupport'), { available: true })
  assert.deepEqual(await worker.request('redmine.launchHere', { issueId: 77, agent: 'claude', instructions: 'Do it', locale: 'en' }), {
    terminalId: 't9',
    workspaceKey: 'wt-1'
  })
  const [params] = host.callsOf('agent.launch') as { workspaceId: string; agent: string; prompt: string }[]
  // The `workspace.list` id, the one every host workspace method takes.
  assert.equal(params.workspaceId, 'identity:wt-1')
  assert.equal(params.agent, 'claude')
  assert.ok(params.prompt.startsWith('Do it\n'))
  assert.ok(params.prompt.includes('Integrate payments'))
  assert.ok(params.prompt.includes('--- BEGIN LINKED WORK ITEM CONTEXT ---'))
  assert.ok(!params.prompt.includes('CLI'))
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('launch here says why it could not start the agent, with codes', async () => {
  stubFetch({ '/issues/77.json': { issue } })
  const run = async (host: ReturnType<typeof mockHost>) => {
    const worker = await mountWorker(main, { host })
    const fail = async (input = { issueId: 77, agent: 'claude', instructions: 'Go', locale: 'en' }) => {
      try {
        await worker.request('redmine.launchHere', input)
        return null
      } catch (error) {
        return (error as { code?: string }).code
      }
    }
    const first = await fail()
    await worker.deactivate()
    return { first }
  }

  // No focused workspace.
  assert.equal((await run(launchHereHost({}, null))).first, 'no_workspace')
  // A workspace the host does not list.
  assert.equal((await run(launchHereHost({ 'workspace.list': { workspaces: [], truncated: false } }))).first, 'workspace_not_listed')
  // Whatever the host refuses (`agent.launch` errors keep their code).
  assert.equal(
    (await run(
      launchHereHost({
        'agent.launch': () => {
          throw Object.assign(new Error('unknown agent'), { code: 'invalid_params' })
        }
      })
    )).first,
    'invalid_params'
  )
})

test('a prompt over agent.launch’s cap moves the context to a file and points at it', async () => {
  const { mkdtemp, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'redmine-here-'))
  main.setContextDir(dir)
  main.setRedmineCliDetector(async () => null)
  stubFetch({ '/issues/77.json': { issue: { ...issue, description: 'Detail '.repeat(2000) } } })
  const host = launchHereHost()
  const worker = await mountWorker(main, { host })
  await worker.request('redmine.launchHere', { issueId: 77, agent: 'claude', instructions: 'Do it', locale: 'en' })
  const [params] = host.callsOf('agent.launch') as { prompt: string }[]
  const file = join(dir, '77.md')
  assert.ok(params.prompt.length <= 4096)
  assert.ok(params.prompt.startsWith('Do it\n'))
  assert.ok(params.prompt.includes(`Read its description and comments in ${file} first.`))
  assert.ok(!params.prompt.includes('--- BEGIN LINKED WORK ITEM CONTEXT ---'))
  assert.ok((await readFile(file, 'utf8')).includes('--- BEGIN LINKED WORK ITEM CONTEXT ---'))
  main.setContextDir(undefined)
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
    results: {
      'terminal.sendText': { accepted: true },
      'workspace.readContext': hostWorkspace,
      'workspace.list': hostRows,
      'agent.launch': { terminalId: 't9' }
    }
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
  await call(() => worker.request('redmine.launchHere', { issueId: 77, agent: 'claude', instructions: 'Go', locale: 'en' }))

  const files = await Promise.all((await readdir(dir)).map((f) => readFile(join(dir, f), 'utf8')))
  assert.ok(files.length > 0 && prompts.length > 0 && worker.logs.length > 0, 'the paths under test ran')
  const everything = JSON.stringify({
    logs: worker.logs,
    seen,
    posts: worker.posts,
    prompts,
    files,
    sent: host.callsOf('terminal.sendText'),
    launched: host.callsOf('agent.launch'),
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

async function createdWorker(options: { settings?: Record<string, unknown>; storage?: Record<string, unknown>; orcaProject?: string | null; capabilities?: readonly string[] } = {}) {
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
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
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

// --- Agents started in a linked workspace: REDMINE_ISSUE and the optional prompt pointer ---

const LINKED_4077 = { 'wt-4077-checkout': { id: 4077, subject: 'Checkout with saved cards' } }
const hostRow4077 = {
  id: 'identity:wt-4077-checkout',
  kind: 'worktree' as const,
  name: '4077-checkout',
  path: '/repos/shop/4077-checkout',
  branch: 'pablo/4077-checkout',
  hostId: 'local'
}

/** A worker whose Redmine is unreachable: any network call would fail the test. */
async function agentWorker(
  options: {
    settings?: Record<string, unknown>
    storage?: Record<string, unknown>
    workspaces?: unknown[]
    capabilities?: string[]
  } = {}
) {
  const fetchCalls: string[] = []
  globalThis.fetch = (async (url: string) => {
    fetchCalls.push(url)
    throw new Error(`unexpected network call: ${url}`)
  }) as unknown as typeof fetch
  const host = mockHost({
    ...configured,
    settings: { ...configured.settings, ...options.settings },
    storage: (options.storage ?? { 'links.issueByWorkspace': LINKED_4077 }) as never,
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    results: { 'workspace.list': { workspaces: options.workspaces ?? [hostRow4077], truncated: false } }
  })
  const worker = await mountWorker(main, { host })
  return { worker, host, fetchCalls }
}

const agentLaunch = (extra: { workspaceId?: string | null; terminalId?: string; env?: Record<string, string> } = {}) => ({
  agent: 'claude',
  workspaceId: extra.workspaceId === undefined ? 'identity:wt-4077-checkout' : extra.workspaceId,
  workspaceKind: 'worktree' as const,
  ...(extra.terminalId ? { terminalId: extra.terminalId } : {}),
  command: 'claude',
  env: extra.env ?? {}
})

const promptEvent = (extra: { terminalId?: string; prompt?: string; inputKind?: 'launch' | 'orchestration' | 'driving' }) => ({
  agent: 'claude',
  terminalId: extra.terminalId ?? 't1',
  prompt: extra.prompt ?? 'Fix the failing tests',
  inputKind: extra.inputKind ?? ('launch' as const)
})

test('agent.launch.before exports REDMINE_ISSUE, and nothing else, without calling Redmine', async () => {
  const { worker, fetchCalls } = await agentWorker()
  const decision = (await worker.hooks.fire('agent.launch.before', agentLaunch())) as {
    event?: { command: string; env: Record<string, string> }
  }
  assert.deepEqual(decision.event?.env, { REDMINE_ISSUE: '4077' })
  assert.equal(decision.event?.command, 'claude')
  // No key, no URL, no file: only the number travels.
  const values = Object.values(decision.event!.env)
  assert.deepEqual(Object.keys(decision.event!.env), ['REDMINE_ISSUE'])
  assert.ok(!values.some((v) => v === configured.secrets.apiKey || v.includes('redmine.test')))
  assert.deepEqual(fetchCalls, [])
  await worker.deactivate()
})

test('agent.launch.before keeps the environment the launcher chose', async () => {
  const { worker } = await agentWorker()
  const kept = (await worker.hooks.fire('agent.launch.before', agentLaunch({ env: { CI: '1' } }))) as {
    event: { env: Record<string, string> }
  }
  assert.deepEqual(kept.event.env, { CI: '1', REDMINE_ISSUE: '4077' })
  const own = (await worker.hooks.fire('agent.launch.before', agentLaunch({ env: { REDMINE_ISSUE: '9' } }))) as {
    event: { env: Record<string, string> }
  }
  assert.deepEqual(own.event.env, { REDMINE_ISSUE: '9' })
  await worker.deactivate()
})

test('agent.launch.before passes when there is no workspace, no link, or no host listing entry', async () => {
  let w = await agentWorker()
  for (const event of [
    agentLaunch({ workspaceId: null }),
    agentLaunch({ workspaceId: 'identity:wt-other' }),
    agentLaunch({ workspaceId: 'identity:wt-other' })
  ]) {
    // A pass leaves the event exactly as it came.
    const decision = (await w.worker.hooks.fire('agent.launch.before', event)) as { event: unknown }
    assert.deepEqual(decision.event, event)
  }
  await w.worker.deactivate()

  w = await agentWorker({ storage: {} })
  const unlinked = agentLaunch()
  assert.deepEqual(((await w.worker.hooks.fire('agent.launch.before', unlinked)) as { event: unknown }).event, unlinked)
  await w.worker.deactivate()

  w = await agentWorker({ workspaces: [] })
  const cliId = agentLaunch({ workspaceId: 'r::/repos/shop/4077-checkout' })
  assert.deepEqual(((await w.worker.hooks.fire('agent.launch.before', cliId)) as { event: unknown }).event, cliId)
  await w.worker.deactivate()
})

test('agent.launch.before resolves the CLI workspace id through workspace.list, by id or path', async () => {
  const { worker, host } = await agentWorker()
  const byPath = (await worker.hooks.fire('agent.launch.before', agentLaunch({ workspaceId: 'r::/repos/shop/4077-checkout' }))) as {
    event?: { env: Record<string, string> }
  }
  assert.equal(byPath.event?.env.REDMINE_ISSUE, '4077')
  assert.equal(host.callsOf('workspace.list').length, 1)
  const byId = (await worker.hooks.fire('agent.launch.before', agentLaunch({ workspaceId: 'identity:wt-4077-checkout' }))) as {
    event?: { env: Record<string, string> }
  }
  assert.equal(byId.event?.env.REDMINE_ISSUE, '4077')
  // The identity form needs no listing at all.
  assert.equal(host.callsOf('workspace.list').length, 1)
  await worker.deactivate()
})

test('the prompt pointer names the task only where asked for', async () => {
  const workspaces = [hostRow4077]
  // Setting on, terminal seen by the launch hook: one line naming the task.
  let w = await agentWorker({ settings: { promptPointer: true }, workspaces })
  await w.worker.hooks.fire('agent.launch.before', agentLaunch({ workspaceId: 'r::/repos/shop/4077-checkout', terminalId: 't1' }))
  const pointed = (await w.worker.hooks.fire('agent.prompt.before', promptEvent({}))) as { event?: { prompt: string } }
  assert.equal(
    pointed.event?.prompt,
    'Fix the failing tests\n\nRedmine task #4077 "Checkout with saved cards": https://redmine.test/issues/4077'
  )
  // The plugin's own prompt already names the task (by number, or by URL): unchanged.
  for (const prompt of [
    'Work on Redmine task #4077 "Checkout with saved cards": https://redmine.test/issues/4077',
    'Take a look at https://redmine.test/issues/4077'
  ]) {
    const event = promptEvent({ prompt })
    const decision = (await w.worker.hooks.fire('agent.prompt.before', event)) as { event: unknown }
    assert.deepEqual(decision.event, event)
  }
  // Orchestration prompts and terminals the launch hook did not see: unchanged.
  for (const event of [promptEvent({ inputKind: 'orchestration' }), promptEvent({ terminalId: 't2' })]) {
    const decision = (await w.worker.hooks.fire('agent.prompt.before', event)) as { event: unknown }
    assert.deepEqual(decision.event, event)
  }
  await w.worker.deactivate()

  // Off by default: nothing is appended.
  w = await agentWorker({ workspaces })
  await w.worker.hooks.fire('agent.launch.before', agentLaunch({ terminalId: 't1' }))
  const off = promptEvent({})
  assert.deepEqual(((await w.worker.hooks.fire('agent.prompt.before', off)) as { event: unknown }).event, off)
  await w.worker.deactivate()
})

test('the prompt pointer omits the URL when Orca has no Redmine URL yet', async () => {
  const { worker } = await agentWorker({ settings: { promptPointer: true, url: '' } })
  await worker.hooks.fire('agent.launch.before', agentLaunch({ terminalId: 't1' }))
  const decision = (await worker.hooks.fire('agent.prompt.before', promptEvent({}))) as { event?: { prompt: string } }
  assert.equal(decision.event?.prompt, 'Fix the failing tests\n\nRedmine task #4077 "Checkout with saved cards"')
  await worker.deactivate()
})

// --- Follow-ups: agent finished, workspace removed ---

const followupsOf = (host: ReturnType<typeof mockHost>): Followup[] =>
  ((host.data().storage.followups as Followup[] | undefined) ?? [])

function agentEvent(workspaceId: string | null, state: 'working' | 'blocked' | 'done', receivedAt: number, outcome?: 'success' | 'failure' | 'cancellation' | 'unconfirmed') {
  return {
    workspaceId,
    paneKey: 'pane-1',
    state,
    receivedAt,
    ...(state === 'done'
      ? { mainAgent: { state, ...(outcome ? { outcome } : {}), stateStartedAt: receivedAt } }
      : {})
  }
}

test('an agent finishing on a linked task records a follow-up and writes nothing to Redmine', async () => {
  const { worker, host, writes } = await createdWorker()
  await worker.emit('workspace.created', created('4077-checkout'))
  const start = 1_000_000
  await worker.emit('agent.status.changed', agentEvent('identity:wt-4077-checkout', 'working', start))
  await worker.emit('agent.status.changed', agentEvent('identity:wt-4077-checkout', 'done', start + 70 * 60_000, 'success'))

  const list = followupsOf(host)
  assert.equal(list.length, 1)
  assert.equal(list[0].kind, 'agentDone')
  assert.equal(list[0].issueId, 4077)
  assert.equal(list[0].workspaceName, '4077-checkout')
  assert.equal(list[0].hours, 1.25)
  assert.deepEqual(writes, [], 'no Redmine write request')
  assert.deepEqual(worker.posts.at(-1), { event: 'redmine.followupsChanged', payload: { followups: list } })
  await worker.deactivate()
})

test('no follow-up for a cancelled agent, an unlinked workspace or no workspace', async () => {
  const { worker, host } = await createdWorker()
  await worker.emit('workspace.created', created('4077-checkout'))
  await worker.emit('agent.status.changed', agentEvent('identity:wt-4077-checkout', 'done', 2_000, 'cancellation'))
  await worker.emit('agent.status.changed', agentEvent('identity:wt-unlinked', 'done', 3_000, 'success'))
  await worker.emit('agent.status.changed', agentEvent(null, 'done', 4_000, 'success'))
  assert.deepEqual(followupsOf(host), [])
  await worker.deactivate()
})

test('agent events name the workspace by the CLI id too', async () => {
  const { worker, host } = await createdWorker()
  // As Orca 1.4.255 sends it: `<repoId>::<path>`.
  await worker.emit('workspace.created', created('4077-checkout', { workspaceId: 'r::/repos/shop/4077-checkout' }))
  // The worktree listing may be gone or slow: the ids remembered at creation must be enough.
  main.setOrcaLister(async () => ({ projects: [], worktrees: [] }))
  await worker.emit('agent.status.changed', agentEvent('r::/repos/shop/4077-checkout', 'done', 5_000, 'success'))
  assert.equal(followupsOf(host)[0]?.issueId, 4077)
  await worker.deactivate()
})

test('an agent that finishes twice leaves a single follow-up with the latest time', async () => {
  const { worker, host } = await createdWorker()
  await worker.emit('workspace.created', created('4077-checkout'))
  await worker.emit('agent.status.changed', agentEvent('identity:wt-4077-checkout', 'done', 2_000, 'success'))
  // The agent works again (a new turn), then finishes again.
  await worker.emit('agent.status.changed', agentEvent('identity:wt-4077-checkout', 'working', 2_500))
  await worker.emit('agent.status.changed', agentEvent('identity:wt-4077-checkout', 'done', 3_000, 'failure'))
  const list = followupsOf(host)
  assert.equal(list.length, 1)
  assert.equal(list[0].at, 3_000)
  await worker.deactivate()
})

test('removing a linked workspace deletes the link and records a follow-up', async () => {
  const { worker, host, links, writes } = await createdWorker()
  await worker.emit('workspace.created', created('4077-checkout', { workspaceId: 'r::/repos/shop/4077-checkout' }))
  assert.equal(links()?.['wt-4077-checkout']?.id, 4077)
  main.setOrcaLister(async () => ({ projects: [], worktrees: [] }))
  await worker.emit('workspace.removed', { workspaceId: 'r::/repos/shop/4077-checkout', kind: 'worktree', path: '/repos/shop/4077-checkout' })
  assert.equal(links()?.['wt-4077-checkout'], undefined)
  const list = followupsOf(host)
  assert.equal(list.length, 1)
  assert.equal(list[0].kind, 'workspaceRemoved')
  assert.equal(list[0].issueId, 4077)
  assert.equal(list[0].workspaceName, '4077-checkout')
  assert.deepEqual(writes, [])
  await worker.deactivate()
})

test('removing an unlinked workspace records nothing', async () => {
  const { worker, host } = await createdWorker()
  await worker.emit('workspace.removed', { workspaceId: 'identity:wt-unlinked', kind: 'worktree', path: '/repos/shop/other' })
  await worker.emit('workspace.removed', { workspaceId: 'identity:wt-unlinked', kind: 'folder', path: '/repos/shop/other' })
  assert.deepEqual(followupsOf(host), [])
  await worker.deactivate()
})

test('the notification is off by default and names the task when enabled', async () => {
  const capabilities = ['workspace:read', 'agent:read', 'storage:own', 'settings:own', 'secrets:own', 'notifications:show']
  const run = async (settings: Record<string, unknown>, event: ReturnType<typeof agentEvent>) => {
    const w = await createdWorker({ capabilities, settings })
    await w.worker.emit('workspace.created', created('4077-checkout'))
    await w.worker.emit('agent.status.changed', event)
    return w
  }

  // Default: the follow-up is recorded and no notification is shown.
  let w = await run({}, agentEvent('identity:wt-4077-checkout', 'done', 2_000, 'success'))
  assert.equal(followupsOf(w.host).length, 1)
  assert.deepEqual(w.host.callsOf('notifications.show'), [])
  await w.worker.deactivate()

  // done: on finish only, with the number and subject.
  w = await run({ agentNotification: 'done' }, agentEvent('identity:wt-4077-checkout', 'done', 2_000, 'success'))
  const shown = w.host.callsOf('notifications.show') as { title: string }[]
  assert.equal(shown.length, 1)
  assert.equal(shown[0].title, '#4077 Agent finished: Checkout with saved cards')
  await w.worker.deactivate()

  // A cancellation notifies nobody even with notifications on.
  w = await run({ agentNotification: 'done' }, agentEvent('identity:wt-4077-checkout', 'done', 2_000, 'cancellation'))
  assert.deepEqual(w.host.callsOf('notifications.show'), [])
  await w.worker.deactivate()

  // doneAndBlocked: also when the main agent needs input, and still no follow-up for it.
  w = await run({ agentNotification: 'doneAndBlocked' }, agentEvent('identity:wt-4077-checkout', 'blocked', 2_000))
  const blocked = w.host.callsOf('notifications.show') as { title: string }[]
  assert.equal(blocked.length, 1)
  assert.equal(blocked[0].title, 'Agent on #4077 needs input: Checkout with saved cards')
  assert.deepEqual(followupsOf(w.host), [])
  await w.worker.deactivate()

  // done alone does not notify for a blocked agent.
  w = await run({ agentNotification: 'done' }, agentEvent('identity:wt-4077-checkout', 'blocked', 2_000))
  assert.deepEqual(w.host.callsOf('notifications.show'), [])
  await w.worker.deactivate()
})

test('follow-ups can be read and dismissed, and the store keeps at most 20', async () => {
  const seeded = Array.from({ length: MAX_FOLLOWUPS }, (_, i) =>
    createFollowup({ kind: 'agentDone', issueId: 5000 + i, workspaceName: `ws-${i}`, at: 1000 + i })
  )
  const { worker, host } = await createdWorker({ storage: { followups: seeded } })
  await worker.emit('workspace.created', created('4077-checkout'))
  await worker.emit('agent.status.changed', agentEvent('identity:wt-4077-checkout', 'done', 9_000, 'success'))

  const listed = await worker.request('redmine.followups.get')
  assert.equal(listed.followups.length, MAX_FOLLOWUPS)
  assert.equal(listed.followups.some((f) => f.issueId === 5000), false, 'oldest dropped')
  assert.ok(listed.followups.some((f) => f.issueId === 4077))

  const dismissed = await worker.request('redmine.followups.dismiss', { id: listed.followups[0].id })
  assert.equal(dismissed.followups.length, MAX_FOLLOWUPS - 1)
  assert.deepEqual(followupsOf(host), dismissed.followups)
  assert.deepEqual(worker.posts.at(-1), { event: 'redmine.followupsChanged', payload: { followups: dismissed.followups } })
  await worker.deactivate()
})

test('locating a workspace remembers its ids, so removing it by CLI id still clears a hand-made link', async () => {
  // The worktree is gone by the time the removal arrives: only the ids seen at locate remain.
  main.setOrcaLister(async () => ({ projects: [], worktrees: [] }))
  const host = mockHost({
    capabilities: ['workspace:read', 'storage:own'],
    storage: { 'links.issueByWorkspace': { 'wt-1': { id: 4077, subject: 'Checkout with saved cards' } } },
    results: {
      'workspace.list': {
        workspaces: [
          {
            id: 'identity:wt-1',
            kind: 'worktree',
            name: '4077-checkout',
            path: '/repos/shop/4077-checkout',
            branch: 'feature/2-pay',
            hostId: 'local'
          }
        ],
        truncated: false
      }
    }
  })
  const worker = await mountWorker(main, { host })

  const answer = await worker.request('redmine.locateWorkspace', { displayName: '4077-checkout', branch: 'feature/2-pay' })
  assert.equal((answer.located as { workspaceKey: string } | null)?.workspaceKey, 'wt-1')
  // Remembering is fire-and-forget: the locate never waits on storage.
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(host.data().storage['links.workspaceIds'], {
    'identity:wt-1': 'wt-1',
    '/repos/shop/4077-checkout': 'wt-1'
  })

  // Orca names the removal by the CLI form (`<repoId>::<path>`), not the identity form.
  await worker.emit('workspace.removed', {
    workspaceId: 'r::/repos/shop/4077-checkout',
    kind: 'worktree',
    path: '/repos/shop/4077-checkout'
  })
  assert.equal((host.data().storage['links.issueByWorkspace'] as Record<string, unknown>)['wt-1'], undefined)
  const followups = host.data().storage.followups as Followup[]
  assert.equal(followups.length, 1)
  assert.equal(followups[0].kind, 'workspaceRemoved')
  assert.equal(followups[0].issueId, 4077)
  await worker.deactivate()
})
