/* Decision table for the dash-guard hook, on both events it answers.

   Run: npm test

   Every dash here is written as an escape, so this file adds none of the characters it
   asserts on and the repo's own count stays where it is.
*/
import { match, ok, strictEqual } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, 'dash-guard.mjs');

const EM = '\u2014';
const EN = '\u2013';
const MINUS = '\u2212';

const temps = [];
after(() => temps.forEach((path) => rmSync(path, { force: true, recursive: true })));

/* A scratch directory outside any repo, so the gate-scope read finds no workflow and the
   defaults apply. Realpath because the hook compares resolved paths. */
function scratch() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'nt-dash-')));
  temps.push(path);
  return path;
}

/* PostToolUse by default: that is the event the default mode answers, and the one a write
   actually reaches. Pass `event` for the other half, `response` for a harness that sends a
   patch with it. */
function run(tool_input, { env = {}, cwd = HERE, event = 'PostToolUse', response } = {}) {
  const payload = { cwd, session_id: 'dash-guard-test', hook_event_name: event, tool_name: 'Write', tool_input };
  if (event === 'PostToolUse') payload.tool_response = response ?? { success: true };
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, NT_DEV_DASH_GUARD: '', ...env },
  });
  strictEqual(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
  const out = result.stdout.trim();
  return out ? JSON.parse(out) : null;
}

/* The two shapes the harness understands, kept apart so a test says which one it wanted. */
const flagged = (r) => r?.decision === 'block' && r.reason;
const denial = (r) => r?.hookSpecificOutput?.permissionDecision === 'deny'
  && r.hookSpecificOutput.permissionDecisionReason;

const write = (content, opts) => run({ file_path: join(opts?.dir ?? scratch(), 'notes.md'), content }, opts);

const edit = (old_string, new_string, opts) =>
  run({ file_path: join(opts?.dir ?? scratch(), 'notes.md'), old_string, new_string }, opts);

const git = (root, ...args) => spawnSync(
  'git',
  ['-c', 'commit.gpgsign=false', '-c', 'user.email=test@example.com', '-c', 'user.name=test', ...args],
  { cwd: root, encoding: 'utf8' },
);

function commit(root, text, message) {
  writeFileSync(join(root, 'notes.md'), text);
  git(root, 'add', 'notes.md');
  git(root, 'commit', '--quiet', '-m', message);
}

/* A repo, and a file already committed to it. */
function repo({ workflow, file = 'dash-ratchet.yml', committed } = {}) {
  const root = scratch();
  git(root, 'init', '--quiet');
  if (workflow) {
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(root, '.github', 'workflows', file), workflow);
  }
  mkdirSync(join(root, 'test', 'fixtures'), { recursive: true });
  if (committed !== undefined) commit(root, committed, 'seed');
  return root;
}

/* A repo whose `origin/main` holds `base` while the branch has already committed `head` -
   the shape the gate reports on, and the one a HEAD baseline calls flat. `update-ref`
   rather than a clone: the hook only reads the ref, and this needs no network. */
function branched(base, head) {
  const root = repo({ committed: base });
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  commit(root, head, 'branch');
  return root;
}

/* The gate as a reusable workflow, in the file the skill writes. */
const WORKFLOW = `jobs:
  dashes:
    uses: notambourine/dash-ratchet/.github/workflows/ratchet.yml@abc # v1
    with:
      marker: keep-dash
      exclude: |
        test/fixtures
        vendor
`;

/* The gate as a composite action, in a job the repo writes itself - excludes as a
   sequence, under a filename of the repo's choosing. */
const COMPOSITE = `jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: notambourine/dash-ratchet@abc # v1
        with:
          marker: keep-dash
          exclude:
            - test/fixtures
            - vendor
`;

describe('what it flags, once the write has landed', () => {
  for (const [name, text] of [
    ['an em dash', `The gate is the diff${EM}not the file.`],
    ['an en dash', `Runs 2020${EN}2024 inclusive.`],
    ['a minus sign', `The delta was ${MINUS}3 lines.`],
    ['an mdash entity', 'The gate is the diff&mdash;not the file.'],
    ['an ndash entity', 'Runs 2020&ndash;2024 inclusive.'],
  ]) {
    it(name, () => match(flagged(write(text)), /dash-guard/));
  }

  it('an Edit that adds one to a hunk that had none', () => {
    ok(flagged(edit('The gate is the diff, not the file.', `The gate is the diff${EM}not the file.`)));
  });

  it('an Edit that adds a second one to a hunk that had one', () => {
    ok(flagged(edit(`One${EM}here.`, `One${EM}here. And two${EM}there.`)));
  });

  it('a write that raises the count the commit already carried', () => {
    const root = repo({ committed: `One${EM}here.\n` });
    const input = { file_path: join(root, 'notes.md'), content: `One${EM}here.\nTwo${EM}there.\n` };
    ok(flagged(run(input, { cwd: root })));
  });

  it('names the offending line and the marker to reach for', () => {
    const reason = flagged(write(`fine line\nThe gate is the diff${EM}not the file.`));
    match(reason, /line 2:/);
    match(reason, /the gate is the diff/i);
    match(reason, /dash-ok/);
  });

  it('lists five sites and counts the rest', () => {
    const reason = flagged(write(Array.from({ length: 7 }, (_, i) => `line ${i}${EM}here`).join('\n')));
    match(reason, /and 2 more/);
  });
});

describe('what it leaves alone', () => {
  it('ASCII punctuation, which is the whole point', () => {
    strictEqual(write('The gate is the diff, not the file. A range: 2020-2024.'), null);
  });

  it('a line carrying the marker', () => {
    strictEqual(write(`const DASH = '${EM}'; // dash-ok: the character is the subject`), null);
  });

  it('an Edit that carries an existing dash through untouched', () => {
    strictEqual(edit(`One${EM}here.`, `One${EM}here, reworded.`), null);
  });

  it('an Edit that removes one', () => {
    strictEqual(edit(`One${EM}here.`, 'One, here.'), null);
  });

  it('a write that holds the committed count flat', () => {
    const root = repo({ committed: `One${EM}here.\n` });
    const input = { file_path: join(root, 'notes.md'), content: `One${EM}here, reworded.\n` };
    strictEqual(run(input, { cwd: root }), null);
  });

  it('a write that marks a dash the commit already carried', () => {
    const root = repo({ committed: `One${EM}here.\n` });
    const input = { file_path: join(root, 'notes.md'), content: `One${EM}here. <!-- dash-ok -->\n` };
    strictEqual(run(input, { cwd: root }), null);
  });

  for (const [name, input] of [
    ['a tool call with no file path', { command: 'git status' }],
    ['a notebook cell, which this hook does not read', { file_path: '/tmp/x.ipynb', new_source: `a${EM}b` }],
  ]) {
    it(name, () => strictEqual(run(input), null));
  }

  it('NT_DEV_DASH_GUARD=off, on either event', () => {
    const env = { NT_DEV_DASH_GUARD: 'off' };
    const content = `The gate is the diff${EM}not the file.`;
    strictEqual(write(content, { env }), null);
    strictEqual(write(content, { env, event: 'PreToolUse' }), null);
  });
});

describe('which event answers', () => {
  const content = `The gate is the diff${EM}not the file.`;

  it('the default speaks after the write, not before it', () => {
    strictEqual(write(content, { event: 'PreToolUse' }), null);
    ok(flagged(write(content, { event: 'PostToolUse' })));
  });

  it('strict refuses the write, and then has nothing to add', () => {
    const env = { NT_DEV_DASH_GUARD: 'strict' };
    match(denial(write(content, { env, event: 'PreToolUse' })), /dash-guard/);
    strictEqual(write(content, { env, event: 'PostToolUse' }), null);
  });

  it('a payload with no event name is read by its tool_response', () => {
    const file_path = join(scratch(), 'notes.md');
    const payload = { cwd: HERE, tool_name: 'Write', tool_input: { file_path, content }, tool_response: { success: true } };
    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, NT_DEV_DASH_GUARD: '' },
    });
    ok(flagged(JSON.parse(result.stdout)));
  });
});

describe('which lines it names', () => {
  const kept = Array.from({ length: 6 }, (_, i) => `old ${i}${EM}kept`).join('\n');

  it('only the one an Edit added, not the ones its own hunk quoted back', () => {
    const reason = flagged(edit(kept, `${kept}\nbrand new${EM}line`));
    match(reason, /brand new/);
    strictEqual(/old \d/.test(reason), false);
  });

  it('only the one a write added, so it cannot be truncated away', () => {
    const root = repo({ committed: `${kept}\n` });
    const input = { file_path: join(root, 'notes.md'), content: `${kept}\nbrand new${EM}line\n` };
    const reason = flagged(run(input, { cwd: root }));
    match(reason, /line 7: brand new/);
    strictEqual(/more$/m.test(reason), false);
  });

  it('the line the harness\'s own patch adds, at the number the file now has', () => {
    const root = repo({ committed: 'plain\n' });
    const response = { structuredPatch: [{ newStart: 40, lines: [`+added${EM}here`, ' context'] }] };
    const input = { file_path: join(root, 'notes.md'), content: 'plain\n' };
    match(flagged(run(input, { cwd: root, response })), /line 40: added/);
  });

  it('and nothing, when that patch adds no dash to a file full of them', () => {
    const root = repo({ committed: 'plain\n' });
    const response = { structuredPatch: [{ newStart: 1, lines: [' plain', '+added, fine'] }] };
    const input = { file_path: join(root, 'notes.md'), content: `One${EM}here.\nTwo${EM}there.\n` };
    strictEqual(run(input, { cwd: root, response }), null);
  });
});

describe('the baseline it measures against', () => {
  it('the merge base, so a dash the branch committed is still named', () => {
    const root = branched('plain\n', `One${EM}here.\n`);
    const input = { file_path: join(root, 'notes.md'), content: `One${EM}here.\n` };
    ok(flagged(run(input, { cwd: root })));
  });

  it('and one that was already there at the base is not', () => {
    const root = branched(`One${EM}here.\n`, `One${EM}here.\nplain\n`);
    const input = { file_path: join(root, 'notes.md'), content: `One${EM}here.\nplain again\n` };
    strictEqual(run(input, { cwd: root }), null);
  });
});

describe('whose repo answers', () => {
  it('the target file\'s, not the session\'s', () => {
    const other = repo({ workflow: WORKFLOW });
    const input = { file_path: join(other, 'test', 'fixtures', 'wire.md'), content: `a${EM}b` };
    strictEqual(run(input, { cwd: repo({ committed: 'plain\n' }) }), null);
  });

  it('so a file outside the session repo, written back unchanged, stays quiet', () => {
    const other = repo({ committed: `One${EM}here.\n` });
    const input = { file_path: join(other, 'notes.md'), content: `One${EM}here.\n` };
    strictEqual(run(input, { cwd: repo({ committed: 'plain\n' }) }), null);
  });
});

describe('the gate\'s own scope', () => {
  it('a path under an excluded directory', () => {
    const root = repo({ workflow: WORKFLOW });
    const input = { file_path: join(root, 'test', 'fixtures', 'wire.md'), content: `a${EM}b` };
    strictEqual(run(input, { cwd: root }), null);
  });

  it('a path outside it, in the same repo', () => {
    const root = repo({ workflow: WORKFLOW });
    const input = { file_path: join(root, 'docs', 'readme.md'), content: `a${EM}b` };
    ok(flagged(run(input, { cwd: root })));
  });

  it('the repo\'s own marker, not the default', () => {
    const root = repo({ workflow: WORKFLOW });
    const file = join(root, 'docs', 'readme.md');
    strictEqual(run({ file_path: file, content: `a${EM}b # keep-dash` }, { cwd: root }), null);
    ok(flagged(run({ file_path: file, content: `a${EM}b # dash-ok` }, { cwd: root })));
  });

  it('a single-line exclude', () => {
    const root = repo({ workflow: WORKFLOW.replace(/exclude: \|\n(\s+\S+\n)+/, 'exclude: test/fixtures\n') });
    const input = { file_path: join(root, 'test', 'fixtures', 'wire.md'), content: `a${EM}b` };
    strictEqual(run(input, { cwd: root }), null);
  });

  it('a marker with a comment after it', () => {
    const root = repo({ workflow: WORKFLOW.replace('keep-dash', 'keep-dash # renamed in v2') });
    const input = { file_path: join(root, 'docs', 'readme.md'), content: `a${EM}b # keep-dash` };
    strictEqual(run(input, { cwd: root }), null);
  });

  it('the composite action, in a workflow of the repo\'s own naming', () => {
    const root = repo({ workflow: COMPOSITE, file: 'ci.yaml' });
    strictEqual(run({ file_path: join(root, 'test', 'fixtures', 'wire.md'), content: `a${EM}b` }, { cwd: root }), null);
    strictEqual(run({ file_path: join(root, 'docs', 'x.md'), content: `a${EM}b # keep-dash` }, { cwd: root }), null);
    ok(flagged(run({ file_path: join(root, 'docs', 'x.md'), content: `a${EM}b # dash-ok` }, { cwd: root })));
  });

  it('not a marker belonging to the step after it', () => {
    const workflow = `${COMPOSITE}      - uses: someone/else@abc
        with:
          marker: not-ours
`;
    const root = repo({ workflow, file: 'ci.yml' });
    const input = { file_path: join(root, 'docs', 'x.md'), content: `a${EM}b # keep-dash` };
    strictEqual(run(input, { cwd: root }), null);
  });
});
