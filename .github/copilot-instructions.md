# Repository instructions

## Task tracking

Ian tracks his work in `tsk`, a local task tracker where every task is one Markdown file with
YAML frontmatter, stored in `C:\Users\ianth\Dev\tsk\tasks\`.

**When asked to create, log, update, or close a task, follow [`AGENTS.md`](../AGENTS.md) in the
repository root.** It carries the full field schema, the id-allocation rule, and the editing
rules. Read it before writing a task file.

The three rules that matter most, repeated here so they are never missed:

- Touch exactly one file per task. Never bulk-edit or reformat other task files.
- Never write to `exports/tasks.csv`. It is regenerated from the Markdown and your edit will be
  silently overwritten.
- Never put PHI in a task: no patient names, MRNs, member IDs, dates of birth, or rows pasted
  from a database client. Client names, ticket keys, and system behaviour are fine.
