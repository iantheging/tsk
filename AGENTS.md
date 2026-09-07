# Writing tsk task files

`tsk` is a local task tracker. Every task is one Markdown file with YAML frontmatter. There is
no database and no API you must go through — creating a task means writing a file, and updating
one means editing that single file.

## Where tasks live

```
C:\Users\ianth\Dev\tsk\tasks\      active tasks
C:\Users\ianth\Dev\tsk\archive\    archived tasks (still count for id allocation)
```

Use the absolute path. If you are working in a different repository, still write the task file
into that folder — it is the single store for all of Ian's work tasks, not per-project.

## Creating a task

1. **Pick the id.** Find the highest `TSK-####` across **both** `tasks\` and `archive\`, add 1,
   and zero-pad to four digits. Archived files still hold their ids — never reuse one.
2. **Pick the filename:** `TSK-0042-short-slug.md`. The slug is the title lowercased, with every
   run of non-alphanumeric characters replaced by `-`, trimmed of leading and trailing `-`, and
   cut to 48 characters. The filename is cosmetic — `id` in the frontmatter is what identifies
   the task — but match this pattern so the folder stays sorted and readable.
3. **Write the file** using the schema below.

## Schema

```markdown
---
id: TSK-0042
title: SSO timeout on Acme prod after 2.14 deploy
status: in-progress
org: Acme Health
kind: client
priority: P1
due: 2026-09-08
waiting_on:
waiting_since:
tickets: ["JIRA:HCP-4821", "SNOW:INC0012345"]
tags: [auth, escalation]
created: 2026-09-03T14:02
updated: 2026-09-03T16:20
---

## Next action
Get Eng to confirm the token TTL change lands in 2.14.1.

## Log
- 2026-09-03 — Client reports 15-min logouts. Repro'd in DBeaver, session rows expiring early.
```

| Field | Required | Value |
| --- | --- | --- |
| `id` | yes | `TSK-` plus four digits. Immutable once written. |
| `title` | yes | One line. Plain text. Quote it if it contains `: ` or starts with punctuation. |
| `status` | yes | `inbox` · `next` · `in-progress` · `waiting` · `blocked` · `done` |
| `org` | yes | Client name, or `Internal`. Reuse an org string that already exists rather than inventing a variant — check other task files first. |
| `kind` | yes | `client` · `internal` · `admin`. Use `internal` when `org` is `Internal`, otherwise `client`. `admin` is for Ian's own overhead (timesheets, training). |
| `priority` | yes | `P1` · `P2` · `P3`. Default `P2`. |
| `due` | no | `YYYY-MM-DD`, or blank. |
| `waiting_on` | no | Person or team Ian is blocked on, e.g. `Dana (Eng)`. Blank if not blocked. |
| `waiting_since` | no | `YYYY-MM-DD` the wait started. Set it whenever you set `waiting_on`. |
| `tickets` | no | Inline list of quoted `TYPE:KEY` strings, uppercase: `["JIRA:HCP-4821", "SNOW:INC0012345"]`. Quote every item — an unquoted colon inside `[ ]` is read as a map by some YAML parsers. `TYPE` is `JIRA` or `SNOW` (ServiceNow); a bare key with no type is read as Jira. Empty is `[]`. Any number per task. Replaces the old `jira` field: files carrying `jira:` convert on their next save, so don't write it into new files. |
| `tags` | no | Inline list: `[auth, escalation]`. Empty is `[]`. Quote any item containing a comma. |
| `created` | yes | `YYYY-MM-DDTHH:MM`, local time. Never change it after creation. |
| `updated` | yes | `YYYY-MM-DDTHH:MM`, local time. Set it on every edit. |

Body: free-form Markdown. Only `## Next action` is special — its first line is shown on the
board card, so keep it to a single concrete action. `## Log` is an append-only, newest-last list
of dated lines. Include both headings on every task, even when empty.

## Status meanings

- `inbox` — captured, not yet triaged. Safe default when you are unsure.
- `next` — triaged and ready to start.
- `in-progress` — actively being worked.
- `waiting` — blocked on **someone else**. Always set `waiting_on` with it.
- `blocked` — blocked on a thing, not a person (an environment, a dependency, a decision).
- `done` — complete. Leave the file in `tasks\`; Ian archives it himself.

## Rules

- **Touch exactly one file per task.** Never rewrite, reformat, reorder, or bulk-edit other task
  files. Editing one task must never produce a diff in another.
- **Never write to `exports\tasks.csv`.** It is regenerated from the Markdown files on every
  change and your edit will be silently overwritten. It is a read-only view for Excel.
- **Never write to `archive\`** unless explicitly asked to archive something.
- **Blank means null.** `due:` with nothing after it is an empty due date. Do not write `none`,
  `N/A`, `TBD`, or `-`.
- **Extra fields are preserved.** If you need a field that isn't in the schema, add it — the app
  carries unknown frontmatter through every save untouched. Don't remove fields you don't
  recognise for the same reason.
- **Never put PHI in a task.** No patient names, MRNs, member IDs, dates of birth, or rows
  pasted from a database client. Client names, ticket keys, and system behaviour are fine.
  Describe the shape of a data problem, not the data.
- The board picks up files you create or change on its own; you do not need to ask Ian to
  refresh.

## Updating a task

Edit the one file. Set `updated`. If the change is worth remembering, append a line to `## Log`:

```markdown
## Log
- 2026-09-03 — Client reports 15-min logouts.
- 2026-09-04 — Eng confirmed TTL regression; fix targeted at 2.14.1.
```

Rewrite `## Next action` to whatever is now the single next step, rather than accumulating a
list there. When a task becomes blocked on a person, set `status: waiting`, `waiting_on`, and
`waiting_since` together.

## Optional: the HTTP API

When the app is running (`tsk.cmd`, `http://localhost:7337`), you can create tasks through it
instead. This allocates the id and refreshes the CSV for you, so prefer it *if* the server is
up; fall back to writing files when it isn't.

```powershell
curl.exe -s -X POST http://localhost:7337/api/tasks -H "content-type: application/json" `
  -d '{"title":"Chase Acme on cert renewal","org":"Acme Health","priority":"P1","tickets":["JIRA:HCP-4821"]}'
```

A `PATCH` may still send `jira` instead of `tickets`. It replaces the whole ticket list, and
`"jira": null` clears it — send `tickets` when you mean to add one to a task that already has
some, since `jira` overwrites what is there.

`GET /api/tasks` lists everything, `PATCH /api/tasks/TSK-0042` merges changed fields, and
`DELETE /api/tasks/TSK-0042` archives. The server binds to `127.0.0.1` only. Address it as `localhost`, `127.0.0.1` or `[::1]` on
its port - a request carrying any other `Host` is refused, as is a browser call to `/api/*`
from another site. `curl.exe` sends neither of the headers involved and is unaffected.
