# Proposal

> **Blocked on Orca.** `contributes.sidebarCards` is reserved and must stay empty ("declarative left-sidebar cards with fixed layouts whose values a worker updates"). Orca 1.4.248 started drawing workspace cards from a template ("card plugins, phase 1"), which is the groundwork.

## Why

The linked task is only visible inside the Redmine panel. With many workspaces, the user cannot see at a glance which task each one is for, or its status, from the left sidebar where workspaces are listed.

## What Changes

- Show the linked Redmine task on (or next to) each workspace in the left sidebar: `#4077 · In progress`, subject as tooltip, overdue/urgent tone as in the status bar item.
- Pressing it opens the task in the Redmine panel.
- Values refreshed by the worker on link changes and on the status bar polling interval.

## Capabilities

### New Capabilities
- `workspace-task-card`: how a workspace's linked task is shown in Orca's left sidebar and kept up to date.

### Modified Capabilities

## Impact

- Manifest (`contributes.sidebarCards`), worker (reuses link store and polling from `add-workspace-create-hooks` and `add-status-bar-counter`).
