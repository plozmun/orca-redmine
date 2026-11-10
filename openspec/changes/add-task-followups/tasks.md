# Tasks

## 1. Pure logic

- [ ] 1.1 Add `src/followups.ts`: transition rule (main agent, outcomes), working-time tracking and rounding, de-duplication and the 20-item cap; unit-test every spec example in `src/followups.test.ts`

## 2. Worker

- [ ] 2.1 Add `contributes.events` (`agent.status.changed`, `workspace.removed`), capabilities `agent:read` and `notifications:show`, setting `agentNotification` (`off` default); verify `orca plugin validate .` and that there are at most 4 events in total
- [ ] 2.2 Add `redmine.followups.get` / `redmine.followups.dismiss` and the `redmine.followupsChanged` event to `src/protocol.ts`; implement the storage-backed store in `src/worker.ts`; test get/dismiss/cap in `src/worker.test.ts`
- [ ] 2.3 Handle `agent.status.changed` via the shared link store; verify with `mountWorker(...)` events for linked/unlinked, each outcome, null `workspaceId`, and that no Redmine write request is made
- [ ] 2.4 Handle `workspace.removed`: delete the link and record the follow-up; verify linked and unlinked cases
- [ ] 2.5 Notification for `done` / `doneAndBlocked` in the system locale, with number and subject only; verify the default sends none

## 3. Panel

- [ ] 3.1 Follow-up strip at the top of the task list with open/comment/status/time/dismiss; dismiss after a successful write; "Close task" limited to closed statuses; verify in `src/panel.test.tsx`
- [ ] 3.2 Add en/es strings and verify the catalog-parity test
- [ ] 3.3 Add a `followups` scenario with sample data to `src/panel.check.ts`; verify `orca plugin check .` and `orca plugin shot . --scenario followups`

## 4. Docs and integration

- [ ] 4.1 README: Features, Settings (`agentNotification`), Permissions (`agent:read`, `notifications:show`), and the note that events arrive while the worker runs
- [ ] 4.2 On a dev load, run an agent in a linked workspace to completion, then remove the workspace; confirm both follow-ups and the link removal, and answer the open question in design.md
