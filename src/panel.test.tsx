// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, hostError, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'

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
  settings: Record<string, string | number> = {}
) {
  return mockHost({
    settings,
    capabilities: ['workspace:read', 'settings:own', 'secrets:own', 'terminal:send'],
    requests: {
      'redmine.status': () => ({ configured: true, url: 'https://redmine.test', user: { login: 'pablo', name: 'Pablo' } }),
      'redmine.issues': (input) => {
        asked.push(input)
        return { issues: [summary], total: 1 }
      },
      'redmine.issue': () => detail,
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
  assert.ok(view.find({ text: '#4077 Checkout screen' }))
  await view.toggle({ type: 'Collapsible', label: 'Send to agent' })
  await view.press({ text: 'Send prompt' })
  assert.deepEqual(sent, [{ id: 4077, terminalId: 't1', locale: 'en' }])
  assert.ok(view.find({ text: 'Prompt typed into the terminal: review it and press Enter' }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('the Redmine project is set per Orca project and shared by its workspaces', async () => {
  const asked: unknown[] = []
  const view = await mount(panel, { host: connectedHost(asked), locale: 'en' })
  await view.emit('workspace.changed', ws('shop-a'))
  assert.equal(pickerValue(view, RP), 'No project (all)')
  assert.ok(drawn(view, 'Orca project: shop'))

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
  assert.deepEqual(view.persisted.plugin['redmine.projectByOrcaProject'], {})
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('each workspace can have one task assigned, or none', async () => {
  const view = await mount(panel, { host: connectedHost(), locale: 'en' })
  await view.emit('workspace.changed', ws('shop-a'))
  assert.ok(view.find({ text: 'No task assigned. Open a task and press “Assign to this workspace”.' }))

  await view.press({ type: 'ListItem' })
  await view.press({ text: 'Assign to this workspace' })
  assert.ok(view.find({ text: 'Task of this workspace' }))
  assert.deepEqual(view.persisted.plugin['redmine.issueByWorkspace'], { 'wt-a': { id: 4077, subject: 'Checkout screen' } })

  // The other workspace of the same project has no task.
  await view.press({ text: '← Back' })
  await view.emit('workspace.changed', ws('shop-b'))
  assert.ok(view.find({ text: 'No task assigned. Open a task and press “Assign to this workspace”.' }))

  // Back again, then unassign.
  await view.emit('workspace.changed', ws('shop-a'))
  assert.ok(view.find({ text: '#4077 Checkout screen' }))
  await view.press({ label: 'Unassign task' })
  assert.deepEqual(view.persisted.plugin['redmine.issueByWorkspace'], {})
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
  await view.toggle({ type: 'Collapsible', label: 'Launch agent in a new workspace' })
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
      instructions: 'Complete Redmine task #4077 "Checkout screen": https://redmine.test/issues/4077',
      activate: true,
      locale: 'en',
      comments: 'recent',
      baseBranch: 'develop'
    }
  })
  assert.deepEqual(view.persisted.plugin['redmine.issueByWorkspace'], { 'wt-new': { id: 4077, subject: 'Checkout screen' } })
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
  await view.toggle({ type: 'Collapsible', label: 'Launch agent in a new workspace' })
  assert.equal(pickerValue(view, OP), 'shop')
  await view.unmount()
})

test('instructions and comments start from the plugin settings and can be changed per launch', async () => {
  const asked: unknown[] = []
  const host = connectedHost(asked, {}, { launchInstructions: 'Fix #{id} in {project}', contextComments: 'all' })
  const view = await mount(panel, { host, locale: 'en' })
  await view.emit('workspace.changed', ws('shop-a'))
  await view.press({ type: 'ListItem' })
  await view.toggle({ type: 'Collapsible', label: 'Launch agent in a new workspace' })
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
