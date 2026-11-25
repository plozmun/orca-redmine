# Spec Delta

## Purpose

Takes the user from a task in the panel to the workspace linked to it.

## ADDED Requirements

### Requirement: Go to the task's workspace
When a task is linked to a workspace other than the focused one and Orca offers `workspace.open`, the task detail and the task's agent follow-ups SHALL offer "Go to workspace", which shows that workspace in Orca.

#### Scenario: From a follow-up
- **GIVEN** an "agent finished" follow-up for #4077, linked to workspace `4077-checkout`
- **WHEN** the user presses "Go to workspace"
- **THEN** Orca shows `4077-checkout`
