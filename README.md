# tsk

A local, keyboard-first task board for client and internal work. No accounts, no cloud, no
database server. Your tasks are plain Markdown files you can read, grep, diff, and hand to
an AI coding agent.

## Run it

Double-click **`tsk.cmd`**. It starts a tiny local server and opens the board in your browser.
Close the console window to stop it.

Requires [Node.js](https://nodejs.org) (LTS). Nothing else — there are no npm dependencies.

To move it to another PC, copy the whole folder. To back it up or sync it, `git init` the
folder or drop it in OneDrive; every task is a small text file, so diffs stay readable.

## Where your data lives

| Path                | What it is                                                        |
| ------------------- | ----------------------------------------------------------------- |
| `tasks/*.md`        | **Source of truth.** One file per task.                            |
| `exports/tasks.csv` | **Derived.** Rewritten on every change. Open it in Excel any time. |
| `archive/*.md`      | Archived tasks. Nothing is ever deleted, just moved here.          |
| `config.json`       | Your JIRA base URL, known orgs, port.                              |

`tasks.csv` is a read-only view. Editing it does nothing — the `.md` files win, and your edit
is overwritten on the next change. This is deliberate: three writers (you, Kiro, Copilot) on
one CSV is how you lose a week of tasks to a bad quote character.

## Set your JIRA link

Open `config.json` and set `jiraBaseUrl` to your instance:

```json
{
  "jiraBaseUrl": "https://your-company.atlassian.net/browse/",
  "orgs": ["Internal", "Acme Health"],
  "port": 7337
}
```

Any task with a `jira` key then gets a clickable chip straight to the ticket. Orgs listed
here seed the filter dropdown; orgs you type on tasks are picked up automatically.

## Quick add

Type in the top bar and press Enter. Anything the parser doesn't recognise becomes the title,
so you can always just type a sentence.

```
Renew Acme SSO cert @acme !p1 due:fri HCP-4821 #auth ~Dana
```

| Token       | Sets            | Notes                                                       |
| ----------- | --------------- | ----------------------------------------------------------- |
| `@acme`     | Client / org    | Prefix-matches your known orgs, so `@acme` finds Acme Health |
| `!p1`       | Priority        | `!p1` `!p2` `!p3`                                            |
| `due:fri`   | Due date        | `today`, `tomorrow`, `mon`–`sun`, `eow`, `+3d`, `+2w`, `9/15`, `2026-09-15` |
| `#auth`     | Tag             | Repeatable                                                   |
| `~Dana`     | Waiting on      | Also moves the task to **Waiting**. Use `~Dana_Ops` for spaces |
| `HCP-4821`  | JIRA key        | Any bare `ABC-123` shaped word                               |

Keys: `n` or `/` focuses quick-add, `Esc` closes the detail panel. Drag cards between columns.
In the detail panel every field saves on blur — there is no Save button.

## The task file format

```markdown
---
id: TSK-0042
title: SSO timeout on Acme prod after 2.14 deploy
status: in-progress          # inbox | next | in-progress | waiting | blocked | done
org: Acme Health             # client name, or "Internal"
kind: client                 # client | internal | admin
priority: P1                 # P1 | P2 | P3
due: 2026-09-08              # YYYY-MM-DD, or blank
waiting_on: Dana (Eng)       # who owes you something, or blank
waiting_since: 2026-09-03    # set automatically when waiting_on is filled in
jira: HCP-4821               # ticket key, or blank
tags: [auth, escalation]
created: 2026-09-03T14:02
updated: 2026-09-03T16:20
---

## Next action
Get Eng to confirm the token TTL change lands in 2.14.1.

## Log
- 2026-09-03 — Client reports 15-min logouts. Repro'd in DBeaver, session rows expiring early.
```

Everything below the `---` is free-form Markdown; only the `## Next action` heading is special
(its first line shows on the card, and the whole section becomes the `next_action` CSV column).

Notes on hand-editing:

- **The filename doesn't matter.** `id` in the frontmatter is what identifies a task. The app
  names files `TSK-0042-slug.md` and renames on retitle, but it finds tasks by `id`.
- **Unknown fields survive.** Add `sprint: 24.9` or `client_contact: …` and the app carries it
  through every save untouched, even though it doesn't display it.
- **Blank means null.** `due:` with nothing after it is an empty due date.
- Refresh the browser to pick up files changed on disk.

## Editing tasks from Kiro or Copilot

The store is just files, so an agent creates a task by writing one, and updates one by editing
that single file. Because each task is its own file, an agent can never corrupt tasks it wasn't
asked to touch, and every change is a clean one-file diff.

Three files teach the agents the schema so you don't have to explain it each time:

| File | Read by |
| --- | --- |
| `AGENTS.md` | The canonical spec. Copilot and most other agents read it from the repo root. |
| `.kiro/steering/tsk.md` | Kiro. Generated from `AGENTS.md`, with `inclusion: always` frontmatter. |
| `.github/copilot-instructions.md` | Copilot. Short, and points at `AGENTS.md`. |

With those in place, "log a task for the Acme SSO thing, waiting on Dana" is enough.

**To use this from another repo**, copy `.kiro/steering/tsk.md` into that repo's `.kiro/steering/`.
Steering files are per-workspace, and the spec uses absolute paths so it works from anywhere.

**If you change the schema**, edit `AGENTS.md` and then regenerate the Kiro copy so the two
don't drift:

```powershell
$fm = "---`ninclusion: always`n---`n`n"
Set-Content .kiro\steering\tsk.md ($fm + (Get-Content AGENTS.md -Raw)) -Encoding utf8
```

## API

The board talks to a small local HTTP API on `127.0.0.1` only. Scripts can use it too.

| Method   | Route             | Does                                       |
| -------- | ----------------- | ------------------------------------------ |
| `GET`    | `/api/tasks`      | All tasks as JSON                          |
| `POST`   | `/api/tasks`      | Create one; allocates the next `id`        |
| `PATCH`  | `/api/tasks/:id`  | Merge changed fields into one task         |
| `DELETE` | `/api/tasks/:id`  | Move to `archive/`                         |
| `GET`    | `/api/config`     | Config plus discovered orgs and enum values |

```powershell
curl.exe -s -X POST http://localhost:7337/api/tasks -H "content-type: application/json" `
  -d '{"title":"Chase Acme on cert renewal","org":"Acme Health","priority":"P1"}'
```
