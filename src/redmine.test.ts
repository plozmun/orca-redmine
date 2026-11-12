import { assert, test } from 'orca/testing'
import { localDateDaysAgo, projectSubtree, RedmineClient, RedmineError, resetRedmineCaches, urgentPriorityIds } from './redmine'

function fakeFetch(responses: Record<string, { status?: number; body?: unknown }>) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = []
  const impl = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, ...init })
    const key = Object.keys(responses).find((k) => url.includes(k))
    const res = key ? responses[key] : { status: 404 }
    const status = res.status ?? 200
    return { ok: status < 400, status, text: async () => (res.body === undefined ? '' : JSON.stringify(res.body)) }
  }
  return { calls, impl }
}

const rawIssue = {
  id: 4321,
  subject: 'Broken login',
  project: { id: 1, name: 'App' },
  tracker: { id: 1, name: 'Bug' },
  status: { id: 2, name: 'In progress' },
  priority: { id: 3, name: 'High' },
  assigned_to: { id: 7, name: 'Pablo' },
  updated_on: '2026-11-02T10:00:00Z',
  description: 'Fails with SSO',
  done_ratio: 30,
  journals: [
    { id: 1, user: { name: 'Ana' }, notes: 'Reproduced', created_on: '2026-11-02T09:00:00Z' },
    { id: 2, user: { name: 'Ana' }, notes: '', created_on: '2026-11-02T09:05:00Z' }
  ]
}

test('lists my open issues with the API key header', async () => {
  const { calls, impl } = fakeFetch({ '/issues.json': { body: { issues: [rawIssue], total_count: 1 } } })
  const client = new RedmineClient('https://redmine.test/', 'KEY', impl)
  const { issues, total } = await client.listIssues({ mine: true, search: 'login', limit: 10 })
  assert.equal(total, 1)
  assert.equal(issues[0].project, 'App')
  assert.equal(issues[0].projectId, 1)
  const url = new URL(calls[0].url)
  assert.equal(url.origin + url.pathname, 'https://redmine.test/issues.json')
  assert.equal(url.searchParams.get('assigned_to_id'), 'me')
  assert.equal(url.searchParams.get('status_id'), 'open')
  assert.equal(url.searchParams.get('subject'), '~login')
  assert.equal(calls[0].headers['X-Redmine-API-Key'], 'KEY')
})

test('searching #123 filters by id in any status', async () => {
  const { calls, impl } = fakeFetch({ '/issues.json': { body: { issues: [], total_count: 0 } } })
  await new RedmineClient('https://redmine.test', 'KEY', impl).listIssues({ mine: false, search: '#123' })
  const params = new URL(calls[0].url).searchParams
  assert.equal(params.get('issue_id'), '123')
  assert.equal(params.get('status_id'), '*')
  assert.equal(params.get('assigned_to_id'), null)
})

test('filters issues by project', async () => {
  const { calls, impl } = fakeFetch({ '/issues.json': { body: { issues: [], total_count: 0 } } })
  await new RedmineClient('https://redmine.test', 'KEY', impl).listIssues({ mine: true, projectId: 'client-ios' })
  assert.equal(new URL(calls[0].url).searchParams.get('project_id'), 'client-ios')
})

test('issue detail keeps non-empty comments and the URL', async () => {
  const { impl } = fakeFetch({ '/issues/4321.json': { body: { issue: rawIssue } } })
  const issue = await new RedmineClient('https://redmine.test', 'KEY', impl).getIssue(4321)
  assert.equal(issue.url, 'https://redmine.test/issues/4321')
  assert.equal(issue.doneRatio, 30)
  assert.deepEqual(issue.journals.map((j) => j.notes), ['Reproduced'])
})

test('HTTP errors become codes; 422 carries Redmine messages', async () => {
  const { impl } = fakeFetch({
    '/users/current.json': { status: 401 },
    '/time_entries.json': { status: 422, body: { errors: ['Activity cannot be blank'] } }
  })
  const client = new RedmineClient('https://redmine.test', 'BAD', impl)
  await assert.rejects(client.currentUser(), (e: RedmineError) => e.code === 'unauthorized')
  await assert.rejects(client.logTime(1, 1, ''), (e: RedmineError) => e.code === 'http_error' && e.message === 'Activity cannot be blank')
})

test('network failures become the network code', async () => {
  const client = new RedmineClient('https://redmine.test', 'KEY', async () => {
    throw new Error('fetch failed')
  })
  await assert.rejects(client.currentUser(), (e: RedmineError) => e.code === 'network' && e.message.includes('fetch failed'))
})

test('invalid URL', () => {
  assert.throws(() => new RedmineClient('redmine.test', 'KEY'), (e: RedmineError) => e.code === 'invalid_url')
})

test('projects get their parent path, sorted, archived ones dropped', async () => {
  const { calls, impl } = fakeFetch({
    '/projects.json': {
      body: {
        total_count: 3,
        projects: [
          { id: 1, identifier: 'client', name: 'Client', status: 1 },
          { id: 2, identifier: 'client-ios', name: 'iOS App', parent: { id: 1 }, status: 1 },
          { id: 3, identifier: 'old', name: 'Old', status: 5 }
        ]
      }
    }
  })
  const projects = await new RedmineClient('https://redmine.test', 'KEY', impl).listProjects()
  assert.deepEqual(projects.map((p) => p.name), ['Client', 'Client › iOS App'])
  assert.equal(calls.length, 1)
})


test('filters issues by status; unknown values mean open', async () => {
  const { calls, impl } = fakeFetch({ '/issues.json': { body: { issues: [], total_count: 0 } } })
  const client = new RedmineClient('https://redmine.test', 'KEY', impl)
  await client.listIssues({ mine: true, status: '3' })
  await client.listIssues({ mine: true, status: 'closed' })
  await client.listIssues({ mine: true, status: '*' })
  await client.listIssues({ mine: true, status: '1;drop' })
  assert.deepEqual(
    calls.map((c) => new URL(c.url).searchParams.get('status_id')),
    ['3', 'closed', '*', 'open']
  )
})

test('my time entries on a task, newest first', async () => {
  const { calls, impl } = fakeFetch({
    '/time_entries.json': {
      body: {
        time_entries: [
          { id: 1, hours: 1.5, comments: 'Review', spent_on: '2026-11-01', activity: { name: 'Development' }, user: { name: 'Pablo' } },
          { id: 2, hours: '2', comments: '', spent_on: '2026-11-03', activity: { name: 'Testing' }, user: { name: 'Pablo' } }
        ]
      }
    }
  })
  const entries = await new RedmineClient('https://redmine.test', 'KEY', impl).myTimeEntries(4321)
  const params = new URL(calls[0].url).searchParams
  assert.equal(params.get('issue_id'), '4321')
  assert.equal(params.get('user_id'), 'me')
  assert.deepEqual(entries.map((e) => [e.id, e.hours, e.spentOn, e.activity]), [
    [2, 2, '2026-11-03', 'Testing'],
    [1, 1.5, '2026-11-01', 'Development']
  ])
})

test('a project and its subprojects, by identifier or id', () => {
  const projects = [
    { id: 1, identifier: 'client', name: 'Client' },
    { id: 2, identifier: 'ios', name: 'Client › iOS', parentId: 1 },
    { id: 3, identifier: 'ios-pay', name: 'Client › iOS › Pay', parentId: 2 },
    { id: 4, identifier: 'web', name: 'Web' }
  ]
  assert.deepEqual([...projectSubtree(projects, 'client')].sort(), [1, 2, 3])
  assert.deepEqual([...projectSubtree(projects, '2')].sort(), [2, 3])
  assert.deepEqual([...projectSubtree(projects, 'nope')], [])
})

// --- Counts for the status bar ---

const priorities = [
  { id: 1, name: 'Low' },
  { id: 2, name: 'Normal' },
  { id: 3, name: 'High' },
  { id: 4, name: 'Urgent' },
  { id: 5, name: 'Immediate' }
]

/** Redmine answering each count by its filter; `lists` counts the priority enumeration calls. */
function countingFetch(counts: { total: number; overdue: number; urgent: number }, answered = priorities) {
  const calls: string[] = []
  let enumerations = 0
  const impl = async (url: string) => {
    calls.push(url)
    if (url.includes('/enumerations/issue_priorities.json')) {
      enumerations += 1
      return { ok: true, status: 200, text: async () => JSON.stringify({ issue_priorities: answered }) }
    }
    const params = new URL(url).searchParams
    const which = params.get('due_date') ? 'overdue' : params.get('priority_id') ? 'urgent' : 'total'
    return { ok: true, status: 200, text: async () => JSON.stringify({ issues: [], total_count: counts[which] }) }
  }
  return { calls, impl, enumerations: () => enumerations }
}

test('the open counts come from limit=1 queries, and the priority list is read once', async () => {
  resetRedmineCaches()
  const redmine = countingFetch({ total: 7, overdue: 2, urgent: 1 })
  const client = new RedmineClient('https://redmine.test', 'KEY', redmine.impl)
  assert.deepEqual(await client.openCounts(), { total: 7, overdue: 2, urgent: 1 })

  for (const url of redmine.calls.filter((call) => call.includes('/issues.json'))) {
    const params = new URL(url).searchParams
    assert.equal(params.get('assigned_to_id'), 'me')
    assert.equal(params.get('status_id'), 'open')
    assert.equal(params.get('limit'), '1')
  }
  // `<=` yesterday: Redmine's date shorthand has no plain `<`, and on or before yesterday is
  // before today.
  const overdue = redmine.calls.find((url) => url.includes('due_date='))!
  assert.ok(overdue.includes(`due_date=%3C%3D${localDateDaysAgo(1)}`), overdue)
  assert.equal(new URL(overdue).searchParams.get('due_date'), `<=${localDateDaysAgo(1)}`)
  const urgent = redmine.calls.find((url) => url.includes('priority_id='))!
  assert.equal(new URL(urgent).searchParams.get('priority_id'), '4|5')

  // A second refresh asks Redmine for the counts again, not for the priorities.
  await client.openCounts()
  assert.equal(redmine.enumerations(), 1)
  assert.equal(redmine.calls.length, 7)
})

test('urgent priorities are the two ranks above the default one, in the instance order', () => {
  // Stock Redmine, default "Normal": Urgent and Immediate, not High.
  assert.deepEqual(urgentPriorityIds(priorities), [4, 5])
  // An instance that flags its default: two ranks after it.
  assert.deepEqual(
    urgentPriorityIds([
      { id: 1, name: 'Low', isDefault: true },
      { id: 2, name: 'Normal' },
      { id: 8, name: 'High' },
      { id: 9, name: 'Critical' }
    ]),
    [8, 9]
  )
  // A short list with nothing two ranks above its default: no urgent filter at all.
  assert.deepEqual(
    urgentPriorityIds([
      { id: 1, name: 'Low' },
      { id: 2, name: 'Normal' },
      { id: 3, name: 'High' }
    ]),
    []
  )
  assert.deepEqual(urgentPriorityIds([{ id: 1, name: 'Only' }]), [])
  assert.deepEqual(urgentPriorityIds([]), [])
})

test('without a priority two ranks above the default, no urgent count is asked for', async () => {
  resetRedmineCaches()
  const redmine = countingFetch({ total: 4, overdue: 1, urgent: 0 }, [
    { id: 1, name: 'Low' },
    { id: 2, name: 'Normal' },
    { id: 3, name: 'High' }
  ])
  assert.deepEqual(await new RedmineClient('https://redmine.test', 'KEY', redmine.impl).openCounts(), {
    total: 4,
    overdue: 1,
    urgent: 0
  })
  assert.ok(!redmine.calls.some((url) => url.includes('priority_id=')))
})

test('the priority enumeration is cached per Redmine URL', async () => {
  resetRedmineCaches()
  const first = countingFetch({ total: 0, overdue: 0, urgent: 0 }, [{ id: 1, name: 'Low' }])
  const second = countingFetch({ total: 0, overdue: 0, urgent: 0 }, [{ id: 1, name: 'Low' }])
  await new RedmineClient('https://one.test', 'KEY', first.impl).openCounts()
  await new RedmineClient('https://two.test', 'KEY', second.impl).openCounts()
  assert.equal(first.enumerations(), 1)
  assert.equal(second.enumerations(), 1)
})

test('count failures keep the Redmine error codes', async () => {
  resetRedmineCaches()
  const unauthorized = new RedmineClient('https://redmine.test', 'BAD', async (url: string) => {
    if (url.includes('/enumerations/')) {
      return { ok: false, status: 401, text: async () => '' }
    }
    return { ok: false, status: 401, text: async () => '' }
  })
  await assert.rejects(unauthorized.openCounts(), (e: RedmineError) => e.code === 'unauthorized')

  const offline = new RedmineClient('https://redmine.test', 'KEY', async () => {
    throw new Error('fetch failed')
  })
  await assert.rejects(offline.openCounts(), (e: RedmineError) => e.code === 'network')
})
