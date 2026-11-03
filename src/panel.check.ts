// `orca plugin check` renders the panel once per scenario, with the real worker on a fresh host.
// The `list` and `detail` scenarios answer the panel's requests with sample data (no Redmine
// needed), for `orca plugin shot . --scenario <name>`.
import { defineCheck } from 'orca/testing'

const issue = (id: number, subject: string, status: string, priority: string, tracker = 'Feature') => ({
  id,
  subject,
  project: 'Shop',
  projectId: 1,
  tracker,
  status,
  statusId: status === 'New' ? 1 : 2,
  priority,
  assignee: 'Ana García',
  updatedOn: '2026-11-03T08:00:00Z'
})
const issues = [
  issue(4077, 'Checkout screen with saved cards', 'In progress', 'High'),
  issue(4081, 'Mobile pass cannot be added on iOS', 'New', 'Normal', 'Bug'),
  issue(4090, 'Refund flow for partial orders', 'New', 'Low')
]
const detail = {
  ...issues[0],
  doneRatio: 40,
  url: 'https://redmine.example.com/issues/4077',
  description:
    '## Context\nCustomers want to pay with a **saved card**.\n\n## Acceptance\n- Lists the saved cards\n- Falls back to a new card\n- Works on mobile',
  journals: [
    { id: 1, author: 'Luis Pérez', createdOn: '2026-11-01T10:00:00Z', notes: 'Design is ready in Figma.' },
    { id: 2, author: 'Ana García', createdOn: '2026-11-02T16:30:00Z', notes: 'Started the API part; blocked on the PSP sandbox.' }
  ]
}

const sample = {
  capabilities: ['workspace:read', 'settings:own', 'secrets:own', 'terminal:send'],
  requests: {
    'redmine.status': () => ({ configured: true, url: 'https://redmine.example.com', user: { login: 'ana', name: 'Ana García' } }),
    'redmine.issues': () => ({ issues, total: 12 }),
    'redmine.issue': () => detail,
    'redmine.statuses': () => [
      { id: 1, name: 'New', isClosed: false },
      { id: 2, name: 'In progress', isClosed: false }
    ],
    'redmine.projects': () => [{ id: 1, identifier: 'shop', name: 'Shop' }],
    'redmine.locateWorkspace': () => ({
      located: { workspaceKey: 'wt-1', orcaProjectId: 'git:shop', orcaProjectName: 'shop' }
    }),
    'redmine.orcaProjects': () => [{ id: 'git:shop', name: 'shop' }]
  },
  events: [
    {
      event: 'workspace.changed' as const,
      payload: {
        context: {
          displayName: '4077-checkout-screen',
          branch: 'feature/4077-checkout-screen',
          terminals: [{ id: 't1', title: 'Claude Code' }]
        }
      }
    }
  ]
}

export default defineCheck({
  // Not configured: the connect form.
  notConfigured: {},
  // Configured against a closed port: shows the connection error.
  unreachable: { settings: { url: 'http://127.0.0.1:9' }, secrets: { apiKey: 'x' } },
    // No task assigned yet: the branch suggests #4077.
  list: {
    ...sample,
    persisted: { plugin: { 'redmine.projectByOrcaProject': { 'git:shop': 'shop' } } }
  },
  // The workspace has a task assigned: the panel opens it.
  detail: {
    ...sample,
    persisted: {
      plugin: {
        'redmine.projectByOrcaProject': { 'git:shop': 'shop' },
        'redmine.issueByWorkspace': { 'wt-1': { id: 4077, subject: 'Checkout screen with saved cards' } }
      }
    }
  }
})
