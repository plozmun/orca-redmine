import { assert, test } from 'orca/testing'
import { pickPluginKey, PLUGIN_ID, pluginIdOf } from './plugin-key'

const item = { id: 'open-tasks' }
const redmine = (pluginKey: string, status: string, declares = true) => ({
  pluginKey,
  status,
  statusBarItems: declares ? [item] : []
})

test('the id is the part of a qualified plugin key after the last dot', () => {
  assert.equal(PLUGIN_ID, 'redmine-tasks')
  assert.equal(pluginIdOf('plozmun.redmine-tasks'), 'redmine-tasks')
  assert.equal(pluginIdOf('local.redmine-tasks'), 'redmine-tasks')
  assert.equal(pluginIdOf('redmine-tasks'), 'redmine-tasks')
})

test('finds this plugin among the host listing, catalog or development folder', () => {
  const other = redmine('acme.todos', 'running')
  assert.equal(pickPluginKey([other, redmine('plozmun.redmine-tasks', 'running')], 'open-tasks'), 'plozmun.redmine-tasks')
  assert.equal(pickPluginKey([other, redmine('local.redmine-tasks', 'running')], 'open-tasks'), 'local.redmine-tasks')
  assert.equal(pickPluginKey([other], 'open-tasks'), null)
  assert.equal(pickPluginKey([], 'open-tasks'), null)
})

test('prefers a version that declares the item, so a dev folder next to an older install wins', () => {
  const installed = redmine('plozmun.redmine-tasks', 'running', false)
  const dev = redmine('local.redmine-tasks', 'running')
  assert.equal(pickPluginKey([installed, dev], 'open-tasks'), 'local.redmine-tasks')
  // Both declare it: the first listed.
  const catalog = redmine('plozmun.redmine-tasks', 'running')
  assert.equal(pickPluginKey([catalog, redmine('local.redmine-tasks', 'idle')], 'open-tasks'), 'plozmun.redmine-tasks')
})

test('prefers an entry the person can use, and still answers with a disabled one alone', () => {
  const disabled = redmine('plozmun.redmine-tasks', 'disabled', false)
  const dev = redmine('local.redmine-tasks', 'idle')
  assert.equal(pickPluginKey([disabled, dev], 'open-tasks'), 'local.redmine-tasks')
  assert.equal(pickPluginKey([redmine('plozmun.redmine-tasks', 'pending', false), dev], 'open-tasks'), 'local.redmine-tasks')
  assert.equal(pickPluginKey([disabled], 'open-tasks'), 'plozmun.redmine-tasks')
})
