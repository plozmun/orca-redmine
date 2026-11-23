# Spec Delta

## Purpose

Gives any coding agent started in a workspace linked to a Redmine task the task's number, whichever launcher started it, without exposing credentials or slowing the start.

## ADDED Requirements

### Requirement: Task number for agents
When an agent starts in a workspace linked to task N, the plugin SHALL add `REDMINE_ISSUE=N` to its environment, keeping any variables already set by the launch, and SHALL add no other variable.

#### Scenario: Agent from Orca's new tab
- **GIVEN** workspace `login` is linked to #4077
- **WHEN** the user opens a new Claude tab in it from Orca
- **THEN** Claude's environment has `REDMINE_ISSUE=4077`

#### Scenario: Unlinked workspace
- **WHEN** an agent starts in a workspace with no task
- **THEN** its environment and command are unchanged

### Requirement: No credentials in the environment
The plugin SHALL NOT export the Redmine API key, the Redmine URL or any secret to agents.

#### Scenario: Env inspection
- **WHEN** an agent in a linked workspace lists its environment
- **THEN** no variable contains the stored API key

### Requirement: Agent starts are never slowed
The launch hook SHALL decide from local state only, without calling Redmine.

#### Scenario: Redmine unreachable
- **GIVEN** Redmine is down and workspace `login` is linked to #4077
- **WHEN** an agent starts there
- **THEN** it starts at once with `REDMINE_ISSUE=4077`

### Requirement: Optional prompt pointer
When `promptPointer` is on, a launch prompt Orca submits to an agent whose terminal was started in a linked workspace SHALL get one appended line naming task N, its subject and URL, unless the prompt already contains `#N` or the task URL. Other prompts, and all prompts when the setting is off, SHALL be unchanged.

#### Scenario: Pointer added
- **GIVEN** `promptPointer` is on and the workspace is linked to #4077
- **WHEN** Orca submits the launch prompt "Fix the failing tests"
- **THEN** the agent receives that prompt followed by a line naming task #4077

#### Scenario: Plugin's own prompt
- **WHEN** the plugin launches an agent for #4077 with its own prompt
- **THEN** no extra line is added

#### Scenario: Terminal not identifiable
- **WHEN** the prompt's terminal was not seen by the launch hook
- **THEN** the prompt is unchanged
