// Runs src/worker.ts's activate(orca) over a mock host, with `fetch` and the Orca CLI stubbed.
import { afterEach, assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

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

test('types the task prompt into the terminal in the panel language, without Enter', async () => {
  stubFetch({ '/issues/77.json': { issue } })
  const host = mockHost({ ...configured, results: { 'terminal.sendText': { accepted: true } } })
  const worker = await mountWorker(main, { host })
  assert.deepEqual(await worker.request('redmine.sendToAgent', { id: 77, terminalId: 't1', locale: 'es' }), { accepted: true })
  const [params] = host.callsOf('terminal.sendText') as { terminalId: string; text: string; enter: boolean }[]
  assert.equal(params.terminalId, 't1')
  assert.equal(params.enter, false)
  assert.match(params.text, /^Trabaja en la tarea de Redmine #77 "Checkout screen"/)
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
  stubFetch({ '/issues/77.json': { issue } })
  const host = mockHost({
    ...configured,
    settings: { ...configured.settings, sendPrompt: 'Take #{id}:\n{subject}' },
    results: { 'terminal.sendText': { accepted: true } }
  })
  const worker = await mountWorker(main, { host })
  await worker.request('redmine.sendToAgent', { id: 77, terminalId: 't1', locale: 'en' })
  const [params] = host.callsOf('terminal.sendText') as { text: string }[]
  assert.equal(params.text, 'Take #77: Checkout screen')
  await worker.deactivate()
})
