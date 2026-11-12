// Follow-ups: what the plugin remembers when an agent working on a linked task finishes or blocks,
// and when a linked worktree workspace is removed. Pure logic, shared by the worker and the panel;
// no Orca imports. The worker owns the store, the panel only reads it and asks it to dismiss one.

/** Worker storage key for the list of pending follow-ups. */
export const FOLLOWUPS_KEY = 'followups'
/** How many follow-ups are kept; the oldest are dropped first. */
export const MAX_FOLLOWUPS = 20

export type FollowupKind = 'agentDone' | 'workspaceRemoved'

export interface Followup {
  /** Stable id: dismiss it by this. */
  id: string
  kind: FollowupKind
  issueId: number
  /** Name of the workspace the event was about. The panel puts it in a sentence with `t()`. */
  workspaceName: string
  /** When the event happened (epoch ms). */
  at: number
  /** Working time the plugin saw, in hours rounded to 0.25; absent when it did not see the start. */
  hours?: number
}

export type AgentState = 'working' | 'blocked' | 'waiting' | 'done'
export type AgentOutcome = 'success' | 'failure' | 'cancellation' | 'superseded' | 'interruption' | 'unconfirmed'

/** The part of `agent.status.changed` this logic reads. */
export interface AgentStatusEvent {
  workspaceId: string | null
  paneKey: string
  state: AgentState
  receivedAt: number
  mainAgent?: { state: AgentState; outcome?: AgentOutcome; stateStartedAt: number }
}

/** What one agent event means for follow-ups and notifications. */
export interface AgentTransition {
  transition: 'done' | 'blocked'
  /** Only for `done`. */
  outcome?: AgentOutcome
  /** Only for `done`, when a working start was seen. */
  hours?: number
}

/** Outcomes worth a follow-up: the agent finished on its own, or Orca could not tell. */
export function recordsFollowup(outcome: AgentOutcome | undefined): boolean {
  return outcome === 'success' || outcome === 'failure' || outcome === 'unconfirmed'
}

/** Rounds to the nearest quarter hour, at least 0.25. */
export function roundHours(ms: number): number {
  return Math.max(1, Math.round(ms / 900_000)) / 4
}

/**
 * Watches one agent's events, per pane: keeps the first `working` time and reports the transitions
 * into `done` and `blocked` once. Main agent only (`mainAgent` when present, else `state`).
 */
export class AgentRunTracker {
  private workingSince = new Map<string, number>()
  private lastState = new Map<string, AgentState>()

  observe(event: AgentStatusEvent): AgentTransition | null {
    const main = event.mainAgent
    const state = main?.state ?? event.state
    const previous = this.lastState.get(event.paneKey)
    this.lastState.set(event.paneKey, state)

    if (state === 'working') {
      if (previous !== 'working' || !this.workingSince.has(event.paneKey)) {
        this.workingSince.set(event.paneKey, event.receivedAt)
      }
      return null
    }
    if (state === 'done' && previous !== 'done') {
      const since = this.workingSince.get(event.paneKey)
      this.workingSince.delete(event.paneKey)
      return {
        transition: 'done',
        ...(main?.outcome ? { outcome: main.outcome } : {}),
        ...(since === undefined ? {} : { hours: roundHours(event.receivedAt - since) })
      }
    }
    if (state === 'blocked' && previous !== 'blocked') return { transition: 'blocked' }
    return null
  }
}

/** The id a follow-up is stored and dismissed by. */
export function followupId(kind: FollowupKind, issueId: number, at: number): string {
  return `${kind}:${issueId}:${at}`
}

export interface NewFollowup {
  kind: FollowupKind
  issueId: number
  workspaceName: string
  at: number
  hours?: number
}

export function createFollowup(input: NewFollowup): Followup {
  return {
    id: followupId(input.kind, input.issueId, input.at),
    kind: input.kind,
    issueId: input.issueId,
    workspaceName: input.workspaceName,
    at: input.at,
    ...(input.hours === undefined ? {} : { hours: input.hours })
  }
}

/** Adds a follow-up: one pending per task and kind (the new one wins), oldest dropped past 20. */
export function addFollowup(list: readonly Followup[], next: Followup): Followup[] {
  const kept = list.filter((f) => f.kind !== next.kind || f.issueId !== next.issueId)
  return [...kept, next].sort((a, b) => a.at - b.at).slice(-MAX_FOLLOWUPS)
}

export function dismissFollowup(list: readonly Followup[], id: string): Followup[] {
  return list.filter((f) => f.id !== id)
}

/**
 * A stored value as follow-ups: anything malformed is dropped rather than shown or crashing the
 * panel after a downgrade or a manual edit.
 */
export function asFollowups(value: unknown): Followup[] {
  if (!Array.isArray(value)) return []
  return value.filter(isFollowup)
}

function isFollowup(value: unknown): value is Followup {
  if (!value || typeof value !== 'object') return false
  const f = value as Record<string, unknown>
  return (
    typeof f.id === 'string' &&
    (f.kind === 'agentDone' || f.kind === 'workspaceRemoved') &&
    typeof f.issueId === 'number' &&
    Number.isFinite(f.issueId) &&
    typeof f.workspaceName === 'string' &&
    typeof f.at === 'number' &&
    Number.isFinite(f.at) &&
    (f.hours === undefined || (typeof f.hours === 'number' && Number.isFinite(f.hours) && f.hours > 0))
  )
}

export type AgentNotification = 'off' | 'done' | 'doneAndBlocked'

export function asAgentNotification(value: unknown): AgentNotification {
  return value === 'done' || value === 'doneAndBlocked' ? value : 'off'
}

export function shouldNotify(mode: AgentNotification, transition: 'done' | 'blocked'): boolean {
  if (mode === 'off') return false
  return transition === 'done' || mode === 'doneAndBlocked'
}
