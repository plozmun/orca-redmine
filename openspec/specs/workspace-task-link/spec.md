# workspace-task-link Specification

## Purpose

Defines how Orca workspaces are linked to Redmine tasks, from the panel or automatically when a workspace is created, and what the plugin does to the branch and the task at that moment.

## Requirements

### Requirement: One task per workspace
Each workspace SHALL have at most one linked task, identified by the workspace's stable id, so renaming the workspace keeps the link. The panel and the worker SHALL see the same links.

#### Scenario: Rename keeps the link
- **GIVEN** workspace `login` is linked to #4077
- **WHEN** the workspace is renamed to `login-v2`
- **THEN** it is still linked to #4077

#### Scenario: Link made by the worker appears in the panel
- **GIVEN** the worker linked a new workspace to #4077
- **WHEN** the user focuses that workspace with the panel open
- **THEN** the panel shows #4077 as the workspace's task

### Requirement: Task reference detection
A workspace name or branch SHALL be taken to name task N when its last path segment starts with N of at least 3 digits followed by `-`, `_`, a space or the end, or when it contains `#N`, `redmine-N` or `rm-N` (case-insensitive), with N a positive integer. A number following a word (`release-2026`) SHALL NOT be taken. When the name and branch name different tasks, the name wins.

#### Scenario: Branch with prefix
- **WHEN** the branch is `feature/12345-login`
- **THEN** it names task 12345

#### Scenario: Number that is not a task reference
- **WHEN** the branch is `release-2026`
- **THEN** it names no task

### Requirement: Branch convention
When `branchTemplate` is not empty and a workspace about to be created names task N that exists in Redmine, the plugin SHALL set the branch to the template filled with that task's `{id}`, `{slug}`, `{tracker}` and `{project}`, lowercased and made git-safe. When the template is empty, the task cannot be fetched within the hook's time budget, or the workspace names no task, the creation SHALL proceed unchanged.

#### Scenario: Template applied
- **GIVEN** `branchTemplate` is `{tracker}/{id}-{slug}` and task 4077 is a Feature titled "Checkout with saved cards"
- **WHEN** a workspace named `4077 checkout` is being created
- **THEN** its branch is `feature/4077-checkout-with-saved-cards`

#### Scenario: Redmine slow
- **WHEN** Redmine does not answer in time
- **THEN** the workspace is created with the branch Orca proposed

#### Scenario: Creation is never refused
- **WHEN** the plugin's hook throws or times out
- **THEN** the workspace is still created

### Requirement: Automatic link at creation
After a workspace is created that names task N existing in Redmine and visible to the user, the plugin SHALL link it to N, unless the workspace already has a task.

#### Scenario: Created from Orca's dialog
- **WHEN** the user creates workspace `4081-ios-pass` from Orca's new-workspace dialog
- **THEN** the workspace is linked to #4081

#### Scenario: Task does not exist
- **WHEN** a workspace `99999-test` is created and Redmine has no task 99999
- **THEN** no link is made and nothing is written to Redmine

### Requirement: Optional task update when work starts
When a workspace becomes linked at creation (automatic link or plugin launch) and `onWorkspaceCreated` is `comment` or `start`, the plugin SHALL add a comment to the task naming the workspace and branch; with `start` it SHALL also move a task in the first open status (in Redmine's status order) to the next open status. The work start SHALL be recorded at most once per workspace. With `nothing` it SHALL write nothing to Redmine.

#### Scenario: Start
- **GIVEN** `onWorkspaceCreated` is `start` and task #4081 is New
- **WHEN** workspace `4081-ios-pass` is created
- **THEN** #4081 gets the comment and moves to In progress

#### Scenario: Default
- **GIVEN** `onWorkspaceCreated` is `nothing`
- **WHEN** a linked workspace is created
- **THEN** the task is not modified
