# Spec Delta

## Purpose

Reminds the user to bring Redmine up to date when agent work on a linked task ends or its workspace is removed, without ever writing to Redmine on its own.

## ADDED Requirements

### Requirement: Follow-up when an agent finishes
When the main agent in a workspace linked to a Redmine task finishes with a success, failure or unconfirmed outcome, the plugin SHALL record a pending follow-up for that task. It SHALL NOT record one when the agent was cancelled, superseded or interrupted, or when the workspace is not linked.

#### Scenario: Agent finishes on a linked task
- **GIVEN** workspace `4077-login-fix` is linked to task #4077
- **WHEN** its main agent changes to done with outcome success
- **THEN** the Redmine panel shows a follow-up for #4077 saying the agent finished in `4077-login-fix`

#### Scenario: Agent cancelled
- **GIVEN** workspace `4077-login-fix` is linked to task #4077
- **WHEN** its main agent changes to done with outcome cancellation
- **THEN** no follow-up is recorded

#### Scenario: Unlinked workspace
- **WHEN** an agent finishes in a workspace with no linked task
- **THEN** no follow-up is recorded and no notification is shown

### Requirement: One follow-up per task and kind
A newer agent follow-up for the same task SHALL replace the pending one, and the plugin SHALL keep at most 20 follow-ups, dropping the oldest.

#### Scenario: Agent finishes twice
- **GIVEN** a pending agent follow-up for #4077
- **WHEN** the agent in that workspace finishes again
- **THEN** the panel shows a single follow-up for #4077 with the latest time

### Requirement: Actions from a follow-up
Each follow-up SHALL offer opening the task, commenting, changing status and logging time. Logging time SHALL be pre-filled with the agent's working time rounded to 0.25 hours when the plugin saw the agent start working, and left empty otherwise. Completing any write action SHALL dismiss the follow-up; the user SHALL also be able to dismiss it without acting.

#### Scenario: Log time from a follow-up
- **GIVEN** the plugin saw the agent working for 1 h 10 min before it finished
- **WHEN** the user chooses "Log time" on the follow-up
- **THEN** the hours field shows 1.25 and, after saving, the follow-up disappears

#### Scenario: No writes without a click
- **WHEN** a follow-up is recorded
- **THEN** no request that changes data is sent to Redmine

### Requirement: Clean-up when a linked workspace is removed
When a worktree workspace linked to a task is removed, the plugin SHALL delete the link and record a follow-up offering to close the task, log time or dismiss. "Close task" SHALL offer only statuses that Redmine marks as closed.

#### Scenario: Linked workspace removed
- **GIVEN** workspace `4077-login-fix` is linked to task #4077
- **WHEN** the workspace is removed in Orca
- **THEN** the link is gone and the panel shows a follow-up for #4077 with "Close task", "Log time" and "Dismiss"

#### Scenario: Unlinked workspace removed
- **WHEN** a workspace with no linked task is removed
- **THEN** nothing is recorded

### Requirement: Follow-ups persist
Follow-ups SHALL survive closing the panel and restarting Orca until acted on or dismissed.

#### Scenario: Panel closed when the agent finishes
- **GIVEN** the Redmine panel is closed
- **WHEN** an agent on a linked task finishes and the user later opens the panel
- **THEN** the follow-up is shown

### Requirement: Optional notification
With setting `agentNotification` set to `done` or `doneAndBlocked`, the plugin SHALL show a desktop notification naming the task number and subject when a follow-up is recorded, and with `doneAndBlocked` also when the main agent on a linked task becomes blocked. The default SHALL be `off`. Notifications SHALL NOT include the task description or comments.

#### Scenario: Default is off
- **GIVEN** the setting has its default value
- **WHEN** an agent on a linked task finishes
- **THEN** the follow-up is recorded and no notification is shown

#### Scenario: Blocked agent
- **GIVEN** `agentNotification` is `doneAndBlocked`
- **WHEN** the main agent on #4077 becomes blocked
- **THEN** a notification says the agent on #4077 needs input, and no follow-up is recorded
