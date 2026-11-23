# Proposal

## Why

Today the only way to see how many Redmine tasks are waiting is to open the panel or run the palette command. Orca 1.4.248 lets plugins add live status bar items whose worker keeps running while the plugin is enabled, so the plugin can show the count at all times and flag overdue or urgent work without the panel being open.

## What Changes

- Add a status bar item showing the number of the user's open Redmine tasks (for example `7`, with the `flag` icon).
- Refresh the count from the worker on a fixed interval, after the panel changes a task, and after the connection is configured or removed.
- Colour the item: `warning` when any open task is overdue (due date in the past), `danger` when any open task has an urgent/immediate priority, `neutral` otherwise. The tooltip says why.
- Pressing the item opens the Redmine panel (falls back to the existing `redmine.myIssues` command output if the panel cannot be opened).
- Hide the item when the plugin is not connected to Redmine.
- Add settings: show/hide the item, refresh interval in minutes, and whether the count follows the project filter of the focused workspace or covers all projects.
- Raise `engines.orca` to `>=1.4.248`.

## Capabilities

### New Capabilities
- `task-status-bar`: the status bar item that summarises the user's open Redmine tasks, its refresh rules, colour and click behaviour.

### Modified Capabilities

## Impact

- `orca-plugin.json`: `contributes.statusBarItems`, new settings, a new command for the click, `engines.orca` bump. No new capability (status bar items need none); the worker now runs for as long as the plugin is enabled instead of on demand.
- `src/worker.ts`: polling loop and `statusBar.update` calls; `src/redmine.ts`: a cheap count query (`limit=1`, `total_count`) and due-date/priority fields.
- `src/i18n/*`: tooltip strings (the worker uses the system locale, as the palette command does).
- `src/worker.test.ts`, `src/panel.check.ts`: tests and a scenario for the item.
- Network: one Redmine request per interval while Orca is open. Plugin approval: adding a command re-asks the user to approve the update.
