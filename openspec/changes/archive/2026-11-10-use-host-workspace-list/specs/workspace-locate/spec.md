# Spec Delta

## Purpose

Identifies the focused Orca workspace and its Orca project so the panel can show the linked Redmine task and filter by the mapped Redmine project, relying on the Orca CLI as little as possible.

## ADDED Requirements

### Requirement: Workspace key without the Orca CLI
The plugin SHALL identify the focused worktree workspace through Orca's host API when it is available, so the linked task is shown even when the Orca CLI cannot be run.

#### Scenario: CLI not installed
- **GIVEN** workspace `4077-login-fix` is linked to task #4077
- **AND** the `orca` CLI is not on the worker's PATH
- **WHEN** the user focuses that workspace
- **THEN** the Redmine panel opens task #4077

### Requirement: Same keys as before
The key used for links SHALL be the same value stored by earlier versions, so no existing link is lost on update.

#### Scenario: Update keeps links
- **GIVEN** a workspace linked to #4077 by version 0.1.7
- **WHEN** the plugin is updated and the workspace is focused
- **THEN** the panel still shows #4077

### Requirement: Degrade to "project unknown"
When the workspace is found but its Orca project cannot be determined, the panel SHALL show the linked task and the branch suggestion, and state that the Orca project is unknown with the reason, instead of a general error.

#### Scenario: CLI fails after the key is found
- **GIVEN** the host lists the focused workspace and the CLI fails
- **WHEN** the panel locates the workspace
- **THEN** it shows "Orca project unknown" with the CLI reason, and the task list is not filtered by project

### Requirement: Fallback when the host cannot answer
When the host method is unavailable, fails, or its listing is truncated without a match, the plugin SHALL locate the workspace with the Orca CLI as before.

#### Scenario: Older host
- **GIVEN** `workspace.list` is not offered
- **WHEN** the panel locates the workspace
- **THEN** the CLI listing is used and the result is the same as in 0.1.7
