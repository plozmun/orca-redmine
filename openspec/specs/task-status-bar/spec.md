# task-status-bar Specification

## Purpose

Shows the user's open Redmine workload in Orca's status bar so it stays visible without opening the Redmine panel.

## Requirements

### Requirement: Open task count
While the plugin is connected to Redmine and the item is enabled in Settings, the status bar SHALL show the number of open tasks assigned to the current Redmine user.

#### Scenario: Connected with open tasks
- **GIVEN** the plugin is connected and the user has 7 open tasks assigned
- **WHEN** the count is refreshed
- **THEN** the status bar item shows `7` with the flag icon

#### Scenario: No open tasks
- **GIVEN** the plugin is connected and the user has no open tasks
- **WHEN** the count is refreshed
- **THEN** the item shows `0` in the neutral tone

### Requirement: Hidden when not usable
The item SHALL be hidden when the plugin has no saved URL or API key, when the user turns it off in Settings, or when the plugin is disabled.

#### Scenario: Not configured
- **WHEN** the plugin has no API key
- **THEN** no Redmine item is shown in the status bar

#### Scenario: Disconnect from the panel
- **GIVEN** the item is visible
- **WHEN** the user disconnects in the panel
- **THEN** the item is hidden without waiting for the next interval

### Requirement: Refresh timing
The count SHALL refresh when the plugin is enabled, every configured interval (default 5 minutes, minimum 1), and right after the panel changes a task's status or saves the connection.

#### Scenario: Status change from the panel
- **GIVEN** the item shows `7`
- **WHEN** the user closes one of those tasks from the panel
- **THEN** the item shows `6` without waiting for the interval

### Requirement: Attention tone
The item SHALL use the `danger` tone when any open assigned task has an urgent or immediate priority, otherwise `warning` when any has a due date before today, otherwise `neutral`. The tooltip SHALL state the counts behind the tone.

#### Scenario: Overdue task
- **GIVEN** one open assigned task is past its due date and none is urgent
- **WHEN** the count is refreshed
- **THEN** the item uses the warning tone and its tooltip mentions 1 overdue task

#### Scenario: Urgent task
- **GIVEN** one open assigned task has priority Urgent
- **WHEN** the count is refreshed
- **THEN** the item uses the danger tone

### Requirement: Errors do not show a wrong count
When Redmine cannot be reached or rejects the key, the item SHALL keep no stale number: it shows a warning tone with no count and a tooltip with the reason, and recovers on the next successful refresh.

#### Scenario: Network down
- **GIVEN** the item shows `7`
- **WHEN** a refresh fails with a network error
- **THEN** the item shows the flag icon without a number, in the warning tone, with a tooltip saying Redmine could not be reached

### Requirement: Pressing the item
Pressing the item SHALL open the Redmine panel on the task list.

#### Scenario: Click
- **WHEN** the user presses the item
- **THEN** the Redmine panel opens showing the user's tasks

#### Scenario: Panel cannot be opened
- **GIVEN** the Orca CLI is not available to the plugin
- **WHEN** the user presses the item
- **THEN** Orca shows the list of the user's open tasks as the command's text result
