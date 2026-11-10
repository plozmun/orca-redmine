# Design

## Context

Today: `redmine.configure` validates then saves URL (setting) and key (`secrets:own`, OS keyring). The first two requirements in the spec already hold and are specified here so the migration keeps them.

## Goals / Non-Goals

**Goals:** remove credential handling from the plugin when Orca allows it.

**Non-Goals:** OAuth or other auth kinds Redmine does not offer by default.

## Decisions

- Wait for the format; redesign `client()` around it then.
- Until then, add a test that the key never appears in logs or env (useful now, shared with `add-agent-task-env`).

## Risks / Trade-offs

- [Connections may not support API-key auth] → keep `secrets:own` path as fallback.
