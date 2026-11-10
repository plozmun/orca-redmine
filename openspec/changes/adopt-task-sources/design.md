# Design

## Context

Format not yet defined by Orca. Known intent: declared as data, filled by a worker. The plugin already has a REST client with list/filter/detail, and stores links keyed by workspace stable id.

## Goals / Non-Goals

**Goals:** track the upstream format; be ready to map `RedmineClient` output onto it quickly.

**Non-Goals:** designing against guesses; any code before the format exists.

## Decisions

- Wait for the format; on release, re-run the propose step for design/tasks with the real contract.
- Keep `RedmineClient` free of Orca dependencies (already the case) so it can feed any source shape.

## Risks / Trade-offs

- [Format may not cover time entries or Redmine statuses] → keep those in the panel.
- [Native links may be keyed differently] → migration task decided when the format is known.
