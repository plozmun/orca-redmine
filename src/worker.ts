// The plugin's worker (Node). The only part with network access: it talks to the Redmine REST API
// and runs the `orca` CLI. The URL lives in the plugin settings; the API key in its encrypted
// secrets (OS keychain). Errors are thrown as RedmineError codes for the panel to translate.
import type { OrcaWorkerApi } from 'orca/worker'
import { systemLocale, translate } from './i18n'
import { detectRedmineCli, writeContextFile } from './agent-files'
import { asCommentsMode, buildContextBlock, buildLaunchPrompt, CONTEXT_MAX_CHARS, sendPrompt, workspaceNameFor } from './launch'
import {
  clearOrcaCache,
  createWorktree,
  listOrca,
  matchWorktree,
  type CreatedWorktree,
  type CreateWorktreeOptions,
  type OrcaListing
} from './orca-workspaces'
import type { ConnectionStatus } from './protocol'
import { normalizeBaseUrl, RedmineClient, RedmineError } from './redmine'

let orcaLister: () => Promise<OrcaListing> = listOrca
let orcaCreator: (o: CreateWorktreeOptions) => Promise<CreatedWorktree> = createWorktree

/** Tests: replaces the Orca CLI listing. */
export function setOrcaLister(lister: () => Promise<OrcaListing>): void {
  orcaLister = lister
}

/** Tests: replaces `orca worktree create`. */
export function setOrcaCreator(creator: (o: CreateWorktreeOptions) => Promise<CreatedWorktree>): void {
  orcaCreator = creator
}

let redmineCli: () => Promise<string | null> = detectRedmineCli
let contextDir: string | undefined

/** Tests: replaces the `redmine --version` check. */
export function setRedmineCliDetector(detector: () => Promise<string | null>): void {
  redmineCli = detector
}

/** Tests: where the context files for "Send to agent" go (default: `<tmp>/orca-redmine`). */
export function setContextDir(dir: string | undefined): void {
  contextDir = dir
}

const URL_SETTING = 'url'
const LIMIT_SETTING = 'limit'
const API_KEY = 'apiKey'
const SEND_PROMPT_SETTING = 'sendPrompt'
const COMMENTS_SETTING = 'contextComments'
const MAX_CHARS_SETTING = 'contextMaxChars'

async function stringSetting(orca: OrcaWorkerApi, key: string): Promise<string | null> {
  const value = await orca.settings.get(key)
  return typeof value === 'string' && value.trim() ? value : null
}

function errorParts(error: unknown): { errorCode: string; errorDetail: string } {
  const code = (error as { code?: unknown })?.code
  return {
    errorCode: typeof code === 'string' ? code : 'unknown',
    errorDetail: error instanceof Error ? error.message : String(error)
  }
}

async function savedUrl(orca: OrcaWorkerApi): Promise<string | null> {
  const url = await orca.settings.get(URL_SETTING)
  return typeof url === 'string' && url.trim() ? url.trim() : null
}

/** The context options from Settings, as the agent gets them. */
async function contextOptions(orca: OrcaWorkerApi) {
  const maxChars = await orca.settings.get(MAX_CHARS_SETTING)
  return {
    comments: asCommentsMode(await orca.settings.get(COMMENTS_SETTING)),
    maxChars: typeof maxChars === 'number' ? maxChars : CONTEXT_MAX_CHARS
  }
}

async function client(orca: OrcaWorkerApi): Promise<RedmineClient> {
  const url = await savedUrl(orca)
  const key = await orca.secrets.get(API_KEY)
  if (!url || !key) throw new RedmineError('not_configured', 'Missing Redmine URL or API key')
  return new RedmineClient(url, key)
}

async function status(orca: OrcaWorkerApi): Promise<ConnectionStatus> {
  const url = await savedUrl(orca)
  const key = await orca.secrets.get(API_KEY)
  if (!url || !key) return { configured: false, url, user: null }
  try {
    const user = await new RedmineClient(url, key).currentUser()
    return { configured: true, url, user: { login: user.login, name: user.name } }
  } catch (error) {
    return { configured: false, url, user: null, ...errorParts(error) }
  }
}

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('redmine.status', () => status(orca))

  orca.panels.handle('redmine.configure', async ({ url, apiKey }) => {
    const base = normalizeBaseUrl(url)
    // Validate before saving, so a wrong key is never stored.
    await new RedmineClient(base, apiKey.trim()).currentUser()
    await orca.settings.set(URL_SETTING, base)
    await orca.secrets.set(API_KEY, apiKey.trim())
    return status(orca)
  })

  orca.panels.handle('redmine.disconnect', async () => {
    await orca.secrets.delete(API_KEY)
    return status(orca)
  })

  orca.panels.handle('redmine.issues', async ({ mine, search, projectId, status }) => {
    const limit = await orca.settings.get(LIMIT_SETTING)
    return (await client(orca)).listIssues({
      mine,
      search,
      projectId: projectId || undefined,
      status,
      limit: typeof limit === 'number' ? limit : 50
    })
  })

  orca.panels.handle('redmine.projects', async () => (await client(orca)).listProjects())

  orca.panels.handle('redmine.locateWorkspace', async (context) => {
    try {
      let located = matchWorktree(await orcaLister(), context)
      if (!located) {
        // It may be a brand-new workspace: ask again without the cache.
        clearOrcaCache()
        located = matchWorktree(await orcaLister(), context)
      }
      return located ? { located } : { located: null, errorCode: 'workspace_not_listed', errorDetail: context.displayName }
    } catch (error) {
      const parts = errorParts(error)
      orca.log(`locateWorkspace: ${parts.errorDetail}`)
      return { located: null, ...parts }
    }
  })

  orca.panels.handle('redmine.issue', async ({ id }) => (await client(orca)).getIssue(id))

  orca.panels.handle('redmine.statuses', async () => (await client(orca)).statuses())

  orca.panels.handle('redmine.setStatus', async ({ id, statusId }) => {
    const redmine = await client(orca)
    await redmine.updateIssue(id, { statusId })
    orca.panels.post('redmine.issueChanged', { id })
    return redmine.getIssue(id)
  })

  orca.panels.handle('redmine.comment', async ({ id, notes }) => {
    const redmine = await client(orca)
    await redmine.updateIssue(id, { notes })
    orca.panels.post('redmine.issueChanged', { id })
    return redmine.getIssue(id)
  })

  orca.panels.handle('redmine.logTime', async ({ id, hours, comments }) => {
    if (!(hours > 0 && hours <= 24)) throw new RedmineError('invalid_hours', `hours=${hours}`)
    const timeEntryId = await (await client(orca)).logTime(id, hours, comments)
    orca.panels.post('redmine.issueChanged', { id })
    return { timeEntryId }
  })

  orca.panels.handle('redmine.timeEntries', async ({ id }) => (await client(orca)).myTimeEntries(id))

  orca.panels.handle('redmine.cli', async () => ({ version: await redmineCli() }))

  orca.panels.handle('redmine.orcaProjects', async () =>
    (await orcaLister()).projects
      .map((p) => ({ id: p.id, name: p.displayName ?? p.id }))
      .sort((a, b) => a.name.localeCompare(b.name))
  )

  orca.panels.handle('redmine.launchWorkspace', async (input) => {
    const issue = await (await client(orca)).getIssue(input.issueId)
    const name = workspaceNameFor(issue)
    const options = await contextOptions(orca)
    const created = await orcaCreator({
      orcaProjectId: input.orcaProjectId,
      name,
      agent: input.agent,
      prompt: buildLaunchPrompt(issue, input.instructions, input.locale, {
        ...options,
        comments: input.comments ?? options.comments,
        redmineCli: Boolean(await redmineCli())
      }),
      baseBranch: input.baseBranch,
      comment: `Redmine #${issue.id}: ${issue.subject}`,
      activate: input.activate
    })
    orca.log(`launchWorkspace #${issue.id} -> ${created.workspaceKey ?? '?'} (${created.branch ?? '?'})`)
    return { ...created, name }
  })

  orca.panels.handle('redmine.sendToAgent', async ({ id, terminalId, locale }) => {
    const issue = await (await client(orca)).getIssue(id)
    // The terminal gets one line; the description and comments go in a file the line points to.
    const contextFile = await writeContextFile(issue.id, buildContextBlock(issue, await contextOptions(orca)), contextDir)
    const text = sendPrompt(issue, locale, await stringSetting(orca, SEND_PROMPT_SETTING), {
      contextFile,
      redmineCli: Boolean(await redmineCli())
    })
    // No Enter: the person reviews the text in the terminal before submitting it.
    return orca.host.call('terminal.sendText', { terminalId, text, enter: false })
  })

  // Command palette. No panel asked, so it answers in the machine's language.
  orca.commands.register('redmine.myIssues', async () => {
    const locale = systemLocale()
    if (!(await savedUrl(orca)) || !(await orca.secrets.get(API_KEY))) return translate(locale, 'command.notConfigured')
    const { issues, total } = await (await client(orca)).listIssues({ mine: true, limit: 20 })
    if (issues.length === 0) return translate(locale, 'command.noIssues')
    const lines = issues.map((i) => `#${i.id} [${i.status}] ${i.subject} (${i.project})`)
    return [translate(locale, 'command.header', { total }), ...lines].join('\n')
  })
}
