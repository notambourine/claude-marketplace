/* Shared plumbing for this plugin's PreToolUse hooks: reading the harness payload,
   answering it, and turning a path out of a shell command into one node can open.

   Node rather than bash, for every hook here. See .claude/rules/portable-shell.md: `jq`
   ships on no platform by default, and the bounded stdin read a hook needs is spelled
   `gtimeout` on macOS, `timeout` on Linux, and nothing at all in Git Bash on Windows.
*/
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/* --- answering the harness ------------------------------------------------ */

/* Every exit is a clean one. A hook that throws on a payload it did not understand blocks
   a tool call it never had an opinion about. */
export function pass() {
  process.exit(0);
}

/* Goes to the user's transcript, not into the model's context. */
export function say(message) {
  console.log(JSON.stringify({ systemMessage: message }));
  process.exit(0);
}

export function deny(reason) {
  emit({ permissionDecision: 'deny', permissionDecisionReason: reason });
}

/* Guidance for the model that does NOT block the call.

   KEY-DECISION 2026-08-19: no `permissionDecision` field here, deliberately. Emitting
   "allow" would short-circuit the user's own permission rules for a command this hook
   only wanted to comment on. Omitting it leaves the permission flow exactly as it was.
   The docs list additionalContext under PreToolUse but do not say whether it reaches the
   model on a call that proceeds, so nothing load-bearing may depend on this - it is the
   quiet half of a nudge whose blocking half is deny(). */
export function context(additionalContext, message) {
  emit({ additionalContext }, message);
}

/* PostToolUse: the call already happened, and `decision: block` is the documented way to
   put a reason in front of the model without ending the turn - it reads the reason and
   keeps working. This is the event to use when the tool call was fine and what it wrote
   needs a second pass. */
export function feedback(reason, message) {
  const out = { decision: 'block', reason };
  if (message) out.systemMessage = message;
  console.log(JSON.stringify(out));
  process.exit(0);
}

function emit(hookSpecificOutput, systemMessage) {
  const out = { hookSpecificOutput: { hookEventName: 'PreToolUse', ...hookSpecificOutput } };
  if (systemMessage) out.systemMessage = systemMessage;
  console.log(JSON.stringify(out));
  process.exit(0);
}

/* --- the payload ---------------------------------------------------------- */

/* fd 0, not '/dev/stdin': the device node does not exist on Windows. A non-blocking pipe
   answers EAGAIN before the writer has filled it, which is not end-of-input, so that one
   errno retries and every other error gives up. */
function readStdin() {
  if (process.stdin.isTTY) return '';
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return readFileSync(0, 'utf8');
    } catch (err) {
      if (err.code !== 'EAGAIN') return '';
      /* No synchronous sleep in node, and the read has to stay synchronous: an async one
         would let the script fall off the end and exit before the payload arrived. */
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  return '';
}

/* The harness payload as it arrived, or null when it is not JSON. Read it once: stdin is a
   pipe, and a second read comes back empty. */
export function rawPayload() {
  try {
    return JSON.parse(readStdin());
  } catch {
    return null;
  }
}

/* The Bash command this hook was fired for, plus where it will run, or null when there is
   nothing here to have an opinion about. */
export function bashPayload(payload = rawPayload()) {
  const command = payload?.tool_input?.command;
  if (typeof command !== 'string' || !command) return null;
  return {
    command,
    sessionId: typeof payload.session_id === 'string' ? payload.session_id : '',
    cwd: payload.cwd && existsSync(payload.cwd) ? payload.cwd : process.cwd(),
  };
}

/* True when `gh` is the program being run, rather than a word inside another command.
   `myhigh --body-file x` is not ours. */
export function isGh(command) {
  return /(^|[\s;&|(])gh\s/.test(command);
}

/* --- paths ---------------------------------------------------------------- */

const FILE_FLAG = /--(body|notes)-file[=\s]+("[^"]*"|'[^']*'|[^\s]+)/g;

/* Every --body-file / --notes-file in a command, split by whether this hook can read it.
   A path the shell resolves, or a heredoc the same command is about to write, has no bytes
   here yet: those come back under `unreachable`. */
export function bodyFiles(command, cwd) {
  const readable = [];
  const unreachable = [];
  for (const match of command.matchAll(FILE_FLAG)) {
    const raw = match[2].replace(/^["']|["']$/g, '');
    if (!raw || raw === '-') continue;
    if (/[$`]/.test(raw)) {
      unreachable.push(raw);
      continue;
    }
    const path = resolvePath(raw, cwd);
    if (existsSync(path) && statSync(path).isFile()) readable.push(path);
    else unreachable.push(path);
  }
  return { readable, unreachable };
}

export function resolvePath(raw, cwd) {
  let path = raw;
  if (path.startsWith('~/')) path = join(process.env.HOME ?? process.env.USERPROFILE ?? '', path.slice(2));
  if (!isAbsolute(path)) path = resolve(cwd, path);
  return fromGitBash(path);
}

/* Windows only. The Bash tool runs Git Bash there, so `$(mktemp -d)/pr-body.md` in the
   command this hook is reading comes back as an MSYS path - `/tmp/x/pr-body.md`. node on
   win32 reads a leading slash as the current drive root and looks in `C:\tmp`, where the
   file is not. cygpath ships with Git Bash and is the only thing that knows where that
   root is mounted. */
export function fromGitBash(path) {
  if (process.platform !== 'win32' || !path.startsWith('/') || existsSync(path)) return path;
  const run = spawnSync('cygpath', ['-w', path], { encoding: 'utf8', timeout: 5_000 });
  return (run.status === 0 && run.stdout.trim()) || path;
}

/* The repo root the command will run against, or null outside a repo. */
export function repoRoot(cwd) {
  const run = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 5_000 });
  return run.status === 0 ? run.stdout.trim() : null;
}
