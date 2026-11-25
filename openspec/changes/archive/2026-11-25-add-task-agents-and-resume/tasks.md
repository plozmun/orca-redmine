# Tasks

## 1. Agents of a task

- [x] 1.1 `redmine.taskAgents` and `redmine.agentActionsSupport` in `src/protocol.ts` and `src/worker.ts` (linked keys, parallel `agents.list({ workspaceId })`, max 5, rejected workspace left out); tests with `mountWorker`
- [x] 1.2 `redmine.showAgent` → `terminal.focus`, refusing terminals not in the last answer; tests
- [x] 1.3 Agents section in the task detail with "Show"; debounced refresh on `agent.status.changed`; en/es; panel tests; check scenario `detail-agents` with sample data

## 2. Resume

- [x] 2.1 `Followup` gains optional `workspaceId`, `agent`, `sessionId`; `asFollowups` accepts old and new; tests in `src/followups.test.ts`
- [x] 2.2 `agent.status.changed`: store the session and find the kind with `agents.list` (match by `terminalId`/`sessionId`); tests with and without a match, and with an event without `sessionId`
- [x] 2.3 `redmine.resumeAgent { followupId }` → `agent.resume`; `started: false` focuses the terminal; `agent_resume` error code en/es; tests
- [x] 2.4 "Resume agent" on agent follow-ups; en/es; panel tests; check scenario

## 3. Release (with `create-workspace-with-host`)

- [x] 3.1 README: Features (agents in the detail, resume); Permissions text for `workspace:write` mentions focusing agent terminals
- [ ] 3.2 Manual: agents listed for a task linked to a non-focused workspace; Show; resume a finished Claude session; resume one that is still open
