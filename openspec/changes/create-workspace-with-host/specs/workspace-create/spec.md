# Spec Delta

## Purpose

Creates a task's workspace and starts its agent through Orca's host API instead of the Orca CLI.

## ADDED Requirements

### Requirement: Create through the host
When Orca offers `workspace.create`, "Launch agent → New workspace" SHALL create the workspace with it, start the chosen agent with the task prompt, and link the new workspace to the task, without running the Orca CLI.

#### Scenario: SSH project
- **GIVEN** an Orca project on an SSH host
- **WHEN** the user launches an agent in a new workspace for #4077
- **THEN** the workspace is created on that host, the agent starts there and the workspace is linked to #4077

#### Scenario: Older Orca
- **WHEN** Orca does not offer `workspace.create`
- **THEN** the workspace is created with the Orca CLI as in 0.2.x
