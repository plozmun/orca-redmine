# Tasks

## 1. Redmine queries

- [ ] 1.1 Add `RedmineClient.openCounts()` returning `{ total, overdue, urgent }` using `limit=1` queries and a cached priority enumeration; cover it in `src/redmine.test.ts` with a stubbed fetch (total, overdue filter encoding, urgent ids above the default priority)
- [ ] 1.2 Map Redmine errors to the existing error codes in `openCounts()` and verify `unauthorized` and `network` cases in tests

## 2. Manifest and settings

- [ ] 2.1 Add `contributes.statusBarItems` (`id: "openTasks"`, icon `flag`, command), the `redmine.openPanel` command, and settings `statusBar` (boolean, default true) and `statusBarMinutes` (integer 1–60, default 5); bump `engines.orca` to `>=1.4.248`; verify `orca plugin validate .` passes
- [ ] 2.2 Document the item and its settings in README (Features, Settings, Permissions note about the always-on worker) and verify the README table matches the manifest

## 3. Worker

- [ ] 3.1 Implement `refreshStatusBar()` in `src/worker.ts`: hidden when not configured or turned off, count + tone + localized tooltip otherwise, no stale count on error; verify with `src/worker.test.ts` using the testing host's status bar stand-in
- [ ] 3.2 Start the interval in `activate`, skip overlapping ticks, re-read the interval each tick; verify with fake timers in tests
- [ ] 3.3 Call `refreshStatusBar()` after `configure`, `disconnect`, `setStatus`, `comment`, `logTime`; verify a status change test sees the item update
- [ ] 3.4 Register `redmine.openPanel`: resolve the plugin key from `orca plugin list --json` (cached) and run `orca plugin open <key> --panel redmine`, falling back to the `redmine.myIssues` text when the CLI fails; unit-test key resolution (catalog vs dev entry) and the fallback with a stubbed CLI runner, and confirm on a dev load (`orca plugin dev watch .`) that pressing the item opens the panel
- [ ] 3.5 Add tooltip strings to `src/i18n/en.ts` and `es.ts`; verify the catalog-parity test passes

## 4. Integration

- [ ] 4.1 Add a `statusBar` scenario to `src/panel.check.ts` and verify `orca plugin check .` and `orca plugin test .` pass
- [ ] 4.2 Load in Orca and verify manually: count, tone with an overdue task, hide on disconnect, refresh after closing a task
