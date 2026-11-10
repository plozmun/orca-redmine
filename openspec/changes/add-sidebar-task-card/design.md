# Design

## Context

Format not defined. Expected: fixed layouts, worker-updated values (like `statusBar.update`).

## Decisions

- Reuse the status bar poller: one Redmine query for all linked tasks (`issue_id=1,2,3`) per interval, feeding both surfaces.
- Wait for the format before designing layout mapping.

## Risks / Trade-offs

- [Many linked workspaces → large `issue_id` lists] → batch in chunks of 100.
