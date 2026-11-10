# Spec Delta

## Purpose

Gives any coding agent started in a workspace linked to a Redmine task the task's identity and context, whichever launcher started it, without exposing credentials.

## ADDED Requirements

### Requirement: Task environment for agents
When an agent starts in a workspace linked to task N, the plugin SHALL add `REDMINE_ISSUE=N`, `REDMINE_ISSUE_URL`, `REDMINE_URL` and `REDMINE_CONTEXT_FILE` to its environment, keeping any variables already set by the launch.

#### Scenario: Agent from Orca's new tab
- **GIVEN** workspace `login` is linked to #4077
- **WHEN** the user opens a new Claude tab in it from Orca
- **THEN** Claude's environment has `REDMINE_ISSUE=4077` and `REDMINE_CONTEXT_FILE` pointing to a readable file with the task context

#### Scenario: Unlinked workspace
- **WHEN** an agent starts in a workspace with no task
- **THEN** its environment and command are unchanged

### Requirement: No credentials in the environment
The plugin SHALL NOT export the Redmine API key or any secret to agents.

#### Scenario: Env inspection
- **WHEN** an agent in a linked workspace lists its environment
- **THEN** no variable contains the stored API key

### Requirement: Agent starts are never blocked
The plugin SHALL NOT refuse or delay an agent start beyond the hook budget: if the link lookup or the context file fails, the agent starts without the variables (or with all but `REDMINE_CONTEXT_FILE`).

#### Scenario: Redmine unreachable
- **GIVEN** Redmine is down and workspace `login` is linked to #4077
- **WHEN** an agent starts there
- **THEN** it starts with `REDMINE_ISSUE` and the URLs, and without `REDMINE_CONTEXT_FILE` unless a previous context file for #4077 exists

### Requirement: Optional prompt pointer
When `promptPointer` is on, a prompt Orca submits as a launch prompt to an agent in a linked workspace SHALL get one appended line pointing to the context file, unless the prompt already contains `#N` or the task URL. Prompts the person types, and all prompts when the setting is off, SHALL be unchanged.

#### Scenario: Pointer added
- **GIVEN** `promptPointer` is on and the workspace is linked to #4077
- **WHEN** Orca submits the launch prompt "Fix the failing tests"
- **THEN** the agent receives that prompt followed by a line naming task #4077 and its context file

#### Scenario: Plugin's own prompt
- **WHEN** the plugin launches an agent for #4077 with its own prompt
- **THEN** no extra line is added

#### Scenario: Terminal not identifiable
- **WHEN** the prompt's terminal cannot be matched to a linked workspace
- **THEN** the prompt is unchanged
