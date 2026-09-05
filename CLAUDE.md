# tsk

Ian's local, single-user task board. Node `server.mjs` serves `app.html` on
`127.0.0.1:7337`. Started by `tsk.cmd`.

**Zero dependencies, no build step, no framework, no test suite.** `server.mjs` is stdlib-only
Node; `app.html` is one file with inline CSS and JS. Keep it that way — the constraint is
deliberate, so the whole thing stays a folder you can copy to a machine with no admin rights.

## Source of truth

One Markdown file per task in `tasks\`, YAML frontmatter, archived to `archive\`.
`exports\tasks.csv` is a **generated, read-only** view for Excel — regenerated on every write,
never read as input, never edited.

Task files have no backup and three writers (Ian, Kiro, Copilot). Any change that could
truncate a file, drop unknown frontmatter fields, or touch a task it wasn't asked to touch is
the worst bug available in this codebase. Preserve unrecognised fields on every round trip.

`tasks\`, `archive\`, `exports\`, and `config.json` are gitignored — they name real clients.

## Cost constraint

tsk must stay cheaper in agent tokens than an MCP integration would be. Prefer plain file
reads and writes over anything that adds a tool schema to every request. Keep always-loaded
steering files (this one, `.kiro/steering/tsk.md`, `.github/copilot-instructions.md`) short and
push detail into files an agent reads only when it needs them. Work a user can do in the UI
costs zero agent tokens — prefer the UI for pure data capture.

## Never

- Put PHI anywhere — no patient names, MRNs, member IDs, DOBs, or rows pasted from DBeaver.
  Describe the shape of a data problem, not the data.
- Commit `tasks\`, `archive\`, `exports\`, or `config.json`.

## Review workflow

Every code change gets a senior technical review before it is finished. A `Stop` hook runs
automatically and will not let a session end with unreviewed changes: launch the
`senior-technical-review` subagent, relay its findings, and apply nothing until Ian approves.
Run it on demand with `/senior-review`.

## Reference

- `AGENTS.md` — the task-file schema and rules. Read it before writing or parsing a task file.
- `README.md` — setup and usage.
