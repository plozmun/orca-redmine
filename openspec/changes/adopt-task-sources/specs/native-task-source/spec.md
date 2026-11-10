# Spec Delta

## Purpose

Makes Redmine tasks first-class in Orca's own task surfaces, the same way Orca's built-in issue trackers are, once Orca supports plugin task sources.

## ADDED Requirements

### Requirement: Redmine tasks in Orca's task surfaces
When Orca supports plugin task sources and the plugin is connected, Redmine tasks visible to the user SHALL be listed in Orca's task surfaces with their number, subject, status, priority, assignee and URL.

#### Scenario: New-workspace picker
- **GIVEN** the plugin is connected
- **WHEN** the user opens Orca's new-workspace task picker
- **THEN** Redmine tasks assigned to the user are offered alongside other sources

### Requirement: Native workspace link
A workspace created from a Redmine task through Orca's task surfaces SHALL be linked to that task with Orca's native link, and the plugin panel SHALL show the same link.

#### Scenario: Create from picker
- **WHEN** the user creates a workspace from Redmine task #4077 in Orca's picker
- **THEN** the workspace card shows #4077 and the plugin panel shows it as the workspace's task

### Requirement: Existing links preserved
Links stored by earlier plugin versions SHALL remain visible after adopting task sources.

#### Scenario: Upgrade
- **GIVEN** workspace `login` was linked to #4077 by version 0.2
- **WHEN** the plugin is updated to the task-source version
- **THEN** `login` is still linked to #4077
