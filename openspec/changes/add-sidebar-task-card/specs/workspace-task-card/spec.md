# Spec Delta

## Purpose

Shows each workspace's linked Redmine task, with its status, in Orca's left sidebar so the user can tell workspaces apart without opening the panel.

## ADDED Requirements

### Requirement: Task shown per workspace
When Orca supports plugin sidebar cards, each workspace linked to a task SHALL show the task number and status in the left sidebar; unlinked workspaces SHALL show nothing from this plugin.

#### Scenario: Linked workspace
- **GIVEN** workspace `login` is linked to #4077, status In progress
- **WHEN** the left sidebar lists `login`
- **THEN** it shows `#4077 · In progress`

### Requirement: Card stays current
The card SHALL update when the link changes and when the task's status changes in Redmine, within one polling interval.

#### Scenario: Status closed in Redmine's web UI
- **WHEN** someone closes #4077 in Redmine
- **THEN** the card shows the closed status after the next refresh

### Requirement: Card opens the task
Pressing the card SHALL open the task in the Redmine panel.

#### Scenario: Click
- **WHEN** the user presses the `#4077` card
- **THEN** the Redmine panel opens on #4077
