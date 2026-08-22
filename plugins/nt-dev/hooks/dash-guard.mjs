#!/usr/bin/env node
/* Names a unicode dash the moment it is written, while the sentence is still in hand.

   The gate at https://github.com/notambourine/dash-ratchet fails a pull request on any
   unicode dash the diff adds. By the time it reports, the sentence is a commit old and the
   fix costs another push and another CI round. This hook makes the same assertion against
   the text a `Write` or an `Edit` is carrying.

   KEY-DECISION 2026-08-22: compare the counts, do not scan the payload. A file that
   already holds a dash, an `Edit` whose old_string quotes one back, a paragraph moved
   verbatim - a flat scan flags all three over a character it did not introduce, and a hook
   that does that gets switched off. The gate's rule is that the total may not rise, so that
   is the rule here, and only the lines the delta accounts for are named.

   KEY-DECISION 2026-08-22: the baseline for a landed `Write` is the merge base with the
   default branch, the same place `git diff origin/<base>...HEAD` starts. A HEAD baseline
   calls a dash the branch already committed flat and stays silent, while CI is already
   failing on it.

   KEY-DECISION 2026-08-22: one script on two events, because the answer differs. Refusing
   the write is a PreToolUse `deny`. Letting it land and still reaching the model is a
   PostToolUse `block`, whose reason the model reads before it moves on - the documented way
   to speak about a call that already happened. PreToolUse `additionalContext` is not that
   way: the docs do not say whether it arrives when the call proceeds, so the default mode
   must not be built on it.

   The character set and the marker are the gate's: U+2010 through U+2015, U+2212, and the
   mdash, ndash, and minus HTML entities, with any line carrying the marker exempt. Excludes
   and a non-default marker are read off the gate's own call, in whichever workflow of the
   target file's repo holds it, so the hook and CI cannot disagree about scope. A repo with
   no gate still gets the check, because the prose rule is ours whatever CI a given repo
   runs.

   Config, via `env` in a repo's .claude/settings.json or the user's:
     NT_DEV_DASH_GUARD=strict   refuse the write
     NT_DEV_DASH_GUARD=off      do nothing
   Unset is the default: the write lands, and the model gets the lines to rewrite. A dash is
   a sentence to fix, not a tool call to stop.
*/
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, relative, sep } from 'node:path';
import { deny, feedback, pass, rawPayload, repoRoot, resolvePath } from './lib/hook.mjs';

/* Escapes, never the characters: the hook that matches a dash must not be the file that
   adds one. Read only through String.match, which ignores lastIndex on a global pattern
   and so carries no state from one line to the next. */
const DASH = /[\u2010-\u2015\u2212]|&(?:mdash|ndash|minus);/g;

const MODE = (process.env.NT_DEV_DASH_GUARD ?? '').trim().toLowerCase();

if (MODE === 'off') pass();

const payload = rawPayload();
if (!payload) pass();

/* Which half of the call this run is. The event name carries it; a tool_response only
   exists after the fact, so it answers for a harness that sends no name. */
const strict = MODE === 'strict';
const post = payload.hook_event_name
  ? payload.hook_event_name === 'PostToolUse'
  : payload.tool_response !== undefined;
if (strict === post) pass();

const input = payload.tool_input ?? {};
const cwd = payload.cwd && existsSync(payload.cwd) ? payload.cwd : process.cwd();

const target = typeof input.file_path === 'string' && input.file_path
  ? resolvePath(input.file_path, cwd)
  : null;
if (!target) pass();

const whole = typeof input.content === 'string';
const after = whole ? input.content : typeof input.new_string === 'string' ? input.new_string : null;
if (after === null) pass();

const { marker, excluded, root, rel } = gateScope(target);
if (excluded) pass();

/* The two sides of the comparison, best source first: the patch the harness reports for a
   `Write` that has landed, which is that write's own delta; an `Edit`'s old_string, which
   is exactly what the hunk replaces; the blob the gate measures against, once the disk
   holds the new text; the file on disk, while the write is still pending. */
const patch = whole && post ? patched(payload.tool_response) : null;
const now = patch ? patch.plus : lines(after);
const was = patch ? patch.minus
  : !whole ? lines(input.old_string ?? '')
    : post ? lines(baseline(root, rel))
      : lines(onDisk(target));

if (total(now, marker) <= total(was, marker)) pass();

/* Only the lines this write is answerable for. Every dash line in the new text is the flat
   scan the decision above rules out: it names lines the write never touched, and the
   truncation below can push the one that raised the count off the end of the list. */
const sites = raised(withDash(now, marker), withDash(was, marker));
if (!sites.length) pass();

const headline = `${strict ? '🔴' : '🟡'} [dash-guard] Unicode dash in ${basename(target)}`;
const listed = sites.slice(0, 5).map((s) => `  ${whole ? `line ${s.line}: ` : ''}${s.text.slice(0, 120)}`);
if (sites.length > listed.length) listed.push(`  and ${sites.length - listed.length} more`);

const message = `${headline}

${listed.join('\n')}

Rewrite the punctuation in this same turn, before it reaches a commit. The dash gate fails
the pull request on any unicode dash a diff adds, and it only reports once the commit exists.
Type what the sentence wants: a colon to introduce, a comma pair or parens for an aside, a
semicolon or two sentences for two clauses, an ASCII hyphen for a range or a compound. Keep
the character only where it is load-bearing, such as a real minus sign, a quoted source, or a
pattern that matches it, and append \`${marker}\` to that same line. Under \`env\` in
.claude/settings.json, NT_DEV_DASH_GUARD=strict refuses the write instead of naming it, and
=off says nothing at all.`;

if (strict) deny(message);
feedback(message, headline);

/* --- counting -------------------------------------------------------------- */

/* One entry per line, trimmed: neither the marker nor a dash count changes with the
   indentation, and the trimmed text is what a moved line is matched by. */
function lines(text) {
  return String(text).split('\n').map((line, i) => ({ line: i + 1, text: line.trim() }));
}

function withDash(list, marker) {
  return list.filter((s) => !s.text.includes(marker) && s.text.match(DASH));
}

function total(list, marker) {
  return withDash(list, marker).reduce((n, s) => n + s.text.match(DASH).length, 0);
}

/* The dash lines the new text holds that the old one did not, matched off as a multiset so
   a line carried through verbatim - or moved - is nobody's to rewrite. */
function raised(now, was) {
  const held = new Map();
  for (const s of was) held.set(s.text, (held.get(s.text) ?? 0) + 1);
  return now.filter((s) => {
    const left = held.get(s.text) ?? 0;
    if (!left) return true;
    held.set(s.text, left - 1);
    return false;
  });
}

/* The lines a landed write changed, off the harness's own patch, with the line numbers the
   file now has. The field is not in the hook docs, so an unexpected shape - or an empty
   patch, which a newly created file also reports - returns null and the caller falls back
   to the git baseline rather than reading it as "nothing changed". */
function patched(response) {
  const hunks = Array.isArray(response?.structuredPatch) ? response.structuredPatch : [];
  if (!hunks.length) return null;
  const plus = [];
  const minus = [];
  for (const hunk of hunks) {
    if (!Array.isArray(hunk?.lines)) return null;
    let at = Number.isInteger(hunk.newStart) ? hunk.newStart : 1;
    for (const line of hunk.lines) {
      if (typeof line !== 'string') return null;
      const text = line.slice(1).trim();
      if (line.startsWith('+')) {
        plus.push({ line: at, text });
        at += 1;
      } else if (line.startsWith('-')) {
        minus.push({ line: 0, text });
      } else {
        at += 1;
      }
    }
  }
  return { plus, minus };
}

function onDisk(path) {
  try {
    return statSync(path).isFile() ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

/* The file as the gate's baseline holds it: the merge base with the default branch, which
   is where `git diff origin/<base>...HEAD` starts. HEAD when no remote names a default
   branch, and nothing when the path is untracked there - every dash in it is then new.
   Forward slashes: git takes no other separator, whatever node:path returned on the way
   in. */
function baseline(root, rel) {
  if (!root || !rel) return '';
  const run = git(root, ['show', `${mergeBase(root) || 'HEAD'}:${rel}`]);
  return run.status === 0 ? run.stdout : '';
}

function mergeBase(root) {
  const head = git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const branch = head.status === 0
    ? head.stdout.trim()
    : ['origin/main', 'origin/master'].find((ref) => git(root, ['rev-parse', '--verify', '--quiet', ref]).status === 0);
  if (!branch) return '';
  const base = git(root, ['merge-base', 'HEAD', branch]);
  return base.status === 0 ? base.stdout.trim() : '';
}

function git(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5_000 });
}

/* --- the gate's own scope -------------------------------------------------- */

/* Read off the workflow that calls the gate rather than restated here: the `marker:` and
   `exclude:` of that call. */
function gateScope(path) {
  /* The target file's repo, not the session's: a write reaches outside the repo the
     session started in, and the scope that governs a file is its own repo's. */
  const root = repoRoot(nearest(dirname(path)));
  const text = root ? gateConfig(root) : '';
  const marker = value(uncomment(/^[ \t]*marker:[ \t]*(.+)$/m.exec(text)?.[1] ?? '')) || 'dash-ok';
  const inside = root ? relative(real(root), real(path)).split(sep).join('/') : '';
  const rel = inside && !inside.startsWith('../') ? inside : '';
  const excluded = !!rel && excludes(text).some((one) => rel === one || rel.startsWith(`${one}/`));
  return { marker, excluded, root, rel };
}

/* Somewhere git can stand: a `Write` names a path whose parent may not exist yet. */
function nearest(dir) {
  let at = dir;
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  return at;
}

/* The gate's call, out of whichever workflow holds it. A dedicated dash-ratchet.yml is the
   common shape, but the composite action goes in a job the repo writes itself, under any
   filename, so the `uses:` line is what identifies it. */
function gateConfig(root) {
  const dir = join(root, '.github', 'workflows');
  const all = list(dir);
  const own = all.filter((name) => /^dash-ratchet\.ya?ml$/.test(name));
  for (const name of [...own, ...all.filter((name) => !own.includes(name))]) {
    const text = read(join(dir, name));
    const block = gateBlock(text);
    if (block) return block;
    /* A dedicated workflow reaching the gate some other way still holds its scope. */
    if (own.includes(name)) return text;
  }
  return '';
}

/* From the `uses:` line naming the gate to where its block dedents, so a `marker:` or an
   `exclude:` belonging to another step in the same workflow is not read as the gate's. */
function gateBlock(text) {
  const rows = String(text).split('\n');
  const at = rows.findIndex((row) => row.includes('notambourine/dash-ratchet'));
  if (at < 0) return '';
  /* A step's body is indented past its own `- `, while a job's `with:` is a sibling of the
     `uses:` beside it, so where the block ends depends on which form the call took. */
  const ends = /^[ \t]*-/.test(rows[at]) ? indent(rows[at]) : indent(rows[at]) - 1;
  const out = [rows[at]];
  for (const row of rows.slice(at + 1)) {
    if (row.trim() && indent(row) <= ends) break;
    out.push(row);
  }
  return out.join('\n');
}

function list(dir) {
  try {
    return readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).sort();
  } catch {
    return [];
  }
}

function read(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/* The paths under `exclude:` as the gate reads them, relative to the repo root, in the
   three shapes YAML writes a list of them: one on the line, a block scalar, or a
   sequence. */
function excludes(text) {
  const rows = String(text).split('\n');
  const at = rows.findIndex((row) => /^[ \t]*exclude:/.test(row));
  if (at < 0) return [];
  const own = indent(rows[at]);
  const rest = rows[at].replace(/^[ \t]*exclude:[ \t]*/, '');
  if (rest && !rest.startsWith('#') && !/^[|>]/.test(rest)) return [dir(uncomment(rest))].filter(Boolean);
  const block = /^[|>]/.test(rest);
  const out = [];
  for (const row of rows.slice(at + 1)) {
    if (!row.trim()) continue;
    if (block) {
      /* A block scalar ends where it dedents back to the mapping, and every line inside it
         is literal text - a `#` there is part of the path, as the gate's own reader has
         it. */
      if (indent(row) <= own) break;
      const one = dir(row);
      if (one) out.push(one);
      continue;
    }
    /* A sequence may sit at its key's own indentation, so only a line that is not an item
       ends it. */
    const item = /^[ \t]*-[ \t]*(.*)$/.exec(row);
    if (!item || indent(row) < own) break;
    const one = dir(uncomment(item[1]));
    if (one) out.push(one);
  }
  return out;
}

function indent(row) {
  return row.length - row.trimStart().length;
}

function dir(raw) {
  return value(raw).replace(/\/+$/, '');
}

/* A `#` ends a scalar everywhere YAML reads one, so what follows is not part of the value.
   Block scalars are the exception, and that caller does not come through here. */
function uncomment(raw) {
  return String(raw).replace(/^[ \t]*#.*$/, '').replace(/[ \t]+#.*$/, '');
}

function value(raw) {
  return String(raw ?? '').trim().replace(/^["']|["']$/g, '');
}

/* Both sides through the same resolver before they are compared. A temp directory is a
   symlink on macOS, so `git rev-parse` answers with the real path while the tool call
   carries the link, and the two then share no prefix at all. */
function real(path) {
  try {
    return realpathSync(path);
  } catch {
    /* A Write target that does not exist yet; its parent does. */
  }
  try {
    return join(realpathSync(dirname(path)), basename(path));
  } catch {
    return path;
  }
}
