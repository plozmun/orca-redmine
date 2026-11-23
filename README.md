# Redmine for Orca

An Orca plugin (`plozmun.redmine-tasks`) that brings your Redmine tasks into the sidebar and ties them to Orca workspaces and agents.

> Orca does not yet let plugins add *task sources* or *connections* (how the native Jira and Linear integrations work): those contribution points are reserved. This plugin gives a similar experience with a **sidebar panel** and a **Node worker** that calls the Redmine REST API and the `orca` CLI.

## Install

Requires Orca 1.4.248 or newer.

- From Orca's plugin catalog: search for **Redmine** (listing: https://www.onorca.dev/plugins/plozmun/orca-redmine).
- Or from a local clone, for development: `orca plugin dev load <path-to-clone>`.

It runs a worker with your user's access (see [Permissions](#permissions)), so Orca asks you to approve it on first load.

## Features

- **Redmine panel** (flag icon, right sidebar): a header with the server and your user, tiles with your open, overdue and urgent tasks, then your tasks (or everyone's), searchable by subject or `#number`, filtered by status (open by default, closed, any, or one status; the choice is kept).
- **Task detail**: a header with the number, tracker and status; a card with the title, project, assignee, priority, done ratio (with a progress bar) and the status picker; then *Launch agent* and *Send to terminal*, each opening its form underneath; then description, history and time. Redmine's Textile (numbered lists, `h2.` headings, `!image.png!`, `<pre>`) is shown as Markdown. When the focused workspace has a task assigned, the panel opens it (also after switching workspaces); a workspace without one shows the list. *Back* lets you browse the list meanwhile.
- **Change status**, **comment** and **log time** without leaving Orca. Time goes to today, a day of the past week, or a typed date (`YYYY-MM-DD`, never a future one).
- **A Redmine project per Orca project**: map each Orca project (repository) once to a Redmine project, with a filter to find it among many. All its workspaces use it to filter the list. Remove it with ✕.
- **A task per workspace**: each workspace can have one task assigned, or none. Stored by the stable worktree id, so renaming the workspace keeps it. When the workspace name or branch names a task (`12345-login`, `feature/12345-login`, `#12345`, `rm-12345`), the panel offers to assign it.
- **Automatic link at creation**: a worktree created any way (Orca's dialog, the CLI, automations, other agents) whose name or branch names a task you can see in Redmine is linked to it. If its Orca project is mapped to a Redmine project, the task must be in that project or a subproject. A workspace that already has another task is left alone.
- **Team branch names** (optional): with a branch template such as `{tracker}/{id}-{slug}`, a new task workspace gets `feature/4077-checkout-with-saved-cards`. If Redmine does not answer within 1.5 s, Orca's branch is kept; a creation is never refused.
- **The task number in the environment**: every agent started in a linked workspace — Orca's new tab, a workspace creation, an automation, orchestration, the CLI — gets `REDMINE_ISSUE=<number>`, so git hooks, scripts and the agent itself can run `redmine issues get $REDMINE_ISSUE`. The decision uses the local link store only (no Redmine call, so a start is never slowed). Nothing else is exported: no URL, no API key, no file.
- **Record the start in Redmine** (optional, off by default): a comment naming the workspace and branch, and optionally a move from the first open status (New) to the next one.
- **Follow-ups after agent work**: when the main agent of a workspace linked to a task finishes (success, failure or Orca could not tell), or when a linked worktree is removed, a follow-up appears at the top of the task list. One click opens the task, comments, changes status, logs time (pre-filled with the agent's working time, rounded to 0.25 h) or dismisses it. **Nothing is written to Redmine without that click**, and follow-ups survive closing the panel and restarting Orca.
- **Optional notification** (off by default): a desktop notification when an agent on a linked task finishes (`done`) or also when it needs input (`doneAndBlocked`). It names the task number and subject only, never the description or comments.
- **Launch agent → New workspace**: from a task, create a worktree in an Orca project, start an agent with the task context, and assign the task to the new workspace — like Orca does for GitHub, GitLab, Jira and Linear.
- **Launch agent → This workspace**: starts the chosen agent in a new terminal of the current workspace with the same instructions and context, and assigns the task to it when it has none. If the prompt would exceed Orca's 4,096-character limit, the context goes in the file *Send to terminal* uses and the prompt points to it.
- **Send to terminal**: types the task prompt into a terminal of the current workspace. It **does not press Enter**, so you can review it first. A terminal line cannot carry the description and comments, so they go in a file (`<tmp>/orca-redmine/<id>.md`, readable only by you) that the prompt points to.
- **Works without redmine-cli**: agents get the task text from the plugin. When the [`redmine` CLI](#redmine-cli) is installed, the prompt also tells the agent it can use it to update the task; when it is not, the panel suggests installing it.
- **Command palette**: `Redmine: my open tasks`.
- **Agent state in the list** (Orca with host API 1.7 or later): a task whose linked workspace has an agent working, waiting for permission, or done and not yet looked at shows it in its row, kept current while the panel is open.
- **Status bar count**: the number of open tasks assigned to you, beside a flag, with the Redmine panel one press away. Amber when one is overdue, red when one has an urgent or immediate priority; hover for the counts. It refreshes every few minutes, right after the panel changes a task, and is hidden while Redmine is not connected or you turn it off in Settings. The worker therefore runs for as long as the plugin is enabled.
- **English and Spanish UI**, following Orca's language.

## Usage

1. Open the Redmine panel and connect with the URL and your API key (*My account → API access key*). The key is validated, then stored encrypted in the OS keychain.
2. In a workspace, pick the Redmine project for its Orca project.
3. Open a task and either **assign it to this workspace**, **launch an agent in a new workspace** for it, or **launch an agent here** to work in the workspace you are in.
4. When done: change the status, log the time, and leave a comment with the PR/MR link.

## Layout

```
orca-plugin.json        Manifest: panel, command, settings and capabilities
assets/                 Plugin icon and cover for the plugin page
src/redmine.ts          Redmine REST API client (no Orca dependency)
src/orca-workspaces.ts  Locates the focused workspace and its project (host listing, then `orca` CLI), agent states, creates worktrees
src/launch.ts           Workspace name and agent prompt for a task
src/agent-env.ts        `REDMINE_ISSUE` and the optional prompt pointer for agents
src/launch-here.ts      Prompt for "Launch agent here" when the context does not fit inline
src/task-ref.ts         Task number in a workspace name or branch; branch template
src/followups.ts        Agent-finish and workspace-removal follow-ups: transitions, working time, store rules
src/plugin-key.ts       Which qualified plugin key (catalog or dev folder) the worker has
src/links.ts            Storage keys for workspace ↔ task links
src/days.ts             Calendar days for time entries (picker choices, bookable-day check)
src/agent-files.ts      Context file for "Send to agent" and the `redmine` CLI check
src/textile.ts          Textile → Markdown for descriptions and comments
src/i18n/               Translations: en.ts (source), es.ts, index.ts (translate, locale resolution)
src/protocol.ts         Typed panel <-> worker contract
src/worker.ts           Node worker: network, secrets, CLI, terminal, status bar, commands
src/panel.tsx           Orca components panel (TSX, no build step)
src/**/*.test.ts(x)     Tests (`orca plugin test`)
src/panel.check.ts      Scenarios for `orca plugin check` (`list`, `detail`, `followups` and `launchHere` use sample data, for `orca plugin shot . --scenario`)
```

## Settings

In Orca: **Settings → Plugins → Redmine**.

| Setting                                  | Default        | What it does                                                                                                    |
| ---------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------- |
| Redmine URL                              | —              | Base address. The API key is entered in the panel and stored encrypted.                                          |
| Tasks per page                           | 50             | How many tasks the list loads.                                                                                   |
| Instructions for a new-workspace agent   | empty          | Template for what the agent is asked to do; the task context is appended after it. Editable per launch.         |
| Prompt for “Send to agent”               | empty          | Template typed into a terminal (no Enter; newlines become spaces). `{contextFile}` places the context file's path; without it, a sentence pointing to the file is appended. |
| Comments in the agent context            | Latest 5       | `No comments`, `Latest 5 comments` or `Full history`. Changeable per launch in the panel.                       |
| Maximum context size (characters)        | 12000          | Cap for the context block; when the history does not fit, the oldest comments are left out first.              |
| Branch name for task workspaces          | empty          | Branch template for new workspaces that name a task: `{id}`, `{slug}` (task title), `{tracker}`, `{project}`, lower-cased and made git-safe. Empty keeps Orca's branch. |
| When a workspace is created for a task   | Nothing        | `Nothing`, `Add a comment` (*Work started in Orca workspace `name` (branch `branch`)*, in the machine's language), or also move a task in the first open status to the next open status. |
| Name the task in launch prompts          | Off            | When an agent starts in a linked workspace, one line naming the task (`#N`, subject, URL) is appended to the launch prompt Orca submits, unless the prompt already names it. |
| Notification when an agent finishes      | Off            | `Off`, `When an agent finishes`, or `When an agent finishes or needs input`. The follow-up always appears in the panel; this only adds a desktop notification with the task number and subject. |
| Show my open tasks in the status bar     | On             | The count beside the flag in Orca's status bar. Off hides the item and stops its refresh.                                                       |
| Refresh the status bar count every       | 5 minutes      | 1–60 minutes. The count also refreshes right after the panel changes a task or saves the connection.                                            |

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

## redmine-cli

The plugin talks to the Redmine REST API itself and does not need [redmine-cli](https://github.com/aarondpn/redmine-cli). An agent does, though, to comment on, change or log time on the task by itself. The worker checks `redmine --version` (cached for 60 s; set `REDMINE_CLI` if it is not on the worker's PATH):

- installed: the launch and send prompts add *"The `redmine` CLI is available to read or update task #N."* The CLI keeps its own login (`redmine auth`); the plugin does not share its API key.
- not installed: the Agent section suggests installing it and its agent skill.

Agents started in a linked workspace also find the task number in `REDMINE_ISSUE`, so `redmine issues get $REDMINE_ISSUE` works without the agent having to parse its prompt. The variable, and nothing else, is added by the `agent.launch.before` hook; `promptPointer` optionally names the task in the launch prompt itself.

## How the plugin knows a workspace's project

The plugin API gives the focused workspace's name, branch, terminals and (host API 1.7 and later) its `workspace.list` id. The worker finds that row in Orca's `workspace.list`, by id or else by name and branch, to get the stable id tasks are linked to and, from host API 1.7, the Orca project it belongs to. That host id (`identity:<key>`) is also what Orca's workspace methods take, so *Launch agent here* finds the focused workspace without the CLI.

On current Orca the `orca` CLI is therefore only needed to create a workspace (`orca worktree create`), to open the panel from the status bar, and once to move project mappings made by 0.2.0 or earlier: those were stored under the CLI's project ids (`git:<host>/<path>`), while the host names projects by repository id, so each mapping is copied to its repositories' ids (the old key stays). On older Orca the worker still runs `orca worktree list` and `orca project list` (cached for 15 s) for the project, and for the stable id when `workspace.list` is missing. If the CLI is not on the worker's PATH, set `ORCA_CLI`.

Mappings (Orca project → Redmine project, workspace → task) live in the plugin's storage (`storage:own`), shared by the panel and the worker; 0.1.x kept them in the panel only and they are copied over once. Orca rejects Redmine URLs in `orca reference`, so they do not appear as native workspace links.

When a worktree is created, Orca's `workspace.created` event names it by the CLI's `<repoId>::<path>` id, so the worker looks it up in `orca worktree list` (and `workspace.list` by path) to get the same stable key. Task references: the name (else the branch) starting with a number of 3+ digits (`4077-…`, last path segment), or containing `#N`, `redmine-N` or `rm-N`. A number after a word (`release-2026`, `bug-4321`) is not taken.

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
| `agent:read`     | Notice when an agent in a linked workspace finishes or blocks |
| `terminal:send`  | Type the task prompt into the chosen terminal              |
| `notifications:show` | Desktop notification when an agent finishes (off by default) |
| `agent:launch`   | Start an agent in a new terminal of the current workspace  |
| `storage:own`    | Workspace ↔ task links, follow-ups, shared by the panel and the worker |

Hooks and events (Orca waits only for the hook, at most 2 s, and carries on if it fails):

| Hook / event               | Why                                                                     |
| -------------------------- | ----------------------------------------------------------------------- |
| `workspace.create.before`  | Apply the branch template (only when one is set)                        |
| `workspace.created` event  | Link the new worktree to the task it names; optional comment/status    |
| `agent.launch.before`      | Add `REDMINE_ISSUE` for an agent started in a linked workspace (link store only, no network) |
| `agent.prompt.before`      | Optional pointer line in launch prompts (`promptPointer`, off by default) |
| `agent.status.changed` event | Record a follow-up when the main agent of a linked task finishes      |
| `workspace.removed` event  | Delete the link of a removed worktree and offer to close the task      |

Environment variables are fixed when the agent starts: re-linking the workspace does not change a running agent's `REDMINE_ISSUE`, and no other variable is added. The launch hook reads only the plugin's link store, so a Redmine that is down never delays a start.

Orca starts the worker when an event arrives, but a moment it never delivered (plugin disabled, Orca closed) is not replayed. Follow-ups live in the plugin's storage, so they are still there the next time the panel opens.

The status bar item is why the worker keeps running while the plugin is enabled, instead of only when the panel or a command asks. It counts with `limit=1` Redmine queries (three, plus one for the priority list once per run) on the configured interval and after the panel changes something; pressing it runs `orca plugin open <plugin-key> --panel redmine`, so it needs the `orca` CLI on the worker's PATH.

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

- An activity picker for time entries (`/enumerations/time_entry_activities.json`) when Redmine has no default activity.
- More languages in `src/i18n/`.

## License

Code: [MIT](LICENSE). The images in `assets/` are an exception, see below.

## Credits

The plugin icon and cover (`assets/`) use the Redmine logo by Martin Herr, released under [CC BY-SA 2.5](https://creativecommons.org/licenses/by-sa/2.5/) ([source](https://github.com/edavis10/redmine_logo/)). These images are shared under the same license. Redmine is a trademark of its owners; this plugin is not affiliated with the Redmine project.
