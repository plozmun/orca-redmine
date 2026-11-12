import { assert, test } from 'orca/testing'
import {
  ISSUE_ENV,
  LaunchedTasks,
  namesTask,
  pathFromCliId,
  taskPointer,
  taskUrl,
  TERMINAL_LIMIT,
  withIssueEnv,
  withPromptPointer
} from './agent-env'

const issue = { id: 4077, subject: 'Checkout with saved cards' }

test('the environment gets the task number and keeps what the launcher set', () => {
  assert.deepEqual(withIssueEnv({}, 4077), { REDMINE_ISSUE: '4077' })
  assert.deepEqual(withIssueEnv({ CI: '1', REDMINE_ISSUE: '9' }, 4077), { CI: '1', REDMINE_ISSUE: '9' })
  assert.deepEqual(Object.keys(withIssueEnv({ CI: '1' }, 4077)), ['CI', ISSUE_ENV])
})

test('a CLI workspace id names its path; an identity id does not', () => {
  assert.equal(pathFromCliId('r::/repos/shop/4077-checkout'), '/repos/shop/4077-checkout')
  assert.equal(pathFromCliId('identity:wt-4077'), null)
  assert.equal(pathFromCliId('r::'), null)
})

test('the launch prompt pointer names the task once', () => {
  assert.equal(taskUrl('https://redmine.test/', 4077), 'https://redmine.test/issues/4077')
  assert.equal(taskUrl('  ', 4077), null)
  assert.equal(taskPointer(issue, 'https://redmine.test'), 'Redmine task #4077 "Checkout with saved cards": https://redmine.test/issues/4077')
  assert.equal(taskPointer(issue, null), 'Redmine task #4077 "Checkout with saved cards"')
  assert.equal(
    withPromptPointer('Fix the failing tests', issue, 'https://redmine.test'),
    'Fix the failing tests\n\nRedmine task #4077 "Checkout with saved cards": https://redmine.test/issues/4077'
  )
  // A prompt that already names the task gets nothing.
  assert.equal(withPromptPointer('Fix #4077 please', issue, 'https://redmine.test'), null)
  assert.equal(withPromptPointer('See https://redmine.test/issues/4077', issue, 'https://redmine.test'), null)
  // A different task number is not this task.
  assert.equal(namesTask('Fix #40770', 4077, null), false)
  assert.equal(namesTask('#4077.', 4077, null), true)
})

test('terminals are remembered up to the cap, oldest forgotten first', () => {
  const launched = new LaunchedTasks()
  launched.remember('t1', { id: 1, subject: 'One' })
  launched.remember('t2', { id: 2, subject: 'Two' })
  launched.remember('t1', { id: 1, subject: 'One again' })
  assert.equal(launched.taskFor('t1')?.subject, 'One again')
  assert.equal(launched.taskFor('t3'), undefined)
  for (let i = 0; i < TERMINAL_LIMIT; i++) launched.remember(`t-${i}`, { id: i, subject: 'x' })
  assert.equal(launched.size, TERMINAL_LIMIT)
  assert.equal(launched.taskFor('t1'), undefined)
  assert.equal(launched.taskFor(`t-${TERMINAL_LIMIT - 1}`)?.id, TERMINAL_LIMIT - 1)
})
