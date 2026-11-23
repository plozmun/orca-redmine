# Spec Delta

## ADDED Requirements

### Requirement: Orca project without the Orca CLI
When Orca's `workspace.list` gives the focused workspace's `projectId`, the plugin SHALL take the Orca project from it and SHALL NOT run the Orca CLI to locate the workspace.

#### Scenario: CLI not installed, project known
- **GIVEN** the `orca` CLI is not on the worker's PATH
- **AND** the host lists the focused workspace with project `shop`
- **WHEN** the panel locates the workspace
- **THEN** the Redmine project picker for `shop` is shown and the list is filtered by its mapping

### Requirement: Mappings survive the change of project id
A Redmine project mapped to an Orca project under its CLI id SHALL still apply when the workspace is located through the host, by copying it once to the host ids of that project's repositories.

#### Scenario: Mapping made with 0.2.0
- **GIVEN** `git:gitlab.example.com/shop` was mapped to Redmine project `shop` by 0.2.0
- **WHEN** a workspace of that repository is located through the host
- **THEN** the list is filtered by `shop` without mapping it again

### Requirement: Events name the workspace by its listed id
When a workspace or agent event carries `workspaceListId`, the plugin SHALL use it to find the link, without the CLI.

#### Scenario: Removed workspace
- **GIVEN** a workspace linked to #4077
- **WHEN** Orca sends `workspace.removed` with its `workspaceListId`
- **THEN** the link is deleted and a follow-up for #4077 is recorded
