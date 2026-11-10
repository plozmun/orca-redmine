import { assert, test } from 'orca/testing'
import { branchFromTemplate, taskRef, taskRefFromWorkspace } from './task-ref'

test('task numbers in names and branches', () => {
  assert.equal(taskRef('feature/12345-login'), 12345)
  assert.equal(taskRef('refs/heads/pablo/4077-checkout'), 4077)
  assert.equal(taskRef('4077_fix'), 4077)
  assert.equal(taskRef('4077 checkout'), 4077)
  assert.equal(taskRef('4077'), 4077)
  assert.equal(taskRef('fix #42 now'), 42)
  assert.equal(taskRef('hotfix-rm-42'), 42)
  assert.equal(taskRef('Redmine_4081-ios'), 4081)
})

test('numbers that are not task references', () => {
  assert.equal(taskRef('release-2026'), null)
  assert.equal(taskRef('bug-4321'), null)
  assert.equal(taskRef('main'), null)
  assert.equal(taskRef('12-columns'), null)
  assert.equal(taskRef('v2.4077'), null)
  assert.equal(taskRef('farm-42'), null)
  assert.equal(taskRef('#0'), null)
  assert.equal(taskRef(null), null)
})

test('the workspace name wins over the branch', () => {
  assert.equal(taskRefFromWorkspace('4081-ios-pass', 'feature/4077-checkout'), 4081)
  assert.equal(taskRefFromWorkspace('ios-pass', 'feature/4077-checkout'), 4077)
  assert.equal(taskRefFromWorkspace('ios-pass', 'main'), null)
})

const issue = { id: 4077, subject: 'Checkout with saved cards', tracker: 'Feature', project: 'Shop › iOS App' }

test('branch templates', () => {
  assert.equal(branchFromTemplate('{tracker}/{id}-{slug}', issue), 'feature/4077-checkout-with-saved-cards')
  assert.equal(branchFromTemplate('{project}/{id}', issue), 'shop-ios-app/4077')
  assert.equal(branchFromTemplate('Pablo/{ID}-{slug}', issue), 'pablo/4077-checkout-with-saved-cards')
  assert.equal(branchFromTemplate('{unknown}//{id}..x.lock', issue), '4077.x')
  assert.equal(branchFromTemplate('{unknown}', issue), null)
  assert.equal(branchFromTemplate('  ', issue), null)
})
