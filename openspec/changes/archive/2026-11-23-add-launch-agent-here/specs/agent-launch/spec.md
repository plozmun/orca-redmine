# Spec Delta

## Purpose

Defines how the plugin starts a coding agent for a Redmine task and what that agent is told, both in a new workspace and in the workspace the user is in.

## ADDED Requirements

### Requirement: Launch in a new workspace
From a task, the user SHALL be able to create a worktree in a chosen Orca project, start a chosen agent in it with the task prompt, and have the task assigned to the new workspace.

#### Scenario: New workspace with Claude
- **WHEN** the user launches task #37046 in Orca project `shop` with agent `claude`
- **THEN** a workspace named `37046-<subject slug>` is created, Claude starts with the instructions and the task context, and the new workspace shows task #37046 as assigned

### Requirement: Launch in the focused workspace
From a task, the user SHALL be able to start a chosen agent in a new terminal of the focused workspace, receiving the same instructions and task context as a new-workspace launch.

#### Scenario: Launch here
- **GIVEN** the focused workspace is `feature/login`
- **WHEN** the user presses "Launch agent here" on task #4077 with agent `claude`
- **THEN** a new terminal opens in that workspace running Claude, and Claude receives the instructions followed by the task context block

#### Scenario: No focused workspace
- **WHEN** no workspace is focused
- **THEN** "Launch agent here" is disabled with a hint to open a workspace

### Requirement: Assignment on launch here
When the focused workspace has no task assigned, launching an agent there SHALL assign the launched task to it; when it has a different task assigned, the assignment SHALL stay unchanged.

#### Scenario: Unassigned workspace
- **GIVEN** the focused workspace has no task
- **WHEN** the user launches task #4077 here
- **THEN** the workspace shows #4077 as its task

#### Scenario: Workspace with another task
- **GIVEN** the focused workspace has task #4081
- **WHEN** the user launches task #4077 here
- **THEN** the workspace keeps #4081

### Requirement: Launch failures are reported
If the agent cannot be started (unknown agent, workspace gone, capability refused), the panel SHALL show a translated error and SHALL NOT change any assignment.

#### Scenario: Workspace removed meanwhile
- **WHEN** the focused workspace is removed before the launch completes
- **THEN** the panel shows an error and no task is assigned

### Requirement: Send to agent stays review-first
"Send to agent" SHALL keep typing the prompt into an existing terminal without pressing Enter.

#### Scenario: Send unchanged
- **WHEN** the user sends task #4077 to a terminal
- **THEN** the prompt text appears in that terminal and is not submitted
