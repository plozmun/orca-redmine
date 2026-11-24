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
  capabilities: ['workspace:read', 'workspace:write', 'workspace:create', 'settings:own', 'secrets:own', 'terminal:send', 'storage:own', 'agent:launch'],
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
    'redmine.orcaProjects': () => [{ id: 'git:shop', name: 'shop' }],
    'redmine.launchHereSupport': () => ({ available: true }),
    'redmine.openWorkspaceSupport': () => ({ available: true }),
    'redmine.counts': () => ({ total: 12, overdue: 2, urgent: 1 }),
    'redmine.agentStates': () => ({ '4077': 'working', '4081': 'permission' }),
    'redmine.agentActionsSupport': () => ({ show: true, resume: true }),
    'redmine.taskAgents': () => ({ workspaces: [] })
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
  },
  // Pending follow-ups: an agent that finished, and a linked workspace that was removed.
  followups: {
    ...sample,
    requests: {
      ...sample.requests,
      'redmine.followups.get': () => ({
        followups: [
          {
            id: 'agentDone:4077:1',
            kind: 'agentDone' as const,
            issueId: 4077,
            workspaceName: '4077-checkout-screen',
            at: Date.parse('2026-11-03T07:30:00Z'),
            hours: 1.25
          },
          {
            id: 'workspaceRemoved:4081:2',
            kind: 'workspaceRemoved' as const,
            issueId: 4081,
            workspaceName: '4081-ios-pass',
            at: Date.parse('2026-11-03T07:00:00Z')
          }
        ]
      })
    },
    persisted: { plugin: { 'redmine.projectByOrcaProject': { 'git:shop': 'shop' } } }
  },
  // The same task with "Launch agent here" open: the button, its disabled states and its hints.
  launchHere: {
    ...sample,
    persisted: {
      plugin: {
        'redmine.projectByOrcaProject': { 'git:shop': 'shop' },
        'redmine.issueByWorkspace': { 'wt-1': { id: 4077, subject: 'Checkout screen with saved cards' } },
        'redmine.agentSheet': 'launch',
        'redmine.launchWhere': 'here'
      }
    }
  },
  // The status bar item the worker keeps up to date (`orca plugin shot . --scenario statusBar
  // --status-bar`). Redmine itself is unreachable here, so the item draws its warning state: the
  // count needs a live Redmine, which `check` never asks for.
  statusBar: {
    ...sample,
    settings: { url: 'http://127.0.0.1:9', statusBar: true, statusBarMinutes: 5 },
    secrets: { apiKey: 'x' }
  },
  // The task linked to the focused workspace, with "Rename workspace" offered (host API 1.5).
  rename: {
    ...sample,
    requests: {
      ...sample.requests,
      'redmine.renameWorkspaceSupport': () => ({ available: true })
    },
    persisted: {
      plugin: {
        'redmine.projectByOrcaProject': { 'git:shop': 'shop' },
        'redmine.issueByWorkspace': { 'wt-1': { id: 4077, subject: 'Checkout screen with saved cards' } }
      }
    }
  },
  // The detail of a linked task with agents in its linked workspaces: each row and its "Show".
  'detail-agents': {
    ...sample,
    requests: {
      ...sample.requests,
      'redmine.taskAgents': () => ({
        workspaces: [
          {
            key: 'wt-1',
            name: '4077-checkout-screen',
            agents: [
              {
                terminalId: 't1',
                title: 'Claude Code',
                agent: 'claude',
                state: 'working' as const,
                stateStartedAt: Date.parse('2026-11-03T07:00:00Z')
              },
              {
                terminalId: 't2',
                title: 'Codex',
                agent: 'codex',
                state: 'blocked' as const,
                stateStartedAt: Date.parse('2026-11-03T07:20:00Z')
              }
            ]
          },
          {
            key: 'wt-2',
            name: '4077-api',
            agents: [
              {
                terminalId: null,
                title: null,
                agent: 'gemini',
                state: 'done' as const,
                stateStartedAt: Date.parse('2026-11-03T06:00:00Z')
              }
            ]
          }
        ]
      })
    },
    persisted: {
      plugin: {
        'redmine.projectByOrcaProject': { 'git:shop': 'shop' },
        'redmine.issueByWorkspace': { 'wt-1': { id: 4077, subject: 'Checkout screen with saved cards' } }
      }
    }
  },
  // A finished agent's follow-up that knows its workspace, kind and session: it offers "Resume agent".
  'followup-resume': {
    ...sample,
    requests: {
      ...sample.requests,
      'redmine.followups.get': () => ({
        followups: [
          {
            id: 'agentDone:4077:1',
            kind: 'agentDone' as const,
            issueId: 4077,
            workspaceName: '4077-checkout-screen',
            at: Date.parse('2026-11-03T07:30:00Z'),
            hours: 1.25,
            workspaceId: 'identity:wt-1',
            agent: 'claude',
            sessionId: 'session-abc'
          }
        ]
      })
    },
    persisted: { plugin: { 'redmine.projectByOrcaProject': { 'git:shop': 'shop' } } }
  },
  // "Go to workspace": the task is also linked to a workspace other than the focused one, from the
  // task detail and from an agent follow-up.
  openWorkspace: {
    ...sample,
    requests: {
      ...sample.requests,
      'redmine.followups.get': () => ({
        followups: [
          {
            id: 'agentDone:4077:3',
            kind: 'agentDone' as const,
            issueId: 4077,
            workspaceName: '4077-checkout-screen',
            at: Date.parse('2026-11-03T07:30:00Z')
          }
        ]
      })
    },
    persisted: {
      plugin: {
        'redmine.projectByOrcaProject': { 'git:shop': 'shop' },
        'redmine.issueByWorkspace': {
          'wt-1': { id: 4077, subject: 'Checkout screen with saved cards' },
          'wt-2': { id: 4077, subject: 'Checkout screen with saved cards' }
        }
      }
    }
  }
})
