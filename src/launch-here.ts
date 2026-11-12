// "Launch agent here": the prompt the worker hands to the host's `agent.launch`. That method takes
// `{ workspaceId, agent, prompt }` and refuses a `prompt` longer than 4096 characters (checked in
// Orca 1.4.257's host schema: `invalid_params` above it). When the instructions plus the fenced
// context do not fit, the context goes in the same file "Send to agent" uses and the prompt points
// at it, so the agent still gets the whole task.
import { translate } from './i18n'
import { defaultInstructions } from './launch'
import type { IssueDetail } from './redmine'

/** `agent.launch`'s cap on `prompt`. */
export const LAUNCH_PROMPT_MAX_CHARS = 4096

/** Whether `agent.launch` accepts this prompt as it is. */
export function fitsLaunchPrompt(prompt: string): boolean {
  return prompt.length <= LAUNCH_PROMPT_MAX_CHARS
}

/**
 * The prompt when the context does not fit inline: the instructions (and the CLI hint) plus a
 * sentence pointing at `contextFile`. Long instructions are cut; the pointer never is.
 */
export function contextFilePrompt(
  issue: Pick<IssueDetail, 'id' | 'subject' | 'url'> & Partial<IssueDetail>,
  instructions: string,
  locale: string,
  options: { contextFile: string; redmineCli?: boolean }
): string {
  const lead = instructions.trim() || defaultInstructions(issue, locale)
  const tail = [
    ...(options.redmineCli ? [translate(locale, 'agent.cliHint', { id: issue.id })] : []),
    translate(locale, 'send.contextFile', { path: options.contextFile })
  ].join('\n')
  const room = LAUNCH_PROMPT_MAX_CHARS - tail.length - 1
  const head = lead.length > room ? lead.slice(0, Math.max(0, room)).trimEnd() : lead
  return `${head}\n${tail}`.slice(0, LAUNCH_PROMPT_MAX_CHARS)
}
