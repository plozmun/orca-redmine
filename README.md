# Redmine for Orca

An Orca plugin (`plozmun.redmine-tasks`) that brings your Redmine tasks into the sidebar and ties them to Orca workspaces and agents.

> Orca does not yet let plugins add *task sources* or *connections* (how the native Jira and Linear integrations work): those contribution points are reserved. This plugin gives a similar experience with a **sidebar panel** and a **Node worker** that calls the Redmine REST API and the `orca` CLI.

## Install

Requires Orca 1.4.246 or newer.

- From Orca's plugin catalog: search for **Redmine** (listing: https://www.onorca.dev/plugins/plozmun/orca-redmine).
- Or from a local clone, for development: `orca plugin dev load <path-to-clone>`.

It runs a worker with your user's access (see [Permissions](#permissions)), so Orca asks you to approve it on first load.

## Features

- **Redmine panel** (flag icon, right sidebar): your tasks (or everyone's), searchable by subject or `#number`, filtered by status (open by default, closed, any, or one status; the choice is kept).
- **Task detail**: description, history, status, priority and done ratio, laid out like Orca's own sidebar panels (compact header, key/value details, sections). Redmine's Textile (numbered lists, `h2.` headings, `!image.png!`, `<pre>`) is shown as Markdown. When the focused workspace has a task assigned, the panel opens it (also after switching workspaces); a workspace without one shows the list. *Back* lets you browse the list meanwhile.
- **Change status**, **comment** and **log time** without leaving Orca.
- **A Redmine project per Orca project**: map each Orca project (repository) once to a Redmine project, with a filter to find it among many. All its workspaces use it to filter the list. Remove it with ✕.
- **A task per workspace**: each workspace can have one task assigned, or none. Stored by the stable worktree id, so renaming the workspace keeps it. When the branch contains a number (`feature/12345-login`), the panel offers to assign it.
- **Launch an agent in a new workspace**: from a task, create a worktree in an Orca project, start an agent with the task context, and assign the task to the new workspace — like Orca does for GitHub, GitLab, Jira and Linear.
- **Send to agent**: types the task prompt into a terminal of the current workspace. It **does not press Enter**, so you can review it first.
- **Command palette**: `Redmine: my open tasks`.
- **English and Spanish UI**, following Orca's language.

## Usage

1. Open the Redmine panel and connect with the URL and your API key (*My account → API access key*). The key is validated, then stored encrypted in the OS keychain.
2. In a workspace, pick the Redmine project for its Orca project.
3. Open a task and either **assign it to this workspace**, or **launch an agent in a new workspace** for it.
4. When done: change the status, log the time, and leave a comment with the PR/MR link.

## Layout

```
orca-plugin.json        Manifest: panel, command, settings and capabilities
assets/                 Plugin icon and cover for the plugin page
src/redmine.ts          Redmine REST API client (no Orca dependency)
src/orca-workspaces.ts  Locates the focused workspace and creates worktrees through the `orca` CLI
src/launch.ts           Workspace name and agent prompt for a task
src/textile.ts          Textile → Markdown for descriptions and comments
src/i18n/               Translations: en.ts (source), es.ts, index.ts (translate, locale resolution)
src/protocol.ts         Typed panel <-> worker contract
src/worker.ts           Node worker: network, secrets, CLI, terminal, palette command
src/panel.tsx           Orca components panel (TSX, no build step)
src/**/*.test.ts(x)     Tests (`orca plugin test`)
src/panel.check.ts      Scenarios for `orca plugin check` (`list` and `detail` use sample data, for `orca plugin shot . --scenario`)
```

## Settings

In Orca: **Settings → Plugins → Redmine**.

| Setting                                  | Default        | What it does                                                                                                    |
| ---------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------- |
| Redmine URL                              | —              | Base address. The API key is entered in the panel and stored encrypted.                                          |
| Tasks per page                           | 50             | How many tasks the list loads.                                                                                   |
| Instructions for a new-workspace agent   | empty          | Template for what the agent is asked to do; the task context is appended after it. Editable per launch.         |
| Prompt for “Send to agent”               | empty          | Template typed into a terminal (no Enter; newlines become spaces).                                               |
| Comments in the agent context            | Latest 5       | `No comments`, `Latest 5 comments` or `Full history`. Changeable per launch in the panel.                       |
| Maximum context size (characters)        | 12000          | Cap for the context block; when the history does not fit, the oldest comments are left out first.              |

Templates accept `{id}`, `{subject}`, `{url}`, `{project}`, `{tracker}`, `{status}`, `{priority}` and `{assignee}`. Empty means a default in Orca's language. For example:

```text
Implement Redmine task #{id} ({tracker}, priority {priority}): {subject}
{url}
Read the context below, write tests, and open a merge request against develop.
```

## Translations

The panel shows every string through `t(key)`, in Orca's UI language (`env.locale`), falling back to English. The worker gets no locale from Orca, so:

- it throws **error codes** (`unauthorized`, `network`, `orca_cli`…) that the panel translates (`errors.<code>`), with untranslated detail in the message;
- requests that produce text for the user (`sendToAgent`, `launchWorkspace`) carry the panel's `locale`;
- the palette command uses the machine's locale.

Text handed to agents as context (the fenced task block) stays in English, as Orca does. The manifest (name, command title, settings) has no localization support in Orca, so it is English only.

To add a language: copy `src/i18n/es.ts` to `src/i18n/<lang>.ts`, translate it, and register it in `src/i18n/index.ts`. A test checks that every catalog has the same keys and placeholders as English.

## How the plugin knows a workspace's project

The plugin API only exposes the focused workspace's name, branch and terminals. The worker runs `orca worktree list` and `orca project list` (cached for 15 s) and matches the worktree by name and branch to get its Orca `projectId` and stable id. If the CLI is not on the worker's PATH, set `ORCA_CLI`.

Mappings (Orca project → Redmine project, workspace → task) live in the plugin's storage. Orca rejects Redmine URLs in `orca reference`, so they do not appear as native workspace links.

## Creating a workspace from a task

How Orca does it for its integrations (source at github.com/stablyai/orca: `src/shared/workspace-name.ts`, `src/renderer/src/lib/linked-work-item-context.ts`, `src/renderer/src/lib/new-workspace.ts`) and how this plugin mirrors it:

| Step    | Orca (GitHub / GitLab / Jira / Linear)                                           | This plugin (Redmine)                                                     |
| ------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Name    | `<key> <subject>` → 48-character slug (`sta-335-fix-login`, `issue-123`)         | `<number>-<subject>` → `37046-apply-the-brand-guide`                      |
| Branch  | Orca's configured branch prefix + the slug                                       | the same: Orca applies its prefix                                         |
| Link    | the worktree's `linkedItems` (`--reference`, `--issue`, `--linear-issue`…)       | Orca rejects Redmine URLs: stored in the plugin and in `--comment`        |
| Prompt  | `issueCommand` template (default `Complete {{artifact_url}}`) + context          | editable instructions (localized default) + context                       |
| Context | `BEGIN/END LINKED WORK ITEM CONTEXT` block, untrusted, at most 12,000 characters | the same format: subject, metadata, description, last 5 comments          |
| Agent   | chosen in the composer (chat or terminal per your setting)                       | `orca worktree create --agent <id> --prompt …` (the same launch path)     |

The command the worker runs:

```sh
orca worktree create --project <orca-project> --name <number-subject> --no-parent \
  --agent claude --prompt "<instructions + context>" [--base-branch develop] \
  --comment "Redmine #N: subject" [--activate] --json
```

It gives up after 115 s (a panel request waits at most 120 s); a slow repo setup may still finish creating the workspace.

## Permissions

`trusted-worker` profile: the worker runs as a Node process with your user's access on that machine (needed for the network and the `orca` CLI).

| Capability       | Why                                                        |
| ---------------- | ---------------------------------------------------------- |
| `settings:own`   | Redmine URL and page size (editable in Settings)           |
| `secrets:own`    | API key, encrypted in the OS keychain                      |
| `workspace:read` | Name, branch and terminals of the focused workspace        |
| `terminal:send`  | Type the task prompt into the chosen terminal              |

## Development

```sh
orca plugin validate .
orca plugin test .            # unit tests (panel, worker, client, i18n)
orca plugin check .           # renders the panel in each scenario of panel.check.ts
orca plugin dev watch . --check --shot .orca/shots   # load into Orca with hot reload (asks for --approve)
orca plugin open local.redmine-tasks --panel redmine   # a dev folder loads as local.*; an install as plozmun.*
```

Official guide: `orca skills get orca-plugin-authoring` (and `--references`).
Note: with Orca 1.4.246, `orca plugin types` fails because the installed app lacks the `.d.ts` files, so `npx tsc -p .` does not work until that is fixed. Tests and `check` work.

## Ideas

- When `workspace.created` fires, comment on the task or move it to "In progress".
- An activity picker for time entries (`/enumerations/time_entry_activities.json`) when Redmine has no default activity.
- More languages in `src/i18n/`.

## License

Code: [MIT](LICENSE). The images in `assets/` are an exception, see below.

## Credits

The plugin icon and cover (`assets/`) use the Redmine logo by Martin Herr, released under [CC BY-SA 2.5](https://creativecommons.org/licenses/by-sa/2.5/) ([source](https://github.com/edavis10/redmine_logo/)). These images are shared under the same license. Redmine is a trademark of its owners; this plugin is not affiliated with the Redmine project.
