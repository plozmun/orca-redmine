# Spec Delta

## Purpose

Lets the user give the focused workspace a name taken from its linked Redmine task.

## ADDED Requirements

### Requirement: Rename after the task on request
When the focused worktree is linked to task N and Orca offers `workspace.rename`, the panel SHALL offer an action that renames it to the filled `workspaceNameTemplate` (default `{id} {subject}`), starting with N and at most 200 characters. The plugin SHALL NOT rename workspaces without that action.

#### Scenario: Rename
- **GIVEN** the focused workspace `4077-checkout` is linked to #4077 "Checkout with saved cards"
- **WHEN** the user presses "Rename workspace"
- **THEN** the sidebar shows `4077 Checkout with saved cards` and the link is kept

#### Scenario: Older Orca
- **WHEN** Orca does not offer `workspace.rename`
- **THEN** the action is not shown
