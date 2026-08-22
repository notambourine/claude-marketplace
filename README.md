# notambourine/claude

The Claude Code plugins the NoTambourine practice works out of: the brand system,
everyday PR and cleanup workflow, supply-chain scanning, and one-link file sharing.

Add the marketplace once, then turn plugins on per machine or per repo.

## Install

```bash
claude plugin marketplace add notambourine/claude
claude plugin install nt-brand@notambourine --scope user
```

For the whole set, read the names off the marketplace instead of typing them out:

```bash
claude plugin list --available --json |
  jq -r '.available[] | select(.marketplaceName == "notambourine") | .pluginId' |
  while read -r plugin; do claude plugin install "$plugin" --scope user; done
```

`--available` skips anything you already have, so the same command picks up a
plugin added since your last run.

## What you get

| Plugin | Commands | What it does |
| --- | --- | --- |
| `nt-brand` | `/nt-brand:system` | Colors, type, spacing, component CSS, a Marpit deck theme, and the voice rules, plus the audit that checks work against them. Native CSS with no build step, so it drops into a page, a Worker, or a React app. |
| `nt-dev` | `/nt-dev:pr` `/nt-dev:cleanup` `/nt-dev:md-format` `/nt-dev:recall` `/nt-dev:issue` `/nt-dev:eod-update` | Fills a PR body from the diff and opens it, audits a repo for dead refs and stale docs, wraps and tidies markdown at a width you pick, reads a prior session in this repo back into context, writes a GitHub issue to the house standard, writes a copy-paste end-of-day standup update from today's GitHub activity (never posts). Also ships the `Attentive` output style and the three hooks, all below. |
| `nt-pm` | `/nt-pm:shipped` `/nt-pm:weekly-recap` | Plain-English status updates for a non-technical audience. `shipped` writes a "Deploy Updates" summary — what's about to ship (promotion or current branch vs the default branch) or what just shipped (the last push to the default branch, from the reflog), grouped by category. `weekly-recap` writes a week-level summary of merged, in-review, and in-progress work across the whole team. Never posts, never deploys. |
| `nt-voice` | `/nt-voice:human-voice` | The prose voice pass, behind one command. Two vendored skills do the work and disagree on method - surgical phrasing edits versus a full rewrite - so this triages the ask, picks one, says which, and hands off. Ask for it any way you like; you no longer have to remember which fork you wanted. Needs `nt-vendor`. |
| `nt-vendor` | `/nt-vendor:humanizer` `/nt-vendor:anti-slop` `/nt-vendor:codebase-design` and three more | Skills mirrored whole from other people's repos, kept under a prefix that says so. The two prose skills are reached through `/nt-voice:human-voice`. |
| `nt-share` | `/nt-share:share` | Turns a file, folder, or screenshot into one branded unguessable link. Browsers get a rendered page, `curl` and Slack unfurls get raw bytes from the same URL. Needs a NoTambourine-issued token. |
| `wormhook` | runs as a hook | Blocks npm and PyPI supply-chain malware, and the rogue hooks and MCP entries that malware writes to persist, before any of it executes. Local and zero-network. |
| `qrspi` | `/qrspi:query` through `/qrspi:implement` | Feature work as five tracked stages on a GitHub Project board: query, research, spec, plan, implement. |

Commands are namespaced by plugin, always two segments: `/nt-brand:system`.

## The Attentive output style

`nt-dev` ships one output style. Installing the plugin only puts it in the
picker; pick it under `/config` → Output style, or name it in settings:

```json
{ "outputStyle": "Attentive" }
```

It merges two halves that usually ship apart. From the built-in `Proactive`
style it takes the license to act: start the work, assume rather than interrupt,
and stop only at a step that destroys data or sends your information outward.
On top of that it puts a reporting contract, because a Claude that works ahead
of you is *reporting*, not answering. It leads with what changed, never lets
"done" outrun the evidence, and says what it skipped and why.

Pick it when you want Claude working unattended. `Proactive` alone acts fast but
hands back whatever shape it likes; `Attentive` acts just as fast and makes the
handback readable.

Credit where it is due: the attention-protection half is our own clean-room
write-up of ideas from Alex Greenshtein's
[attention-span](https://github.com/alexgreensh/attention-span). No text was
copied, so this stays MIT while the original is AGPL-3.0. If you want the
original rather than our merge, install it from that repo.

## The three hooks

A skill fires only when something in the prompt trips its description. Plenty of
PRs and issues get opened by a sentence that trips nothing, and what lands is
whatever the model invented. `nt-dev` ships three hooks for the gap, two of them
answering a tool call before it runs and one after. Each takes an off switch, and
each stays silent when there is nothing to say.

**The PR body hook.** GitHub renders a single newline as `<br>`, so a PR body
wrapped at 80 columns lands as a ragged strip in a box twice as wide. Every
model carries the 80-column habit in from source code, and telling it not to has
not held. So when a `gh` command names a `--body-file` or `--notes-file`, the
hook runs `md-format --nowrap` over that file in the moment between the model
writing it and `gh` reading it: one physical line per paragraph, bullet, and
checkbox, fenced code and tables left alone. Nothing to invoke, nothing to
remember. The one shape it cannot reach is a path only the shell knows,
`--body-file "$BODY"`: it denies that and says how to fix it, unless the same
command runs the formatter itself.

| `NT_DEV_PR_FORMAT` | What the hook does |
| --- | --- |
| unset | Unwraps every body file it can read. |
| `strict` | Also refuses an inline `--body` or a `--fill` on `gh pr create` and `gh pr edit`, so a PR body has to go through `/nt-dev:pr` even when nothing triggered it. |
| `off` | Nothing. |

**The skill-nudge hook.** A skill only fires when the prompt trips its
description. "File this as a ticket" trips `/nt-dev:issue`; "also open an issue
for the flaky test" often does not, and the issue that lands has no milestone, no
label, and a one-line body. So this hook names the skill instead of grading the
command: it refuses a `gh pr create` or `gh issue create`, and a `Write` to a
body file the model is about to fill (`pr-body.md`, `prbody.md`, `pr.md` - the
names those bodies actually get), saying to read `/nt-dev:pr` or `/nt-dev:issue`
first. The `Write` case is the cheap one, landing before a line of body exists.
Invoking the skill is the all-clear: the hook sees the `Skill` call and goes quiet
for the session, so the skill's own `gh pr create` never hears from it. `--web` is
left alone because GitHub shows the repo's forms itself.

It checks nothing about the PR or the issue. An earlier version graded flags -
milestone, label, section headings - which put the standard in two places and let
it drift; it ended up advising `--template`, a flag `gh` refuses alongside
`--body-file`. The skill is the standard, and a model that has read it can judge
its own body.

| `NT_DEV_SKILL_NUDGE` | What the hook does |
| --- | --- |
| unset | Names the skill once per kind per session, then advises without blocking. |
| `strict` | Names it every time until the skill is actually read. |
| `off` | Nothing. |

**The dash guard.** The gate at
[dash-ratchet](https://github.com/notambourine/dash-ratchet) fails a pull request
on any unicode dash the diff adds. It reports after the commit, so the cheap fix
arrives one push too late. This hook makes the same assertion at the write: it
counts the dashes in the text a `Write` or an `Edit` is carrying against what
that text held before, and when the number rises it names the lines the write
added. The write lands and the model gets those lines while the sentence is still
in hand, which is the point. `strict` refuses the write instead.

Counting the delta rather than scanning the payload is the whole trick. A file
that already holds a dash, an `Edit` whose `old_string` quotes one back, a
paragraph moved verbatim: a flat scan flags all three over a character it did
not introduce, and a hook that does that gets switched off. The before it
measures against is whatever is nearest the write: the patch the harness reports,
an `Edit`'s own `old_string`, the file on disk, or the blob at the merge base
with the default branch, which is where the gate starts its own diff. A line
carrying `dash-ok` is exempt, the same as under the gate, and the excluded
directories and a renamed marker are read off the gate's call in whichever
workflow of that file's repo holds it, so the hook and CI cannot disagree about
scope. A repo with no gate still gets the check.

Each mode answers a different event, because the harness reaches the model two
different ways: naming the lines is a `PostToolUse` block, whose reason the model
reads before it moves on, and refusing the write is a `PreToolUse` deny.

| `NT_DEV_DASH_GUARD` | What the hook does |
| --- | --- |
| unset | Lets the write land, then names the lines that raised the count. |
| `strict` | Refuses the write. |
| `off` | Nothing. |

## Turning plugins on and off

Per machine:

```bash
claude plugin install qrspi@notambourine --scope user
claude plugin disable qrspi@notambourine
```

Per repo, committed so the whole team gets the same set, in
`.claude/settings.json`:

```json
{ "enabledPlugins": { "nt-brand@notambourine": true } }
```

A skill costs one line of context until something triggers it, so a plugin you
leave on is close to free. A hook is the thing to weigh: it runs whether or not
you asked, which is why `wormhook` ships alone and why each of `nt-dev`'s three
hooks reads one narrow payload and takes an `off` switch.

## Working on these plugins

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the layout, the naming rule, how to
add a plugin, and how the mirrored content is kept honest.

## License

MIT. See [LICENSE](./LICENSE). Vendored skills keep their own licenses, listed in
[vendor/NOTICE.md](./vendor/NOTICE.md).
