# workspace-create Specification

## Purpose

Creates a task's workspace and starts its agent through Orca's host API instead of the Orca CLI.

## Requirements

### Requirement: Create through the host
"Launch agent → New workspace" SHALL create the workspace with Orca's `workspace.create`, start the chosen agent with the task prompt, and link the new workspace to the task. It SHALL NOT run the Orca CLI.

#### Scenario: SSH project
- **GIVEN** an Orca project on an SSH host
- **WHEN** the user launches an agent in a new workspace for #4077
- **THEN** the workspace is created on that host, the agent starts there and the workspace is linked to #4077

#### Scenario: CLI not installed
- **GIVEN** the `orca` CLI is not on the worker's PATH
- **WHEN** the user launches an agent in a new workspace for #4077
- **THEN** the workspace is created and linked as usual

### Requirement: Agent failure after creation
When the workspace is created but the agent fails to start, the plugin SHALL still link the workspace to the task and report the agent error.

#### Scenario: Agent fails to start
- **GIVEN** `workspace.create` fails with an error naming the new workspace id
- **WHEN** the user launched it for #4077
- **THEN** that workspace is linked to #4077 and the panel shows that the agent could not start

### Requirement: Projects from the host
The project picker for a new workspace SHALL list Orca's projects from `project.list` only.

#### Scenario: Picker without the CLI
- **GIVEN** the `orca` CLI is not on the worker's PATH
- **WHEN** the user opens "New workspace"
- **THEN** the picker lists Orca's Git projects, local and SSH
