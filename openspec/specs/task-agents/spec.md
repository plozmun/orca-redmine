# task-agents Specification

## Purpose

Shows, in the task detail, the agents working in the workspaces linked to the task, and takes the user to one of them.

## Requirements

### Requirement: Agents of the task's workspaces
When a task is linked to one or more workspaces, the task detail SHALL list, per workspace, the agents Orca reports there with their kind, terminal title, state and time in that state. A linked workspace Orca no longer knows SHALL be left out without failing the detail.

#### Scenario: Agent working on a linked task
- **GIVEN** #4077 is linked to workspace `4077-checkout`, where a Claude agent is working
- **WHEN** the user opens #4077 from any workspace
- **THEN** the detail shows `4077-checkout` with a Claude agent "Working"

#### Scenario: Workspace gone
- **GIVEN** #4077 is linked to a workspace that was removed while Orca was closed
- **WHEN** the user opens #4077
- **THEN** the detail opens and shows no agents for that workspace

### Requirement: Kept current
The agents section SHALL refresh when an agent in one of the task's workspaces changes status while the detail is open, at most once every 1.5 seconds.

#### Scenario: Agent needs input
- **GIVEN** the detail of #4077 shows its agent "Working"
- **WHEN** that agent asks for permission
- **THEN** the row shows "Needs input" without reopening the task

### Requirement: Show an agent
Each listed agent with a terminal SHALL offer "Show", which focuses its terminal in Orca, when Orca offers `terminal.focus` and the user approved `workspace:write`. The plugin SHALL NOT focus a terminal that is not one of the listed agents.

#### Scenario: Show
- **GIVEN** the detail of #4077 lists a Claude agent in `4077-checkout`
- **WHEN** the user presses "Show"
- **THEN** Orca shows `4077-checkout` with that agent's terminal focused
