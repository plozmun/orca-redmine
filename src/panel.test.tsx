// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { storage } from 'orca'
import { assert, hostError, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { Followup } from './followups'
import { localDateDaysAgo } from './days'

const summary = {
  id: 4077,
  subject: 'Checkout screen',
  project: 'Shop',
  projectId: 1,
  tracker: 'Feature',
  status: 'New',
  statusId: 1,
  priority: 'Normal',
  assignee: 'Pablo',
  updatedOn: '2026-11-01T00:00:00Z'
}
const detail = { ...summary, description: 'Integrate **Stripe**', doneRatio: 0, url: 'https://redmine.test/issues/4077', journals: [] }

// Two workspaces of the Orca project "shop" and one of "web".
const located: Record<string, { workspaceKey: string; orcaProjectId: string; orcaProjectName: string }> = {
  'shop-a': { workspaceKey: 'wt-a', orcaProjectId: 'git:shop', orcaProjectName: 'shop' },
  'shop-b': { workspaceKey: 'wt-b', orcaProjectId: 'git:shop', orcaProjectName: 'shop' },
  'web-x': { workspaceKey: 'wt-x', orcaProjectId: 'git:web', orcaProjectName: 'web' },
  'feature/4077-pay': { workspaceKey: 'wt-pay', orcaProjectId: 'git:shop', orcaProjectName: 'shop' }
}

function connectedHost(
  asked: unknown[] = [],
  extra: Record<string, (input: never) => unknown> = {},
  settings: Record<string, string | number> = {},
  storage: Record<string, unknown> = {}
) {
  return mockHost({
    settings,
    storage: storage as never,
    capabilities: ['workspace:read', 'settings:own', 'secrets:own', 'terminal:send', 'storage:own'],
    requests: {
      'redmine.status': () => ({ configured: true, url: 'https://redmine.test', user: { login: 'pablo', name: 'Pablo' } }),
      'redmine.issues': (input) => {
        asked.push(input)
        return { issues: [summary], total: 1 }
      },
      'redmine.issue': () => detail,
      'redmine.timeEntries': () => [
        { id: 9, hours: 1.5, comments: 'Review', spentOn: '2026-11-02', activity: 'Development', user: 'Pablo' }
      ],
      'redmine.statuses': () => [
        { id: 1, name: 'New', isClosed: false },
        { id: 2, name: 'In progress', isClosed: false }
      ],
      'redmine.projects': () => [
        { id: 1, identifier: 'shop', name: 'Shop' },
        { id: 2, identifier: 'web', name: 'Corporate website' },
        { id: 3, identifier: 'alsa', name: '[ALSA] Agentic Commerce Phase 1' }
      ],
      'redmine.locateWorkspace': ({ displayName }) => ({ located: located[displayName] ?? null }),
      'redmine.orcaProjects': () => [
        { id: 'git:shop', name: 'shop' },
        { id: 'git:web', name: 'web' }
      ],
      'redmine.launchWorkspace': (input) => {
        asked.push({ launch: input })
        return { workspaceKey: 'wt-new', displayName: '4077-checkout-screen', branch: 'pablo/4077-checkout-screen', path: '/p', launch: 'terminal', name: '4077-checkout-screen' }
      },
      'redmine.followups.get': () => ({ followups: [] }),
      'redmine.followups.dismiss': () => ({ followups: [] }),
      'redmine.launchHereSupport': () => ({ available: true }),
      ...extra
    }
  })
}

const drawn = (view: { tree(): unknown }, text: string) => JSON.stringify(view.tree()).includes(text)
const ws = (displayName: string, terminals: { id: string; title?: string }[] = []) => ({
  context: { branch: displayName.startsWith('feature/') ? displayName : 'main', displayName, terminals }
})

type View = Awaited<ReturnType<typeof mount>>
/** Text on a SearchPicker's button: the chosen option's label, or the "none" label. */
const pickerValue = (view: View, id: string) => view.find({ testId: `${id}-open` })?.text
async function pick(view: View, id: string, value: string) {
  await view.press({ testId: `${id}-open` })
  await view.press({ testId: `${id}-${value}` })
}
/** Opens "Launch agent" and switches it to the focused workspace. */
async function openHere(view: View, button = 'Launch agent') {
  await view.press({ text: button })
  await view.select({ type: 'RadioGroup' }, 'here')
}
const RP = 'redmine-project'
const PICKER_SEARCH = 'Search: Redmine project for shop'
const OP = 'orca-project'

test('not configured shows the connect form', async () => {
  const host = mockHost({ requests: { 'redmine.status': () => ({ configured: false, url: null, user: null }) } })
  const view = await mount(panel, { host, locale: 'en' })
  assert.ok(view.find({ text: 'Connect to Redmine' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('follows Orca’s language: Spanish UI and translated worker errors', async () => {
  const host = mockHost({
    requests: {
      'redmine.status': () => ({ configured: false, url: 'https://r', user: null, errorCode: 'unauthorized', errorDetail: 'HTTP 401' })
    }
  })
  const view = await mount(panel, { host, locale: 'es-ES' })
  assert.ok(view.find({ text: 'Conectar con Redmine' }))
  assert.ok(view.find({ text: 'API key no válida' }))
  await view.unmount()
})

test('a rejected request shows the translated error code', async () => {
  const host = connectedHost([], {
    'redmine.issues': () => {
      throw hostError('forbidden', 'HTTP 403')
    }
  })
  const view = await mount(panel, { host, locale: 'en' })
  assert.ok(view.find({ text: 'You do not have permission for this action in Redmine' }))
  await view.unmount()
})

test('lists tasks, opens one and sends the prompt to the terminal', async () => {
  const sent: unknown[] = []
  const host = connectedHost([], {
    'redmine.sendToAgent': (input: unknown) => {
      sent.push(input)
      return { accepted: true }
    }
  })
  const view = await mount(panel, { host, locale: 'en' })
  await view.emit('workspace.changed', ws('feature/4077-pay', [{ id: 't1', title: 'claude' }]))
  assert.deepEqual(view.refusals, [])
  assert.ok(view.find({ text: 'Assign #4077 (from branch)' }))

  await view.press({ type: 'ListItem' })
  assert.ok(view.find({ text: 'Checkout screen' }) && view.find({ text: '#4077' }))
  await view.press({ text: 'Send to terminal' })
  await view.press({ text: 'Send prompt' })
  assert.deepEqual(sent, [{ id: 4077, terminalId: 't1', locale: 'en' }])
  assert.ok(view.find({ text: 'Prompt typed into the terminal: review it and press Enter' }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('recommends redmine-cli only when it is not installed', async () => {
  const hint = 'install redmine-cli'
  for (const [version, shown] of [[null, true], ['redmine version 2.14.0', false]] as const) {
    const view = await mount(panel, { host: connectedHost([], { 'redmine.cli': () => ({ version }) }), locale: 'en' })
    await view.emit('workspace.changed', ws('feature/4077-pay', [{ id: 't1' }]))
    await view.press({ type: 'ListItem' })
    assert.equal(drawn(view, hint), shown)
    assert.deepEqual(view.errors, [])
    await view.unmount()
  }
})

test('the Redmine project is set per Orca project and shared by its workspaces', async () => {
  const asked: unknown[] = []
  const view = await mount(panel, { host: connectedHost(asked), locale: 'en' })
  await view.emit('workspace.changed', ws('shop-a'))
  assert.equal(pickerValue(view, RP), 'No project (all)')

  await pick(view, RP, 'shop')
  assert.deepEqual(asked.at(-1), { mine: true, search: '', projectId: 'shop' })

  // Another workspace of the same Orca project: same Redmine project.
  await view.emit('workspace.changed', ws('shop-b'))
  assert.equal(pickerValue(view, RP), 'Shop')
  assert.deepEqual(asked.at(-1), { mine: true, search: '', projectId: 'shop' })

  // A workspace of another, unconfigured Orca project inherits nothing.
  await view.emit('workspace.changed', ws('web-x'))
  assert.equal(pickerValue(view, RP), 'No project (all)')
  assert.deepEqual(asked.at(-1), { mine: true, search: '' })

  // Remove the "shop" setting.
  await view.emit('workspace.changed', ws('shop-a'))
  await view.press({ label: 'Remove project' })
  assert.equal(pickerValue(view, RP), 'No project (all)')
  assert.deepEqual(view.persisted.storage['links.projectByOrcaProject'], {})
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('each workspace can have one task assigned, or none', async () => {
  const view = await mount(panel, { host: connectedHost(), locale: 'en' })
  await view.emit('workspace.changed', ws('shop-a'))
  assert.ok(view.find({ type: 'ListItem' }))

  await view.press({ type: 'ListItem' })
  await view.press({ text: 'Assign to this workspace' })
  assert.ok(view.find({ text: 'Task of this workspace' }))
  assert.deepEqual(view.persisted.storage['links.issueByWorkspace'], { 'wt-a': { id: 4077, subject: 'Checkout screen' } })

  // The other workspace of the same project has no task: switching to it leaves the detail.
  await view.emit('workspace.changed', ws('shop-b'))
  assert.equal(view.find({ text: 'Task of this workspace' }), null)
  assert.ok(view.find({ type: 'ListItem' }))

  // Back to the first workspace: its task opens by itself.
  await view.emit('workspace.changed', ws('shop-a'))
  assert.ok(view.find({ text: 'Task of this workspace' }))

  // Unassign from the detail.
  await view.press({ text: 'Unassign' })
  assert.deepEqual(view.persisted.storage['links.issueByWorkspace'], {})
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('the project picker searches ignoring accents and case', async () => {
  const view = await mount(panel, { host: connectedHost(), locale: 'en' })
  await view.emit('workspace.changed', ws('shop-a'))
  await view.press({ testId: `${RP}-open` })
  // Open with no search: "none" plus every project.
  assert.ok(view.find({ testId: `${RP}-none` }))
  assert.ok(view.find({ text: '3 results' }))

  await view.type({ label: PICKER_SEARCH }, 'ALSA')
  assert.ok(view.find({ testId: `${RP}-alsa` }))
  assert.equal(view.find({ testId: `${RP}-web` }), null)
  assert.equal(view.find({ testId: `${RP}-none` }), null)

  await view.type({ label: PICKER_SEARCH }, 'corporáte', { replace: true })
  assert.ok(view.find({ text: '1 results' }))
  // Enter picks the first match and closes the picker.
  await view.submit({ label: PICKER_SEARCH })
  assert.equal(pickerValue(view, RP), 'Corporate website')
  assert.equal(view.find({ label: PICKER_SEARCH }), null)

  // Cancel closes without changing anything.
  await view.press({ testId: `${RP}-open` })
  await view.type({ label: PICKER_SEARCH }, 'zzz')
  assert.ok(view.find({ text: 'No matches' }))
  await view.press({ text: 'Cancel' })
  assert.equal(pickerValue(view, RP), 'Corporate website')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('without an identified Orca project there is nothing to configure or assign', async () => {
  const view = await mount(panel, { host: connectedHost(), locale: 'en' })
  await view.emit('workspace.changed', ws('unknown'))
  assert.ok(drawn(view, 'Could not identify the Orca project'))
  assert.equal(view.find({ testId: `${RP}-open` }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('launches the agent in a new workspace and assigns it the task', async () => {
  const asked: unknown[] = []
  const view = await mount(panel, { host: connectedHost(asked), locale: 'en' })
  await view.emit('workspace.changed', ws('web-x'))
  await view.press({ type: 'ListItem' })
  await view.press({ text: 'Launch agent' })
  // With no project mapping, it suggests the focused workspace's Orca project.
  assert.equal(pickerValue(view, OP), 'web')
  assert.ok(view.find({ text: 'Workspace and branch: 4077-checkout-screen (with Orca’s branch prefix)' }))

  await pick(view, OP, 'git:shop')
  await view.type({ label: 'Base branch' }, 'develop')
  await view.press({ text: 'Create workspace and launch agent' })
  assert.deepEqual(asked.at(-1), {
    launch: {
      issueId: 4077,
      orcaProjectId: 'git:shop',
      agent: 'claude',
      instructions: 'Work on Redmine task #4077 "Checkout screen": https://redmine.test/issues/4077',
      activate: true,
      locale: 'en',
      comments: 'recent',
      baseBranch: 'develop'
    }
  })
  assert.deepEqual(view.persisted.storage['links.issueByWorkspace'], { 'wt-new': { id: 4077, subject: 'Checkout screen' } })
  assert.ok(view.find({ text: 'Workspace “4077-checkout-screen” created on branch pablo/4077-checkout-screen. Claude Code launched. Task assigned.' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('suggests the Orca project mapped to the task’s Redmine project', async () => {
  const view = await mount(panel, { host: connectedHost(), locale: 'en' })
  await view.emit('workspace.changed', ws('shop-a'))
  await pick(view, RP, 'shop')
  await view.emit('workspace.changed', ws('web-x'))
  await view.press({ type: 'ListItem' })
  await view.press({ text: 'Launch agent' })
  assert.equal(pickerValue(view, OP), 'shop')
  await view.unmount()
})

test('launches the agent in the focused workspace and assigns it the task when it has none', async () => {
  const asked: unknown[] = []
  const view = await mount(panel, {
    host: connectedHost(asked, {
      'redmine.launchHere': (input) => {
        asked.push({ here: input })
        return { terminalId: 't9', workspaceKey: 'wt-a' }
      }
    }),
    locale: 'en'
  })
  await view.emit('workspace.changed', ws('shop-a', [{ id: 't1', title: 'claude' }]))
  await view.press({ type: 'ListItem' })
  await openHere(view)
  await view.press({ text: 'Launch agent here' })
  assert.deepEqual(asked.at(-1), {
    here: {
      issueId: 4077,
      agent: 'claude',
      instructions: 'Work on Redmine task #4077 "Checkout screen": https://redmine.test/issues/4077',
      locale: 'en',
      comments: 'recent'
    }
  })
  assert.deepEqual(view.persisted.storage['links.issueByWorkspace'], { 'wt-a': { id: 4077, subject: 'Checkout screen' } })
  assert.ok(view.find({ text: 'Claude Code started in this workspace. Task assigned.' }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('launching here keeps a task the workspace already has', async () => {
  const view = await mount(panel, {
    host: connectedHost(
      [],
      { 'redmine.launchHere': () => ({ terminalId: 't9', workspaceKey: 'wt-a' }) },
      {},
      { 'links.issueByWorkspace': { 'wt-a': { id: 4081, subject: 'Mobile pass' } } }
    ),
    locale: 'en'
  })
  await view.emit('workspace.changed', ws('shop-a', [{ id: 't1' }]))
  await view.settled()
  // The workspace's task opens; go back to the list and open another one.
  assert.ok(view.find({ text: '← Back' }))
  await view.press({ text: '← Back' })
  await view.press({ type: 'ListItem' })
  await openHere(view)
  await view.press({ text: 'Launch agent here' })
  assert.deepEqual(view.persisted.storage['links.issueByWorkspace'], { 'wt-a': { id: 4081, subject: 'Mobile pass' } })
  assert.ok(view.find({ text: 'Claude Code started in this workspace.' }))
  assert.ok(!drawn(view, 'Task assigned.'))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('launch here is disabled without a focused workspace and when this Orca cannot start agents', async () => {
  // The open form and its "where" are kept, as the `launchHere` check scenario relies on.
  let view = await mount(panel, {
    host: connectedHost(),
    locale: 'en',
    persisted: { plugin: { 'redmine.agentSheet': 'launch', 'redmine.launchWhere': 'here' } }
  })
  await view.press({ type: 'ListItem' })
  assert.equal(view.find({ text: 'Launch agent here' })?.disabled, true)
  assert.ok(drawn(view, 'Open a workspace to launch the agent in it.'))
  assert.deepEqual(view.errors, [])
  await view.unmount()

  view = await mount(panel, {
    host: connectedHost([], { 'redmine.launchHereSupport': () => ({ available: false }) }),
    locale: 'en'
  })
  await view.emit('workspace.changed', ws('shop-a', [{ id: 't1' }]))
  await view.press({ type: 'ListItem' })
  await openHere(view)
  assert.equal(view.find({ text: 'Launch agent here' })?.disabled, true)
  assert.ok(drawn(view, 'This Orca version cannot launch agents in a workspace: update Orca.'))
  await view.unmount()
})

test('a failed launch here shows the translated error and assigns nothing', async () => {
  const view = await mount(panel, {
    host: connectedHost([], {
      'redmine.launchHere': () => {
        throw hostError('capability_denied', 'agent.launch needs the agent:launch capability')
      }
    }),
    locale: 'es-ES'
  })
  await view.emit('workspace.changed', ws('shop-a', [{ id: 't1' }]))
  await view.press({ type: 'ListItem' })
  await openHere(view, 'Lanzar agente')
  await view.press({ text: 'Lanzar agente aquí' })
  assert.ok(view.find({ text: 'Orca no dejó al plugin lanzar agentes: aprueba sus permisos' }))
  assert.deepEqual(view.persisted.storage['links.issueByWorkspace'], {})
  await view.unmount()
})

test('instructions and comments start from the plugin settings and can be changed per launch', async () => {
  const asked: unknown[] = []
  const host = connectedHost(asked, {}, { launchInstructions: 'Fix #{id} in {project}', contextComments: 'all' })
  const view = await mount(panel, { host, locale: 'en' })
  await view.emit('workspace.changed', ws('shop-a'))
  await view.press({ type: 'ListItem' })
  await view.press({ text: 'Launch agent' })
  assert.equal(view.valueOf({ label: 'Instructions for the agent' }), 'Fix #4077 in Shop')
  assert.equal(view.valueOf({ type: 'Select', label: 'Comments in the context' }), 'all')

  await view.select({ type: 'Select', label: 'Comments in the context' }, 'none')
  await view.press({ text: 'Create workspace and launch agent' })
  const launch = (asked.at(-1) as { launch: { instructions: string; comments: string } }).launch
  assert.equal(launch.instructions, 'Fix #4077 in Shop')
  assert.equal(launch.comments, 'none')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('with the URL already in Settings, the connect form only asks for the API key', async () => {
  const configured: unknown[] = []
  const host = mockHost({
    requests: {
      'redmine.status': () => ({ configured: false, url: 'https://redmine.test', user: null }),
      'redmine.configure': (input: unknown) => {
        configured.push(input)
        return { configured: false, url: 'https://redmine.test', user: null }
      }
    }
  })
  const view = await mount(panel, { host, locale: 'en' })
  assert.ok(view.find({ text: 'Redmine: https://redmine.test' }))
  assert.equal(view.find({ label: 'Redmine URL' }), null)
  await view.type({ label: 'API key' }, 'KEY')
  await view.press({ text: 'Connect' })
  assert.deepEqual(configured, [{ url: 'https://redmine.test', apiKey: 'KEY' }])

  await view.press({ text: 'Change URL' })
  assert.equal(view.valueOf({ label: 'Redmine URL' }), 'https://redmine.test')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('switching workspaces fast shows the latest workspace’s task', async () => {
  const view = await mount(panel, {
    host: connectedHost([], {
      // Task 1 answers after task 2, as a slow request would.
      'redmine.issue': (({ id }: { id: number }) =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ ...detail, id, subject: `Task ${id}` }), id === 1 ? 40 : 0)
        )) as never
    }),
    locale: 'en',
    persisted: {
      plugin: {
        'redmine.issueByWorkspace': { 'wt-a': { id: 1, subject: 'Task 1' }, 'wt-b': { id: 2, subject: 'Task 2' } }
      }
    }
  })
  await Promise.all([view.emit('workspace.changed', ws('shop-a')), view.emit('workspace.changed', ws('shop-b'))])
  await view.settled()
  assert.ok(drawn(view, 'Task 2'))
  assert.equal(drawn(view, 'Task 1'), false)
  await view.unmount()
})

test('the list can be filtered by status, and the choice is kept', async () => {
  const asked: unknown[] = []
  const view = await mount(panel, { host: connectedHost(asked), locale: 'en' })
  await view.emit('workspace.changed', ws('shop-a'))
  assert.equal(pickerValue(view, 'status-filter'), 'Open')
  assert.deepEqual(asked.at(-1), { mine: true, search: '' })

  await pick(view, 'status-filter', '2')
  assert.equal(pickerValue(view, 'status-filter'), 'In progress')
  assert.deepEqual(asked.at(-1), { mine: true, status: '2', search: '' })
  assert.equal(view.persisted.plugin['redmine.statusFilter'], '2')

  await pick(view, 'status-filter', 'closed')
  assert.deepEqual(asked.at(-1), { mine: true, status: 'closed', search: '' })

  await view.press({ label: 'Show open tasks' })
  assert.deepEqual(asked.at(-1), { mine: true, search: '' })
  await view.unmount()
})

test('the detail has tabs: description first, then comments with the reply box', async () => {
  const asked: unknown[] = []
  const withComments = {
    ...detail,
    journals: [{ id: 1, author: 'Luis', createdOn: '2026-11-01T10:00:00Z', notes: 'Design ready' }]
  }
  const view = await mount(panel, {
    host: connectedHost(asked, {
      'redmine.issue': (() => withComments) as never,
      'redmine.comment': ((input: unknown) => {
        asked.push({ comment: input })
        return withComments
      }) as never
    }),
    locale: 'en'
  })
  await view.press({ type: 'ListItem' })
  assert.equal(view.valueOf({ type: 'Tabs' }), 'description')
  assert.ok(drawn(view, 'Integrate **Stripe**'))

  await view.select({ type: 'Tabs' }, 'activity')
  assert.ok(drawn(view, 'Design ready'))
  await view.type({ label: 'Comment' }, 'Merged in !42')
  await view.press({ text: 'Add comment' })
  assert.deepEqual(asked.at(-1), { comment: { id: 4077, notes: 'Merged in !42' } })
  assert.ok(view.find({ text: 'Comment added' }))
  await view.unmount()
})

test('the Time tab lists my entries with their total and logs new time', async () => {
  const asked: unknown[] = []
  const view = await mount(panel, {
    host: connectedHost(asked, {
      'redmine.logTime': ((input: unknown) => {
        asked.push({ logTime: input })
        return { timeEntryId: 10 }
      }) as never
    }),
    locale: 'en'
  })
  await view.press({ type: 'ListItem' })
  await view.select({ type: 'Tabs' }, 'time')
  assert.ok(drawn(view, 'Review'))
  assert.ok(drawn(view, '1.5 h'))
  await view.type({ label: 'Hours' }, '2,5')
  await view.type({ label: 'Comment' }, 'Checkout API')
  await view.press({ text: 'Log' })
  assert.deepEqual(asked.at(-1), { logTime: { id: 4077, hours: 2.5, comments: 'Checkout API', spentOn: localDateDaysAgo(0) } })
  assert.ok(view.find({ text: '2.5 h logged on #4077' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('time can go to an earlier day, picked from the last week or typed, never a future one', async () => {
  const asked: unknown[] = []
  const view = await mount(panel, {
    host: connectedHost(asked, {
      'redmine.logTime': ((input: unknown) => {
        asked.push({ logTime: input })
        return { timeEntryId: 11 }
      }) as never
    }),
    locale: 'en'
  })
  await view.press({ type: 'ListItem' })
  await view.select({ type: 'Tabs' }, 'time')
  await view.type({ label: 'Hours' }, '1')
  await view.select({ label: 'Day' }, localDateDaysAgo(1))
  await view.press({ text: 'Log' })
  assert.deepEqual(asked.at(-1), { logTime: { id: 4077, hours: 1, comments: '', spentOn: localDateDaysAgo(1) } })

  // Another day: typed, and the button waits for a real day that is not in the future.
  await view.type({ label: 'Hours' }, '3')
  await view.select({ label: 'Day' }, 'other')
  await view.type({ label: 'Date (YYYY-MM-DD)' }, localDateDaysAgo(-1))
  assert.equal(view.find({ text: 'Log' })?.disabled, true)
  await view.type({ label: 'Date (YYYY-MM-DD)' }, localDateDaysAgo(30), { replace: true })
  await view.press({ text: 'Log' })
  assert.deepEqual(asked.at(-1), { logTime: { id: 4077, hours: 3, comments: '', spentOn: localDateDaysAgo(30) } })
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('the list shows my open, overdue and urgent counts, and the worker keeps them current', async () => {
  const view = await mount(panel, {
    host: connectedHost([], { 'redmine.counts': () => ({ total: 7, overdue: 0, urgent: 2 }) }),
    locale: 'en'
  })
  assert.ok(view.find({ text: 'OPEN' }) && drawn(view, '"7"'))
  assert.ok(view.find({ text: 'URGENT' }))
  view.post('redmine.countsChanged', { total: 8, overdue: 1, urgent: 2 })
  await view.settled()
  assert.ok(drawn(view, '"8"'))
  // Mine or everyone's: the list asks again.
  await view.select({ type: 'RadioGroup' }, 'all')
  assert.equal(view.persisted.plugin['redmine.onlyMine'], false)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('disconnecting asks first and only the confirm button deletes the connection', async () => {
  let disconnects = 0
  const view = await mount(panel, {
    host: connectedHost([], {
      'redmine.disconnect': () => {
        disconnects++
        return { configured: false, url: 'https://redmine.test', user: null }
      }
    }),
    locale: 'en'
  })
  assert.ok(!drawn(view, 'Disconnect from Redmine?'))

  // The header button only opens the confirmation.
  await view.press({ label: 'Redmine connection' })
  assert.equal(disconnects, 0)
  assert.ok(drawn(view, 'Disconnect from Redmine?'))
  assert.ok(drawn(view, 'https://redmine.test as Pablo'))

  // Cancel closes it without disconnecting; pressing the header again toggles it.
  await view.press({ testId: 'disconnect-cancel' })
  assert.ok(!drawn(view, 'Disconnect from Redmine?'))
  await view.press({ label: 'Redmine connection' })
  await view.press({ label: 'Redmine connection' })
  assert.ok(!drawn(view, 'Disconnect from Redmine?'))
  assert.equal(disconnects, 0)

  await view.press({ label: 'Redmine connection' })
  await view.press({ testId: 'disconnect-confirm' })
  assert.equal(disconnects, 1)
  assert.ok(view.find({ text: 'Connect to Redmine' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a workspace found without its Orca project still links tasks and says why the project is unknown', async () => {
  const host = connectedHost([], {
    'redmine.locateWorkspace': () => ({
      located: { workspaceKey: 'wt-pay', orcaProjectId: null, orcaProjectName: null },
      errorCode: 'orca_cli',
      errorDetail: 'spawn orca ENOENT'
    })
  })
  const view = await mount(panel, { host, locale: 'en' })
  await view.emit('workspace.changed', ws('feature/4077-pay'))
  assert.ok(drawn(view, 'Could not identify the Orca project: Could not run the Orca CLI (spawn orca ENOENT)'))
  assert.ok(!drawn(view, 'Redmine project for'))
  await view.press({ text: 'Assign #4077 (from branch)' })
  assert.deepEqual(view.persisted.storage['links.issueByWorkspace'], { 'wt-pay': { id: 4077, subject: 'Checkout screen' } })
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('0.1.x links move once into the storage shared with the worker', async () => {
  const legacy = {
    plugin: {
      'redmine.issueByWorkspace': { 'wt-a': { id: 4077, subject: 'Checkout screen' }, 'wt-b': { id: 9, subject: 'Old' } },
      'redmine.projectByOrcaProject': { 'git:shop': 'shop' }
    }
  }
  // Storage already has a link for wt-b (made by the worker): it wins.
  const host = connectedHost([], {}, {}, { 'links.issueByWorkspace': { 'wt-b': { id: 10, subject: 'New' } } })
  let view = await mount(panel, { host, locale: 'en', persisted: legacy })
  assert.deepEqual(view.persisted.storage['links.issueByWorkspace'], {
    'wt-a': { id: 4077, subject: 'Checkout screen' },
    'wt-b': { id: 10, subject: 'New' }
  })
  assert.deepEqual(view.persisted.storage['links.projectByOrcaProject'], { 'git:shop': 'shop' })
  assert.equal(view.persisted.storage['links.migrated'], true)
  // The old copy stays for a downgrade.
  assert.deepEqual(view.persisted.plugin['redmine.projectByOrcaProject'], { 'git:shop': 'shop' })

  // Once migrated, an unlink is not undone by the old copy.
  await view.emit('workspace.changed', ws('shop-a'))
  await view.press({ text: 'Unassign' })
  assert.equal((view.persisted.storage['links.issueByWorkspace'] as Record<string, unknown>)['wt-a'], undefined)
  await view.unmount()
  view = await mount(panel, { host, locale: 'en', persisted: legacy })
  assert.equal((view.persisted.storage['links.issueByWorkspace'] as Record<string, unknown>)['wt-a'], undefined)
  await view.unmount()
})

test('a link the worker makes for the focused workspace opens its task', async () => {
  const host = connectedHost()
  const view = await mount(panel, { host, locale: 'en' })
  await view.emit('workspace.changed', ws('shop-a'))
  assert.ok(!drawn(view, 'Integrate'))
  // As the worker does when it links a new workspace: a write to the shared storage.
  await storage.set('links.issueByWorkspace', { 'wt-a': { id: 4077, subject: 'Checkout screen' } })
  await view.settled()
  assert.ok(drawn(view, 'Integrate'))
  await view.unmount()
})

// --- Follow-ups ---

const followupAt = Date.parse('2026-11-03T08:00:00Z')
const agentDone: Followup = {
  id: 'agentDone:4077:1',
  kind: 'agentDone',
  issueId: 4077,
  workspaceName: '4077-checkout',
  at: followupAt,
  hours: 1.25
}
const workspaceRemoved: Followup = {
  id: 'workspaceRemoved:4077:2',
  kind: 'workspaceRemoved',
  issueId: 4077,
  workspaceName: '4077-checkout',
  at: followupAt + 1000
}

/** Redmine write calls a test records, so it can prove nothing happens without a click. */
function recordingWrites(writes: unknown[]) {
  return {
    'redmine.comment': ((input: unknown) => {
      writes.push({ comment: input })
      return detail
    }) as never,
    'redmine.setStatus': ((input: unknown) => {
      writes.push({ status: input })
      return detail
    }) as never,
    'redmine.logTime': ((input: unknown) => {
      writes.push({ time: input })
      return { timeEntryId: 10 }
    }) as never
  }
}

/** A host holding follow-ups, whose dismiss actually removes one and records the call. */
function followupHost(list: Followup[], writes: unknown[], dismissed: string[] = [], extra: Record<string, (input: never) => unknown> = {}) {
  let current = list
  return connectedHost([], {
    ...recordingWrites(writes),
    'redmine.followups.get': (() => ({ followups: current })) as never,
    'redmine.followups.dismiss': (({ id }: { id: string }) => {
      dismissed.push(id)
      current = current.filter((f) => f.id !== id)
      return { followups: current }
    }) as never,
    ...extra
  })
}

test('a pending agent follow-up shows what happened and opens its task without writing anything', async () => {
  const writes: unknown[] = []
  const view = await mount(panel, { host: followupHost([agentDone], writes), locale: 'en' })
  assert.ok(view.find({ text: 'Agent finished on #4077' }))
  assert.ok(view.find({ text: 'Workspace “4077-checkout”' }))
  assert.ok(view.find({ text: 'Your agent worked about 1.25 h' }))
  assert.deepEqual(writes, [])

  await view.press({ text: 'Open task' })
  assert.ok(view.find({ text: 'Checkout screen' }))
  assert.deepEqual(writes, [], 'opening the task is not a write')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('commenting from a follow-up writes the comment and dismisses it', async () => {
  const writes: unknown[] = []
  const dismissed: string[] = []
  const view = await mount(panel, {
    host: followupHost([agentDone], writes, dismissed, { 'redmine.issues': (() => ({ issues: [summary], total: 1 })) as never }),
    locale: 'en'
  })
  assert.deepEqual(writes, [])

  await view.press({ text: 'Comment' })
  await view.type({ label: 'Comment' }, 'Merged in !42')
  await view.press({ text: 'Add comment' })
  assert.deepEqual(writes, [{ comment: { id: 4077, notes: 'Merged in !42' } }])
  assert.deepEqual(dismissed, [agentDone.id])
  assert.equal(view.find({ text: 'Agent finished on #4077' }), null)
  assert.ok(view.find({ text: 'Comment added' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('logging time from a follow-up is pre-filled with the agent working time and dismisses it', async () => {
  const writes: unknown[] = []
  const dismissed: string[] = []
  const view = await mount(panel, { host: followupHost([agentDone], writes, dismissed), locale: 'en' })

  await view.press({ text: 'Log time' })
  assert.equal(view.valueOf({ label: 'Hours' }), '1.25')
  await view.press({ text: 'Save time' })
  assert.deepEqual(writes, [{ time: { id: 4077, hours: 1.25, comments: '', spentOn: localDateDaysAgo(0) } }])
  assert.deepEqual(dismissed, [agentDone.id])
  assert.equal(view.find({ text: 'Agent finished on #4077' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('close task on a removed workspace offers only closed statuses, then dismisses', async () => {
  const writes: unknown[] = []
  const dismissed: string[] = []
  const view = await mount(panel, {
    host: followupHost([workspaceRemoved], writes, dismissed, {
      'redmine.statuses': (() => [
        { id: 1, name: 'New', isClosed: false },
        { id: 2, name: 'In progress', isClosed: false },
        { id: 5, name: 'Closed', isClosed: true }
      ]) as never
    }),
    locale: 'en'
  })
  assert.ok(view.find({ text: 'Workspace removed: close #4077?' }))

  await view.press({ text: 'Close task' })
  assert.equal(view.valueOf({ type: 'Select', label: 'Status' }), '5')
  assert.ok(drawn(view, '"label":"Closed"'))
  assert.equal(drawn(view, 'In progress'), false)

  await view.press({ text: 'Close it' })
  assert.deepEqual(writes, [{ status: { id: 4077, statusId: 5 } }])
  assert.deepEqual(dismissed, [workspaceRemoved.id])
  assert.equal(view.find({ text: 'Workspace removed: close #4077?' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a follow-up can be dismissed without acting on Redmine', async () => {
  const writes: unknown[] = []
  const dismissed: string[] = []
  const view = await mount(panel, { host: followupHost([agentDone, workspaceRemoved], writes, dismissed), locale: 'en' })
  assert.ok(view.find({ text: 'Agent finished on #4077' }))
  assert.ok(view.find({ text: 'Workspace removed: close #4077?' }))

  // Press the first card's Dismiss: it goes away, the other one stays.
  const dismissButtons = view.findAll({ text: 'Dismiss' })
  assert.equal(dismissButtons.length, 2)
  await view.press({ text: 'Dismiss' })
  assert.deepEqual(writes, [])
  assert.equal(view.find({ text: 'Agent finished on #4077' }), null)
  assert.ok(view.find({ text: 'Workspace removed: close #4077?' }))
  assert.equal(dismissed.length, 1)
  await view.unmount()
})

test('the panel shows a follow-up the worker records while it is open, without closing it', async () => {
  const view = await mount(panel, { host: connectedHost(), locale: 'en' })
  assert.equal(view.find({ text: 'Agent finished on #4077' }), null)
  view.post('redmine.followupsChanged', { followups: [agentDone] })
  await view.settled()
  assert.ok(view.find({ text: 'Agent finished on #4077' }))
  await view.unmount()
})
