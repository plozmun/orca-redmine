// Unit tests for the pure follow-up rules: transitions, working time, de-duplication and the cap.
import { assert, test } from 'orca/testing'
import {
  addFollowup,
  AgentRunTracker,
  asAgentNotification,
  asFollowups,
  createFollowup,
  dismissFollowup,
  FOLLOWUPS_KEY,
  MAX_FOLLOWUPS,
  recordsFollowup,
  roundHours,
  shouldNotify,
  type AgentStatusEvent,
  type Followup
} from './followups'

const MINUTE = 60_000

function event(state: AgentStatusEvent['state'], receivedAt: number, extra: Partial<AgentStatusEvent> = {}): AgentStatusEvent {
  return { workspaceId: 'identity:wt-1', paneKey: 'pane-1', state, receivedAt, ...extra }
}

test('only success, failure and unconfirmed outcomes record a follow-up', () => {
  assert.equal(recordsFollowup('success'), true)
  assert.equal(recordsFollowup('failure'), true)
  assert.equal(recordsFollowup('unconfirmed'), true)
  assert.equal(recordsFollowup('cancellation'), false)
  assert.equal(recordsFollowup('superseded'), false)
  assert.equal(recordsFollowup('interruption'), false)
  assert.equal(recordsFollowup(undefined), false)
})

test('rounds working time to quarter hours, at least 0.25', () => {
  assert.equal(roundHours(0), 0.25)
  assert.equal(roundHours(1 * MINUTE), 0.25)
  assert.equal(roundHours(20 * MINUTE), 0.25)
  assert.equal(roundHours(25 * MINUTE), 0.5)
  assert.equal(roundHours(70 * MINUTE), 1.25)
  assert.equal(roundHours(120 * MINUTE), 2)
})

test('reports done once, with the time since the agent started working', () => {
  const tracker = new AgentRunTracker()
  const start = 1_000_000
  assert.equal(tracker.observe(event('working', start)), null)
  // Repeated working reports keep the first time.
  assert.equal(tracker.observe(event('working', start + 10 * MINUTE)), null)
  assert.deepEqual(tracker.observe(event('done', start + 70 * MINUTE, { mainAgent: { state: 'done', outcome: 'success', stateStartedAt: start + 70 * MINUTE } })), {
    transition: 'done',
    outcome: 'success',
    hours: 1.25
  })
  // A repeated done is not a new finish.
  assert.equal(tracker.observe(event('done', start + 71 * MINUTE, { mainAgent: { state: 'done', outcome: 'success', stateStartedAt: start } })), null)
})

test('the main agent decides, and waiting is not a finish', () => {
  const tracker = new AgentRunTracker()
  const start = 5_000
  assert.equal(tracker.observe(event('working', start)), null)
  // The pane says working again, but the main agent is waiting.
  assert.equal(tracker.observe(event('working', start + MINUTE, { mainAgent: { state: 'waiting', stateStartedAt: start + MINUTE } })), null)
  assert.deepEqual(tracker.observe(event('waiting', start + 2 * MINUTE, { mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: start } })), {
    transition: 'done',
    outcome: 'failure',
    hours: 0.25
  })
})

test('a finish seen without its start has no hours', () => {
  const tracker = new AgentRunTracker()
  assert.deepEqual(tracker.observe(event('done', 9_000, { mainAgent: { state: 'done', outcome: 'unconfirmed', stateStartedAt: 9_000 } })), {
    transition: 'done',
    outcome: 'unconfirmed'
  })
})

test('blocked is reported once and carries no hours', () => {
  const tracker = new AgentRunTracker()
  assert.equal(tracker.observe(event('working', 1_000)), null)
  assert.deepEqual(tracker.observe(event('blocked', 2_000)), { transition: 'blocked' })
  assert.equal(tracker.observe(event('blocked', 3_000)), null)
  // Back to working, then done: the working clock restarted.
  assert.equal(tracker.observe(event('working', 4_000)), null)
  assert.deepEqual(tracker.observe(event('done', 4_000 + 30 * MINUTE)), { transition: 'done', hours: 0.5 })
})

test('a newer follow-up for the same task and kind replaces the pending one', () => {
  const older = createFollowup({ kind: 'agentDone', issueId: 4077, workspaceName: 'one', at: 1000 })
  const newer = createFollowup({ kind: 'agentDone', issueId: 4077, workspaceName: 'two', at: 2000, hours: 1.5 })
  const list = addFollowup(addFollowup([], older), newer)
  assert.deepEqual(list, [newer])
})

test('follow-ups of another kind or task coexist', () => {
  const done = createFollowup({ kind: 'agentDone', issueId: 4077, workspaceName: 'one', at: 1000 })
  const removed = createFollowup({ kind: 'workspaceRemoved', issueId: 4077, workspaceName: 'one', at: 2000 })
  const other = createFollowup({ kind: 'agentDone', issueId: 4081, workspaceName: 'two', at: 3000 })
  assert.deepEqual(addFollowup(addFollowup(addFollowup([], done), removed), other), [done, removed, other])
})

test('keeps at most 20 follow-ups, dropping the oldest', () => {
  let list: Followup[] = []
  for (let i = 1; i <= MAX_FOLLOWUPS + 3; i++) {
    list = addFollowup(list, createFollowup({ kind: 'agentDone', issueId: i, workspaceName: `ws-${i}`, at: i * 1000 }))
  }
  assert.equal(list.length, MAX_FOLLOWUPS)
  assert.equal(list[0].issueId, 4)
  assert.equal(list.at(-1)?.issueId, MAX_FOLLOWUPS + 3)
})

test('dismiss removes only that follow-up', () => {
  const one = createFollowup({ kind: 'agentDone', issueId: 1, workspaceName: 'a', at: 1000 })
  const two = createFollowup({ kind: 'workspaceRemoved', issueId: 2, workspaceName: 'b', at: 2000 })
  assert.deepEqual(dismissFollowup([one, two], one.id), [two])
  assert.deepEqual(dismissFollowup([one, two], 'missing'), [one, two])
})

test('stored values are read defensively', () => {
  const good = createFollowup({ kind: 'agentDone', issueId: 1, workspaceName: 'a', at: 1000, hours: 0.5 })
  assert.deepEqual(asFollowups([good, null, 3, { id: 'x' }, { ...good, kind: 'other' }, { ...good, hours: -1 }]), [good])
  assert.deepEqual(asFollowups(null), [])
  assert.deepEqual(asFollowups({}), [])
  assert.equal(FOLLOWUPS_KEY, 'followups')
})

test('the notification setting is off by default and doneAndBlocked includes blocked', () => {
  assert.equal(asAgentNotification(undefined), 'off')
  assert.equal(asAgentNotification('nope'), 'off')
  assert.equal(asAgentNotification('done'), 'done')
  assert.equal(asAgentNotification('doneAndBlocked'), 'doneAndBlocked')
  assert.equal(shouldNotify('off', 'done'), false)
  assert.equal(shouldNotify('off', 'blocked'), false)
  assert.equal(shouldNotify('done', 'done'), true)
  assert.equal(shouldNotify('done', 'blocked'), false)
  assert.equal(shouldNotify('doneAndBlocked', 'done'), true)
  assert.equal(shouldNotify('doneAndBlocked', 'blocked'), true)
})

test('a follow-up keeps the workspace, agent and session when known; old ones stay valid', () => {
  const resumable = createFollowup({
    kind: 'agentDone',
    issueId: 1,
    workspaceName: 'a',
    at: 1000,
    workspaceId: 'identity:wt-1',
    agent: 'claude',
    sessionId: 'sess-1'
  })
  assert.deepEqual(resumable, {
    id: 'agentDone:1:1000',
    kind: 'agentDone',
    issueId: 1,
    workspaceName: 'a',
    at: 1000,
    workspaceId: 'identity:wt-1',
    agent: 'claude',
    sessionId: 'sess-1'
  })
  const old = createFollowup({ kind: 'workspaceRemoved', issueId: 2, workspaceName: 'b', at: 2000 })
  assert.equal('workspaceId' in old || 'agent' in old || 'sessionId' in old, false)
  // Stored 0.2.x entries and new ones coexist, and a newer one still replaces the pending same kind.
  assert.deepEqual(asFollowups([old, resumable]), [old, resumable])
  assert.deepEqual(addFollowup([old], resumable), [resumable, old])
  const newer = createFollowup({ kind: 'agentDone', issueId: 1, workspaceName: 'c', at: 3000 })
  assert.deepEqual(addFollowup([old, resumable], newer), [old, newer])
  // A malformed optional field drops that entry only.
  assert.deepEqual(asFollowups([{ ...old, workspaceId: 3 }, { ...old, agent: '' }, { ...old, sessionId: null }, old]), [old])
})
