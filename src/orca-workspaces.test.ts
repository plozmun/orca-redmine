import { assert, test } from 'orca/testing'
import {
  agentStatesFor,
  cliProjectIdFor,
  createWorktreeArgs,
  describeWorktree,
  findWorkspaceId,
  findWorkspaceRow,
  migrateProjectKeys,
  projectFromHostRow,
  unknownProjectKeys,
  keyFromHostId,
  matchHostWorkspace,
  matchWorktree,
  parseCreated,
  projectForKey,
  type HostWorkspaceRow,
  type OrcaListing
} from './orca-workspaces'

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

// `workspace.list` rows as Orca 1.4.255 gives them: id = "identity:" + the CLI's identity.key.
const hostRows: HostWorkspaceRow[] = [
  { id: 'identity:wt2:local:aaa', kind: 'worktree', name: 'kyb', branch: 'develop' },
  { id: 'identity:wt2:local:bbb', kind: 'worktree', name: 'login', branch: 'feature/123-login' },
  { id: 'identity:wt2:local:ccc', kind: 'worktree', name: 'login', branch: 'feature/9-login' },
  { id: 'identity:folder:docs', kind: 'folder', name: 'docs', branch: null }
]

test('host ids map to the stored link key; other shapes are not trusted', () => {
  assert.equal(keyFromHostId('identity:wt2:local:aaa'), 'wt2:local:aaa')
  assert.equal(keyFromHostId('identity:wt2:ssh-1:aaa'), 'wt2:ssh-1:aaa')
  assert.equal(keyFromHostId('identity:'), null)
  assert.equal(keyFromHostId('r1::/p/kyb'), null)
})

test('the host listing uses the same matching rule as the CLI and ignores folders', () => {
  const key = (displayName: string, branch: string) => matchHostWorkspace(hostRows, { displayName, branch })
  assert.equal(key('kyb', 'develop'), 'wt2:local:aaa')
  assert.equal(key('login', 'refs/heads/feature/9-login'), 'wt2:local:ccc')
  assert.equal(key('login', 'other'), null)
  assert.equal(key('renamed', 'feature/123-login'), 'wt2:local:bbb')
  assert.equal(key('docs', 'main'), null)
  assert.equal(matchHostWorkspace([{ id: 'r1::/p', kind: 'worktree', name: 'x', branch: 'main' }], { displayName: 'x', branch: 'main' }), null)
  // Same answer as the CLI for every worktree both list.
  for (const w of listing.worktrees) {
    const context = { displayName: w.displayName ?? '', branch: w.branch ?? '' }
    assert.equal(matchHostWorkspace(hostRows, context), matchWorktree(listing, context)?.workspaceKey)
  }
})

test('the host id of the focused workspace is what other host methods take', () => {
  const id = (displayName: string, branch: string) => findWorkspaceId(hostRows, { displayName, branch })
  // One match by name.
  assert.equal(id('kyb', 'develop'), 'identity:wt2:local:aaa')
  // Duplicate names: the branch tells them apart.
  assert.equal(id('login', 'feature/9-login'), 'identity:wt2:local:ccc')
  assert.equal(id('login', 'feature/123-login'), 'identity:wt2:local:bbb')
  assert.equal(id('login', 'other'), null)
  // Renamed: a unique branch still finds it.
  assert.equal(id('renamed', 'refs/heads/feature/123-login'), 'identity:wt2:local:bbb')
  // No match, and folders are never matched.
  assert.equal(id('none', 'main'), null)
  assert.equal(id('docs', 'main'), null)
  assert.equal(findWorkspaceId([], { displayName: 'kyb', branch: 'develop' }), null)
})

test('the Orca project of a key comes from the CLI listing', () => {
  assert.deepEqual(projectForKey(listing, 'wt2:local:ccc'), { orcaProjectId: 'git:gitlab.example.com/web/site', orcaProjectName: 'site' })
  assert.equal(projectForKey(listing, 'wt2:local:zzz'), null)
})

test('a worktree named by its CLI id or link key', () => {
  const byId = describeWorktree(listing, { id: 'r1::/p/kyb-login' })
  assert.deepEqual(byId, { workspaceKey: 'wt2:local:bbb', name: 'login', orcaProjectId: 'git:gitlab.example.com/backend/kyb', orcaProjectName: 'kyb' })
  assert.equal(describeWorktree(listing, { key: 'wt2:local:ccc' })?.orcaProjectName, 'site')
  assert.equal(describeWorktree(listing, { id: 'nope', key: null }), null)
})

// --- Host API 1.7: projects, focused id, agent status ---

const rows17: HostWorkspaceRow[] = [
  { id: 'identity:wt2:local:aaa', kind: 'worktree', name: 'kyb', branch: 'develop', projectId: 'repo-kyb', project: 'kyb' },
  { id: 'identity:wt2:local:bbb', kind: 'worktree', name: 'login', branch: 'feature/123-login', projectId: 'repo-kyb', project: 'kyb' },
  { id: 'identity:wt2:local:ccc', kind: 'worktree', name: 'login', branch: 'feature/9-login', projectId: 'repo-web', project: null }
]

test('the focused workspace id wins over name and branch', () => {
  assert.equal(findWorkspaceRow(rows17, { displayName: 'login', branch: 'other', workspaceId: 'identity:wt2:local:ccc' })?.id, 'identity:wt2:local:ccc')
  assert.equal(findWorkspaceRow(rows17, { displayName: 'kyb', branch: 'develop', workspaceId: 'identity:gone' })?.id, 'identity:wt2:local:aaa')
})

test('the Orca project comes from the host row when this Orca reports it', () => {
  assert.deepEqual(projectFromHostRow(rows17[0]), { orcaProjectId: 'repo-kyb', orcaProjectName: 'kyb' })
  assert.deepEqual(projectFromHostRow(rows17[2]), { orcaProjectId: 'repo-web', orcaProjectName: 'repo-web' })
  assert.deepEqual(projectFromHostRow({ ...rows17[0], projectId: null, project: null }), { orcaProjectId: null, orcaProjectName: null })
  // Host API before 1.7: no project field, so the CLI has to say.
  assert.equal(projectFromHostRow({ id: 'identity:x', kind: 'worktree', name: 'x', branch: null }), null)
})

test('mappings under CLI project ids are copied to the host ids of their repositories', () => {
  const cli = [
    { id: 'git:gitlab.example.com/backend/kyb', sourceRepoIds: ['repo-kyb', 'repo-kyb-ssh'] },
    { id: 'git:gitlab.example.com/web/site', sourceRepoIds: ['repo-web'] }
  ]
  const map = { 'git:gitlab.example.com/backend/kyb': 'kyb', 'git:gitlab.example.com/web/site': 'web', 'repo-web': 'web-own' }
  const hostIds = new Set(['repo-kyb', 'repo-kyb-ssh', 'repo-web'])
  assert.deepEqual(unknownProjectKeys(map, hostIds), ['git:gitlab.example.com/backend/kyb', 'git:gitlab.example.com/web/site'])
  assert.deepEqual(migrateProjectKeys(map, hostIds, cli), {
    ...map,
    'repo-kyb': 'kyb',
    'repo-kyb-ssh': 'kyb'
  })
  // Already migrated: nothing to do.
  assert.equal(migrateProjectKeys({ 'repo-kyb': 'kyb' }, hostIds, cli), null)
})

test('a host project id is turned into the CLI project id for worktree creation', () => {
  const cli = [{ id: 'git:gitlab.example.com/backend/kyb', sourceRepoIds: ['repo-kyb'] }]
  assert.equal(cliProjectIdFor('repo-kyb', cli), 'git:gitlab.example.com/backend/kyb')
  assert.equal(cliProjectIdFor('git:gitlab.example.com/backend/kyb', cli), 'git:gitlab.example.com/backend/kyb')
  assert.equal(cliProjectIdFor('unknown', cli), 'unknown')
})

test('agent states: what needs the person wins, and done only until it is seen', () => {
  const links = { 'wt2:local:aaa': { id: 4077 }, 'wt2:local:bbb': { id: 4077 }, 'wt2:local:ccc': { id: 4081 } }
  const withStatus: HostWorkspaceRow[] = [
    { ...rows17[0], status: { state: 'working', unread: false } },
    { ...rows17[1], status: { state: 'permission', unread: true } },
    { ...rows17[2], status: { state: 'done', unread: true } }
  ]
  assert.deepEqual(agentStatesFor(withStatus, links), { '4077': 'permission', '4081': 'done' })
  const seen: HostWorkspaceRow[] = [{ ...rows17[2], status: { state: 'done', unread: false } }, { ...rows17[0], status: { state: 'inactive', unread: false } }]
  assert.deepEqual(agentStatesFor(seen, links), {})
  assert.deepEqual(agentStatesFor([{ ...rows17[0], status: { state: 'working', unread: false } }], {}), {})
})
