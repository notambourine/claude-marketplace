/* Decision table for the gh-body-file-nowrap PreToolUse hook.

   Run: node --test plugins/nt-dev/hooks/

   The point of running this on the Windows job as well as Linux is the path handling. A
   body file reaches the hook as whatever text the model typed into a shell command, and
   the three spellings that differ by platform - a Git Bash `/tmp/...` root, a drive
   letter, a backslash separator - are exactly the ones a deny message would blame on the
   user. Every case below asserts the hook's own decision, so a platform that resolves a
   path differently fails here rather than in someone's PR.
*/
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, 'gh-body-file-nowrap.mjs');
const MDFMT = join(HERE, '..', 'skills', 'md-format', 'mdfmt.mjs');
const REPO = join(HERE, '..', '..', '..');

const WRAPPED = '## Goal\n\nOne paragraph the model\nhard-wrapped across three\nphysical lines.\n';
const UNWRAPPED = '## Goal\n\nOne paragraph the model hard-wrapped across three physical lines.\n';

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function bodyFile(name, text = WRAPPED) {
  const dir = mkdtempSync(join(tmpdir(), 'nt-dev-test-'));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

/* What the harness would hand the hook, minus the fields it never reads. Every case names
   its own body file under a temp dir; nothing here may point the formatter at a file in
   the working tree, which it would rewrite for real. */
function run(command, env = {}, cwd = REPO) {
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd, tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, NT_DEV_PR_FORMAT: '', ...env },
  });
  strictEqual(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
  const out = result.stdout.trim();
  return out ? JSON.parse(out) : null;
}

const denial = (r) => r?.hookSpecificOutput?.permissionDecision === 'deny'
  && r.hookSpecificOutput.permissionDecisionReason;

/* The formatter fetches a wasm plugin over the network on first use. Everything about the
   hook's decisions is testable without it, so probe once and skip only the two cases that
   assert on bytes rather than on a verdict. */
const formatterWorks = (() => {
  const probe = bodyFile('probe.md');
  const r = spawnSync(process.execPath, [MDFMT, '--nowrap', probe], { cwd: REPO, encoding: 'utf8', timeout: 120_000 });
  return r.status === 0 && readFileSync(probe, 'utf8') === UNWRAPPED;
})();

describe('unwrapping the body file', () => {
  it('rewrites a wrapped .md body in place and says so', { skip: !formatterWorks && 'formatter unavailable' }, () => {
    const path = bodyFile('pr-body.md');
    const out = run(`gh pr create --draft --title x --body-file ${path}`);
    strictEqual(readFileSync(path, 'utf8'), UNWRAPPED);
    match(out.systemMessage, /unwrapped for GitHub/);
    match(out.systemMessage, /pr-body\.md/);
  });

  it('rewrites a body file named anything, back into the original path', { skip: !formatterWorks && 'formatter unavailable' }, () => {
    const path = bodyFile('notes.txt');
    run(`gh release create v1 --notes-file ${path}`);
    strictEqual(readFileSync(path, 'utf8'), UNWRAPPED);
  });

  it('stays silent when the body is already unwrapped', { skip: !formatterWorks && 'formatter unavailable' }, () => {
    const path = bodyFile('pr-body.md', UNWRAPPED);
    strictEqual(run(`gh pr edit 7 --body-file ${path}`), null);
  });

  it('reads a quoted path', () => {
    const path = bodyFile('pr-body.md');
    ok(!denial(run(`gh pr create --body-file "${path}"`)));
  });

  it('resolves a relative path against the payload cwd, not its own', () => {
    const path = bodyFile('pr-body.md');
    ok(!denial(run('gh pr create --body-file pr-body.md', {}, dirname(path))));
    match(denial(run('gh pr create --body-file pr-body.md')), /Cannot unwrap/);
  });

  it('accepts the --flag=value spelling', () => {
    const path = bodyFile('pr-body.md');
    ok(!denial(run(`gh pr create --body-file=${path}`)));
  });
});

/* The shape the Windows runner exists for. The Bash tool runs Git Bash, so a body file
   the model made with `mktemp -d` arrives spelled `/tmp/...` or `/c/Users/...`, and win32
   node reads that leading slash as the current drive root. cygpath is what the hook uses
   to get back to the real path; on a posix box there is no such translation to test. */
const cygpath = spawnSync('cygpath', ['-u', process.cwd()], { encoding: 'utf8' }).status === 0;

describe('a Git Bash path on Windows', { skip: !cygpath && 'not Git Bash' }, () => {
  it('finds a body file the shell spelled with an MSYS root', () => {
    const path = bodyFile('pr-body.md', UNWRAPPED);
    const msys = spawnSync('cygpath', ['-u', path], { encoding: 'utf8' }).stdout.trim();
    ok(msys.startsWith('/'), `cygpath gave back ${msys}`);
    ok(!denial(run(`gh pr create --body-file ${msys}`)));
  });

  it('still denies an MSYS path with no file behind it', () => {
    match(denial(run('gh pr create --body-file /tmp/no-such-body-file.md')), /Cannot unwrap/);
  });
});

describe('a body file the hook cannot reach', () => {
  it('denies a path the shell resolves', () => {
    match(denial(run('gh pr create --body-file "$BODY"')), /Cannot unwrap the body file/);
  });

  it('denies a file that does not exist yet', () => {
    match(denial(run('gh pr create --body-file no-such-body.md')), /Cannot unwrap the body file/);
  });

  it('allows a shell path when the command runs the formatter itself', () => {
    strictEqual(run('node mdfmt.mjs --nowrap "$BODY" && gh pr create --body-file "$BODY"'), null);
  });
});

describe('commands it keeps its hands off', () => {
  const untouched = [
    ['a tool that is not gh', 'some-other-cli --body-file no-such-body.md'],
    ['a binary whose name ends in gh', 'myhigh --body-file no-such-body.md'],
    ['gh with no body file at all', 'gh pr list --limit 5'],
    ['an inline body, outside strict mode', 'gh pr create --body "one line"'],
  ];
  for (const [name, command] of untouched) {
    it(name, () => strictEqual(run(command), null));
  }

  it('does nothing at all when switched off', () => {
    strictEqual(run('gh pr create --body-file "$BODY"', { NT_DEV_PR_FORMAT: 'off' }), null);
  });
});

describe('strict mode', () => {
  const strict = { NT_DEV_PR_FORMAT: 'strict' };

  it('denies an inline --body on a PR', () => {
    match(denial(run('gh pr create --body "one line"', strict)), /has to go through \/nt-dev:pr/);
    match(denial(run('gh pr edit 7 -b "one line"', strict)), /has to go through \/nt-dev:pr/);
  });

  it('denies --fill and --fill-verbose', () => {
    for (const flag of ['--fill', '--fill-verbose']) {
      match(denial(run(`gh pr create ${flag}`, strict)), /drops every template section/);
    }
  });

  it('allows a --body-file, which is the whole point of the mode', () => {
    const path = bodyFile('pr-body.md');
    ok(!denial(run(`gh pr create --body-file ${path}`, strict)));
  });

  it('leaves -B alone: that is --base, and gh spells --body in lower case', () => {
    const path = bodyFile('pr-body.md', UNWRAPPED);
    strictEqual(run(`gh pr create -B main --body-file ${path}`, strict), null);
  });

  it('governs pr create and pr edit only, not every gh subcommand', () => {
    strictEqual(run('gh issue comment 7 --body "one line"', strict), null);
  });
});

describe('a payload it cannot use', () => {
  for (const [name, input] of [
    ['not JSON', 'not json at all'],
    ['no command', '{"tool_name":"Read","tool_input":{"file_path":"x"}}'],
    ['empty', ''],
  ]) {
    it(`passes on a payload that is ${name}`, () => {
      const r = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8' });
      strictEqual(r.status, 0);
      strictEqual(r.stdout.trim(), '');
    });
  }
});

/* Step 1 of skills/pr/SKILL.md names this path in prose, and prose does not fail a build.
   The skill has no other template to fall back on now that the org repo is gone, so a
   rename here is a skill that resolves nothing. */
describe('the shipped PR template', () => {
  const TEMPLATE = join(HERE, '..', 'skills', 'pr', '.github', 'pull_request_template.md');

  it('sits where the skill says it does', () => {
    ok(readFileSync(TEMPLATE, 'utf8').length > 0);
  });

  it('carries the section contract the skill and the hook both assume', () => {
    const headings = [...readFileSync(TEMPLATE, 'utf8').matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    deepStrictEqual(headings, ['Goal', 'Summary', 'Key Decisions', 'Screenshots', 'Test Plan']);
  });

  it('is named in the skill by a path that resolves', () => {
    const skill = readFileSync(join(HERE, '..', 'skills', 'pr', 'SKILL.md'), 'utf8');
    const quoted = skill.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/pr\/[^`\s]+/);
    ok(quoted, 'SKILL.md no longer names the template path');
    const relative = quoted[0].replace('${CLAUDE_PLUGIN_ROOT}/', '');
    ok(readFileSync(join(HERE, '..', relative), 'utf8').length > 0);
  });
});

describe('the hook config', () => {
  it('matches only the tools these hooks read, and points each at a file that exists', () => {
    const config = JSON.parse(readFileSync(join(HERE, 'hooks.json'), 'utf8'));
    const entries = Object.values(config.hooks).flat();
    ok(config.hooks.PreToolUse?.length, 'no PreToolUse entries');
    for (const entry of entries) {
      /* A matcher wider than the payload the hook reads spawns a process per tool call for
         nothing. Bash for the gh hooks, Write and Edit for the dash guard. */
      for (const tool of entry.matcher.split('|')) {
        match(tool, /^(Bash|Write|Edit|Skill)$/);
      }
      for (const { command } of entry.hooks) {
        match(command, /\$\{CLAUDE_PLUGIN_ROOT\}/);
        /* The path in that command, resolved the way the harness resolves it. */
        const relative = command.match(/\$\{CLAUDE_PLUGIN_ROOT\}([^"]+)/)[1];
        ok(readFileSync(join(HERE, '..', relative), 'utf8').length > 0);
      }
    }
  });
});
