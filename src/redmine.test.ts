import { assert, test } from 'orca/testing'
import { issueIdFromBranch, RedmineClient, RedmineError } from './redmine'

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

test('issue number from the branch', () => {
  assert.equal(issueIdFromBranch('feature/4321-login'), 4321)
  assert.equal(issueIdFromBranch('bug-4321'), 4321)
  assert.equal(issueIdFromBranch('4321_fix'), 4321)
  assert.equal(issueIdFromBranch('main'), null)
  assert.equal(issueIdFromBranch('release/v2'), null)
  assert.equal(issueIdFromBranch(null), null)
})
