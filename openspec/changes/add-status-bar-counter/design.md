# Design

## Context

The worker (`src/worker.ts`) is currently started on demand by panel requests and the palette command. A plugin with `main` and `contributes.statusBarItems` has its worker started when it is enabled and kept running while enabled (Orca 1.4.248), and the worker changes items with `statusBar.update` (host API 1.2, desktop only, lasts until restart). Status bar `command` must name a command in `contributes.commands`.

## Goals / Non-Goals

**Goals:** a cheap, always-on count; no extra Redmine load beyond one or two requests per interval.

**Non-Goals:** a per-workspace count (the status bar is app-wide), notifications for new tasks, a list in the tooltip.

## Decisions

- **Two cheap queries, not a full list.** `GET /issues.json?assigned_to_id=me&status_id=open&limit=1` gives `total_count`. Tone needs two more `limit=1` queries: `due_date=<=<yesterday>` (`%3C%3D` encoded) and `priority_id=<urgent ids>`. Redmine's date filter shorthand has no plain `<` operator (`=`, `>=`, `<=`, `><`, `<t+`, `>t-`…), so "before today" is asked as "on or before yesterday"; an operator Redmine does not know may be ignored or refused, which would make overdue equal total. Urgent priority ids come from `/enumerations/issue_priorities.json`, cached for the worker's life, taking the two ranks above the default one (stock Redmine: Urgent and Immediate, not High). Alternative: fetch up to 100 issues and compute locally — rejected, it is heavier and wrong past 100 tasks.
- **Timer in the worker.** `setInterval` started in `activate`, cleared on interval change (re-read settings each tick so a change in Settings applies at the next tick without reload). A refresh in flight is not overlapped: a tick is skipped while the previous one runs.
- **Panel-triggered refresh.** The handlers that already `post('redmine.issueChanged')` (`setStatus`, `comment`, `logTime`) and `configure`/`disconnect` call the same `refreshStatusBar()`; no new panel request is needed.
- **Click opens the panel.** Add command `redmine.openPanel`. The host API has no "open panel" method for workers, but the Orca CLI does: `orca plugin open <plugin-key> --panel redmine` shows the panel in the right sidebar. The handler runs it through the CLI runner `orcaLister` already uses (`src/orca-workspaces.ts`). The plugin key is not known to the worker (it is `plozmun.redmine-tasks` from the catalog but `local.redmine-tasks` for a dev load), so resolve it once from `orca plugin list --json` by matching `id: "redmine-tasks"`, preferring the enabled entry, and cache it. If the CLI is missing or fails, return the same text as `redmine.myIssues` so the press still shows something; log the CLI error.
- **Scope setting.** `statusBarScope`: `all` (default) or `focusedProject` — the latter uses the Redmine project mapped to the focused workspace's Orca project. That mapping lives in panel-persisted state today; until the worker can read it (see `add-agent-task-env` design, shared storage decision), `focusedProject` is not offered. Default `all` keeps this change independent.

## Risks / Trade-offs

- [Always-on worker uses memory and network while Orca is open] → interval default 5 min, minimum 1, and a setting to turn the item off (which also stops the timer).
- [Priority names differ per Redmine instance] → use enumeration order relative to the default priority, not names; the danger tone covers the two ranks above it, so a stock "High" stays neutral.
- [`statusBar.update` is desktop-only] → on the web client the item simply does not change; failures from `statusBar.update` are logged, not thrown.
- [Engine bump] → users on Orca < 1.4.248 cannot update; acceptable, 1.4.248 is current minus two.

## Migration Plan

Ship in the same release as the other 1.4.248 changes (planned 0.2.0) to cause a single re-approval. Rollback: remove the contribution; nothing is stored.
