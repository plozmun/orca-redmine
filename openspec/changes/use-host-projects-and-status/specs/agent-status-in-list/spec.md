# Spec Delta

## Purpose

Shows in the task list which linked tasks have an agent working on them or waiting for the person.

## ADDED Requirements

### Requirement: Agent state badge
When Orca reports agent status in `workspace.list`, each task row whose linked workspace is `working`, needs `permission`, or is `done` and unread SHALL show a badge saying so. Other states SHALL show nothing.

#### Scenario: Agent working
- **GIVEN** #4077 is linked to a workspace whose agent is working
- **WHEN** the task list loads
- **THEN** the #4077 row shows "Agent working"

#### Scenario: Older Orca
- **WHEN** Orca does not support `includeStatus`
- **THEN** no row shows an agent badge and the list works as before

### Requirement: Kept current
The badges SHALL refresh when an agent's status changes while the panel is open, at most once every 1.5 seconds.

#### Scenario: Agent finishes
- **GIVEN** the list shows "Agent working" on #4077
- **WHEN** that agent finishes
- **THEN** the row shows "Agent done" without reloading the list
