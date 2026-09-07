#!/usr/bin/env node
/**
 * tsk - a local, file-backed task tracker.
 *
 * Source of truth : one Markdown file per task in ./tasks, YAML frontmatter + free-form body.
 * Derived view    : ./exports/tasks.csv, regenerated on every write. Read-only. Safe to open in Excel.
 *
 * Zero dependencies. Binds to 127.0.0.1 only.
 */
import { createServer } from 'node:http';
import { readFile, writeFile, readdir, mkdir, rename, unlink } from 'node:fs/promises';
import { existsSync, watch } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = join(ROOT, 'tasks');
const ARCHIVE_DIR = join(ROOT, 'archive');
const EXPORTS_DIR = join(ROOT, 'exports');
const CONFIG_PATH = join(ROOT, 'config.json');

const STATUSES = ['inbox', 'next', 'in-progress', 'waiting', 'blocked', 'done'];
const PRIORITIES = ['P1', 'P2', 'P3'];
const KINDS = ['client', 'internal', 'admin'];
const TICKET_TYPES = ['JIRA', 'SNOW'];
const TICKET_ALIASES = { SERVICENOW: 'SNOW', 'SERVICE-NOW': 'SNOW', SN: 'SNOW', J: 'JIRA' };

// Emission order for frontmatter keys. Anything not listed is appended, so extra
// fields written by Kiro or Copilot survive a round-trip instead of being dropped.
const FIELD_ORDER = [
  'id', 'title', 'status', 'org', 'kind', 'priority', 'due',
  'waiting_on', 'waiting_since', 'tickets', 'tags', 'created', 'updated',
];

// The base URLs default to blank rather than to an example host: an unconfigured
// your-company.service-now.com is a real third party's tenant, and a ticket chip must
// never send a key somewhere Ian did not point it. Blank renders the chip as plain
// text. config.example.json carries the shape to copy.
const DEFAULT_CONFIG = {
  jiraBaseUrl: '',
  serviceNowBaseUrl: '',
  orgs: ['Internal'],
  port: 7337,
};

/* ---------------------------------------------------------------- frontmatter */

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

function unquote(s) {
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    const inner = s.slice(1, -1);
    return s[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner.replace(/''/g, "'");
  }
  return s;
}

// Split a flow-sequence body on commas that sit outside quotes, so a quoted
// item may itself contain a comma. Our own emitter produces exactly that.
function splitList(inner) {
  const out = [];
  let buf = '';
  let quoteChar = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quoteChar) {
      if (c === '\\' && quoteChar === '"' && i + 1 < inner.length) { buf += c + inner[++i]; continue; }
      if (c === quoteChar) quoteChar = null;
      buf += c;
    } else if (c === '"' || c === "'") {
      quoteChar = c;
      buf += c;
    } else if (c === ',') {
      out.push(buf);
      buf = '';
    } else {
      buf += c;
    }
  }
  out.push(buf);
  return out;
}

function parseScalar(raw) {
  const v = raw.trim();
  if (v === '' || v === 'null' || v === '~') return null;
  if (v.startsWith('[') && v.endsWith(']')) {
    return splitList(v.slice(1, -1)).map((s) => unquote(s.trim())).filter((s) => s !== '');
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  return unquote(v);
}

function parseFrontmatter(text) {
  const m = text.match(FM_RE);
  if (!m) return { data: {}, body: text };

  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let raw = line.slice(idx + 1);
    // Trailing comments only count when set off by 2+ spaces, so a "#tag" inside
    // a title is not mistaken for one.
    if (!/^\s*["'[]/.test(raw)) raw = raw.replace(/\s{2,}#.*$/, '');
    data[key] = parseScalar(raw);
  }
  return { data, body: text.slice(m[0].length) };
}

function needsQuote(s) {
  return (
    s === '' ||
    s !== s.trim() ||
    /^[[\]{}>|*&!%@`,#?:'"-]/.test(s) ||
    /:\s/.test(s) ||
    /[\n\r]/.test(s) ||
    /^(true|false|null|~)$/i.test(s) ||
    /^-?\d+(\.\d+)?$/.test(s)
  );
}

function quote(s) {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ') + '"';
}

function emitScalar(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    const items = v.map((x) => {
      const s = String(x);
      // A colon inside a flow sequence is the one construct YAML parsers disagree on:
      // [JIRA:HCP-1] reads as a list of one map to some of them. Quoting keeps a
      // ticket a plain string no matter what parses the file.
      return needsQuote(s) || s.includes(',') || s.includes(':') ? quote(s) : s;
    });
    return '[' + items.join(', ') + ']';
  }
  const s = String(v);
  return needsQuote(s) ? quote(s) : s;
}

function serializeTask(task) {
  const { body, file, ...data } = task;
  const known = FIELD_ORDER.filter((k) => k in data);
  const extra = Object.keys(data).filter((k) => !FIELD_ORDER.includes(k));
  const lines = [...known, ...extra].map((k) => `${k}: ${emitScalar(data[k])}`.trimEnd());
  const text = String(body ?? '').replace(/^\n+/, '').trimEnd();
  return `---\n${lines.join('\n')}\n---\n\n${text}\n`;
}

/* ---------------------------------------------------------------- task store */

function slugify(title) {
  const s = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return s || 'task';
}

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const today = () => nowStamp().slice(0, 10);

// Tickets are stored as "TYPE:KEY" strings in one inline list, which is all the flat
// frontmatter format can carry:  tickets: [JIRA:HCP-4821, SNOW:INC0012345]
// The old single `jira:` key folds in here, so pre-existing files and API callers that
// still send `jira` keep working; the field is dropped the next time the file is saved.
function normalizeTickets(value, legacyJira) {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  if (!raw.length && legacyJira) raw.push(String(legacyJira));

  const out = [];
  for (const item of raw) {
    const s = item && typeof item === 'object' ? `${item.type ?? ''}:${item.key ?? ''}` : String(item);
    const idx = s.indexOf(':');
    const key = (idx === -1 ? s : s.slice(idx + 1)).trim().toUpperCase();
    if (!key) continue;
    let type = idx === -1 ? '' : s.slice(0, idx).trim().toUpperCase();
    type = TICKET_ALIASES[type] ?? type;
    if (!TICKET_TYPES.includes(type)) type = 'JIRA';
    const joined = `${type}:${key}`;
    if (!out.includes(joined)) out.push(joined);
  }
  return out;
}

function normalize(data) {
  const t = { ...data };
  t.title = String(t.title ?? '').trim() || 'Untitled';
  t.status = STATUSES.includes(t.status) ? t.status : 'inbox';
  t.priority = PRIORITIES.includes(t.priority) ? t.priority : 'P2';
  t.org = t.org ? String(t.org).trim() : 'Internal';
  t.kind = KINDS.includes(t.kind) ? t.kind : t.org.toLowerCase() === 'internal' ? 'internal' : 'client';
  t.due = t.due ? String(t.due).slice(0, 10) : null;
  t.tickets = normalizeTickets(t.tickets, t.jira);
  delete t.jira;
  t.waiting_on = t.waiting_on ? String(t.waiting_on).trim() : null;
  t.waiting_since = t.waiting_on ? t.waiting_since || today() : null;
  t.tags = Array.isArray(t.tags) ? t.tags.map(String) : t.tags ? [String(t.tags)] : [];
  // Hand-written files often omit the timestamps; backfill so sorting and the
  // CSV never see blanks, and the next save persists them.
  t.created = t.created || t.updated || nowStamp();
  t.updated = t.updated || t.created;
  return t;
}

async function loadAll() {
  const names = (await readdir(TASKS_DIR)).filter((n) => n.toLowerCase().endsWith('.md'));
  const tasks = [];
  for (const name of names) {
    try {
      const text = await readFile(join(TASKS_DIR, name), 'utf8');
      const { data, body } = parseFrontmatter(text);
      if (!data.id) continue; // not a task file
      tasks.push({ ...normalize(data), body, file: name });
    } catch (err) {
      console.warn(`  ! skipped ${name}: ${err.message}`);
    }
  }
  return tasks.sort((a, b) => String(b.updated ?? '').localeCompare(String(a.updated ?? '')));
}

// Archived filenames count too. Without them, archiving the highest-numbered task
// would hand its id straight back out and collide inside archive/.
async function nextId(tasks) {
  const fromTasks = tasks.map((t) => String(t.id));
  const fromArchive = await readdir(ARCHIVE_DIR).catch(() => []);
  const max = [...fromTasks, ...fromArchive].reduce((m, s) => {
    const n = Number(String(s).match(/TSK-(\d+)/i)?.[1] ?? String(s).match(/(\d+)/)?.[1] ?? 0);
    return n > m ? n : m;
  }, 0);
  return `TSK-${String(max + 1).padStart(4, '0')}`;
}

async function writeTask(task, previousFile) {
  const wanted = `${task.id}-${slugify(task.title)}.md`;
  await writeFile(join(TASKS_DIR, wanted), serializeTask({ ...task, file: undefined }), 'utf8');
  if (previousFile && previousFile !== wanted && existsSync(join(TASKS_DIR, previousFile))) {
    await unlink(join(TASKS_DIR, previousFile));
  }
  return { ...task, file: wanted };
}

/* ---------------------------------------------------------------- csv export */

function csvCell(v) {
  let s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join('; ') : String(v);
  s = s.replace(/\r?\n/g, ' ').trim();
  if (/^[=+@\t\r]/.test(s)) s = "'" + s; // neutralise Excel formula injection
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function nextAction(body) {
  const m = String(body ?? '').match(/^##+[ \t]*next action[ \t]*$([\s\S]*?)(?=^##+[ \t]|$(?![\s\S]))/im);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

const CSV_COLUMNS = [
  'id', 'title', 'status', 'org', 'kind', 'priority', 'due',
  'waiting_on', 'waiting_since', 'tickets', 'tags', 'created', 'updated', 'next_action', 'file',
];

const CSV_PATH = join(EXPORTS_DIR, 'tasks.csv');

// Always re-reads the folder rather than taking a task list, so a write by Kiro or
// by hand produces the same export as a write through the API.
async function exportCsv() {
  const tasks = await loadAll();
  const rows = [CSV_COLUMNS.join(',')];
  for (const t of tasks) {
    rows.push(CSV_COLUMNS.map((c) => csvCell(c === 'next_action' ? nextAction(t.body) : t[c])).join(','));
  }
  const next = '﻿' + rows.join('\r\n') + '\r\n';

  // Skip identical writes. Excel and OneDrive both notice every touch of this file,
  // and the watcher below can fire several times for one save.
  if ((await readFile(CSV_PATH, 'utf8').catch(() => null)) === next) return false;
  await writeFile(CSV_PATH, next, 'utf8');
  return true;
}

let exportTimer = null;
let watching = false;

let exportWarned = false;

// Debounced and off the request path. A CSV locked open in Excel must not fail the
// write that triggered it — the Markdown file is the source of truth and is already saved.
function scheduleExport(delay = 150) {
  if (exportTimer) clearTimeout(exportTimer);
  exportTimer = setTimeout(runExport, delay);
}

async function runExport() {
  exportTimer = null;
  try {
    await exportCsv();
    if (exportWarned) {
      console.log('  csv export recovered');
      exportWarned = false;
    }
  } catch (err) {
    // Almost always the file being held open by Excel. Keep retrying quietly so the
    // export lands the moment it is released, rather than waiting for the next edit.
    if (!exportWarned) {
      console.warn(`  ! tasks.csv is not writable (${err.code ?? err.message}); retrying until it is`);
      exportWarned = true;
    }
    exportTimer = setTimeout(runExport, 5000);
  }
}

// Keeps the CSV current when a task file is created or edited outside the app, and
// when the browser is not even open. persistent:false so it never holds the process up.
function watchTasks() {
  try {
    const watcher = watch(TASKS_DIR, { persistent: false }, (_event, filename) => {
      if (filename && !String(filename).toLowerCase().endsWith('.md')) return;
      scheduleExport();
    });
    watcher.on('error', (err) => console.warn(`  ! tasks watcher stopped: ${err.message}`));
    return true;
  } catch (err) {
    console.warn(`  ! cannot watch ${TASKS_DIR}: ${err.message}`);
    return false;
  }
}

/* ---------------------------------------------------------------- http */

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const payload = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 2 * 1024 * 1024) throw new Error('payload too large');
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

async function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    await writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
    return { ...DEFAULT_CONFIG };
  }
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(await readFile(CONFIG_PATH, 'utf8')) };
  } catch {
    console.warn('  ! config.json is not valid JSON, using defaults');
    return { ...DEFAULT_CONFIG };
  }
}

async function handle(req, res) {
  const path = new URL(req.url, 'http://localhost').pathname;

  if (path === '/' || path === '/index.html') {
    return send(res, 200, await readFile(join(ROOT, 'app.html'), 'utf8'), 'text/html; charset=utf-8');
  }

  if (path === '/api/config' && req.method === 'GET') {
    const cfg = await loadConfig();
    const tasks = await loadAll();
    const orgs = [...new Set([...cfg.orgs, ...tasks.map((t) => t.org)])].filter(Boolean).sort();
    return send(res, 200, { ...cfg, orgs, statuses: STATUSES, priorities: PRIORITIES, kinds: KINDS });
  }

  if (path === '/api/tasks' && req.method === 'GET') {
    // Fallback for when fs.watch is unavailable, as on some network or synced folders.
    if (!watching) scheduleExport();
    return send(res, 200, await loadAll());
  }

  if (path === '/api/tasks' && req.method === 'POST') {
    const input = await readJson(req);
    const tasks = await loadAll();
    const stamp = nowStamp();
    const task = normalize({ ...input, id: await nextId(tasks), created: stamp, updated: stamp });
    task.body = input.body ?? '## Next action\n\n\n## Log\n';
    const saved = await writeTask(task, null);
    scheduleExport();
    return send(res, 201, saved);
  }

  const idMatch = path.match(/^\/api\/tasks\/([A-Za-z0-9._-]+)$/);
  if (idMatch) {
    const id = decodeURIComponent(idMatch[1]);
    const tasks = await loadAll();
    const existing = tasks.find((t) => String(t.id) === id);
    if (!existing) return send(res, 404, { error: `no task ${id}` });

    if (req.method === 'PATCH') {
      const patch = await readJson(req);
      delete patch.id;
      delete patch.created;
      delete patch.file;
      // Clearing waiting_on clears the since-date too, so a re-block restarts the clock.
      if ('waiting_on' in patch && !patch.waiting_on) patch.waiting_since = null;
      // The old `jira` key still works on input and keeps its original replace-the-field
      // meaning: it sets the ticket list, and an explicit null or empty string clears it.
      // Appending instead would leave a caller no way to correct a wrong key.
      if ('jira' in patch && !('tickets' in patch)) patch.tickets = patch.jira ? [String(patch.jira)] : [];
      const merged = normalize({ ...existing, ...patch, updated: nowStamp() });
      merged.body = 'body' in patch ? patch.body : existing.body;
      const saved = await writeTask(merged, existing.file);
      scheduleExport();
      return send(res, 200, saved);
    }

    if (req.method === 'DELETE') {
      await rename(join(TASKS_DIR, existing.file), join(ARCHIVE_DIR, existing.file));
      scheduleExport();
      return send(res, 200, { archived: id });
    }
  }

  send(res, 404, { error: 'not found' });
}

/* ---------------------------------------------------------------- boot */

for (const dir of [TASKS_DIR, ARCHIVE_DIR, EXPORTS_DIR]) await mkdir(dir, { recursive: true });
const config = await loadConfig();

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(`  ! ${req.method} ${req.url}: ${err.stack}`);
    send(res, 500, { error: String(err.message ?? err) });
  });
});

function listen(port, attempt = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 10) return listen(port + 1, attempt + 1);
    console.error(err.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', async () => {
    const url = `http://localhost:${port}/`;
    await exportCsv();
    watching = watchTasks();
    console.log(`\n  tsk  ->  ${url}`);
    console.log(`  tasks: ${TASKS_DIR}`);
    console.log(`  csv:   ${CSV_PATH}${watching ? '  (auto-updates)' : '  (updates when the board loads)'}`);
    console.log(`\n  Ctrl+C to stop.\n`);
    if (process.argv.includes('--open')) {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    }
  });
}

listen(Number(process.env.TSK_PORT) || config.port || 7337);
