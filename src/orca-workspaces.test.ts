import { assert, test } from 'orca/testing'
import { createWorktreeArgs, matchWorktree, parseCreated, type OrcaListing } from './orca-workspaces'

const listing: OrcaListing = {
  projects: [{ id: 'git:gitlab.example.com/backend/kyb', displayName: 'kyb' }],
  worktrees: [
    { id: 'r1::/p/kyb', identity: { key: 'wt2:local:aaa' }, projectId: 'git:gitlab.example.com/backend/kyb', displayName: 'kyb', branch: 'refs/heads/develop' },
    { id: 'r1::/p/kyb-login', identity: { key: 'wt2:local:bbb' }, projectId: 'git:gitlab.example.com/backend/kyb', displayName: 'login', branch: 'refs/heads/feature/123-login' },
    { id: 'r2::/p/web', identity: { key: 'wt2:local:ccc' }, projectId: 'git:gitlab.example.com/web/site', displayName: 'login', branch: 'refs/heads/feature/9-login' }
  ]
}

test('matches by name and reports the Orca project name', () => {
  assert.deepEqual(matchWorktree(listing, { displayName: 'kyb', branch: 'develop' }), {
    workspaceKey: 'wt2:local:aaa',
    orcaProjectId: 'git:gitlab.example.com/backend/kyb',
    orcaProjectName: 'kyb'
  })
})

test('duplicate names are told apart by branch; unknown projects use the id tail', () => {
  const found = matchWorktree(listing, { displayName: 'login', branch: 'feature/9-login' })
  assert.equal(found?.workspaceKey, 'wt2:local:ccc')
  assert.equal(found?.orcaProjectName, 'site')
  assert.equal(matchWorktree(listing, { displayName: 'login', branch: 'other' }), null)
})

test('without a name match, falls back to a unique branch', () => {
  assert.equal(matchWorktree(listing, { displayName: 'renamed', branch: 'feature/123-login' })?.workspaceKey, 'wt2:local:bbb')
  assert.equal(matchWorktree(listing, { displayName: 'none', branch: 'main' }), null)
})

test('orca worktree create arguments', () => {
  assert.deepEqual(
    createWorktreeArgs({ orcaProjectId: 'git:x/alsa', name: '1-pay', agent: 'claude', prompt: 'P', baseBranch: ' develop ', comment: 'Redmine #1', activate: true }),
    ['worktree', 'create', '--project', 'git:x/alsa', '--name', '1-pay', '--no-parent', '--agent', 'claude', '--prompt', 'P', '--base-branch', 'develop', '--comment', 'Redmine #1', '--activate']
  )
  assert.deepEqual(
    createWorktreeArgs({ orcaProjectId: 'p', name: 'n', agent: null, prompt: 'P', activate: false }),
    ['worktree', 'create', '--project', 'p', '--name', 'n', '--no-parent']
  )
})

test('reads the created worktree and what was launched', () => {
  assert.deepEqual(
    parseCreated({
      worktree: { id: 'r::/p', identity: { key: 'wt2:local:new' }, displayName: '1-pay', branch: 'refs/heads/pablo/1-pay', path: '/p' },
      launch: { outcome: { kind: 'terminal', handle: 'h' } }
    }),
    { workspaceKey: 'wt2:local:new', displayName: '1-pay', branch: 'pablo/1-pay', path: '/p', launch: 'terminal' }
  )
  assert.deepEqual(parseCreated({}), { workspaceKey: null, displayName: null, branch: null, path: null, launch: null })
})
