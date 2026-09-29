# Chesterton

A Claude Code plugin that stops Claude from quietly undoing past bug fixes.

It reads your git history, finds the commits that fixed bugs, and checks every Edit and Write
against them. If Claude is about to delete a line a fix added, or put back a line a fix removed,
it gets stopped once and shown the commit that explains why the code looks the way it does.

Named after [Chesterton's fence](https://en.wikipedia.org/wiki/Chesterton%27s_fence):
don't take down a fence until you know why someone put it up.

## What it looks like

Your `closeSocket` has a `sleep(50)` in it. It looks pointless. It was the fix for a race that only
showed up under load, and the tests pass without it. You ask Claude to clean up the file.
This is roughly what happens:

```
> clean up src/socket.ts

  Edit src/socket.ts
  -   await sleep(50); // kernel needs a moment to drain the send buffer

  Denied by PreToolUse hook:
  Chesterton: this edit to src/socket.ts removes code that fix 9cd25fc added.

  Fix: 9cd25fc (2025-03-14, Dana Ops) "fix: race on socket close under load (#412)"
  Why it looks like a fix: conventional commit type 'fix:'; message says 'fix', 'race';
  references #412; adds test test/socket.test.ts; small change (2 files, 2 lines)
  Lines:
    await sleep(50); // kernel needs a moment to drain the send buffer

  Before removing this, check the fix commit (git show 9cd25fc). Keep the fix, or rework the
  change around it. If you are sure it is safe, tell the user why, then retry the same edit
  and Chesterton will let it through.

  Bash git show 9cd25fc

● The sleep(50) was added to fix a race on socket close (#412). I'll keep it and clean up
  the rest of the file around it.
```

It's a speed bump, not a wall. The first attempt is denied. If Claude has read the fix and still
thinks the change is right, it explains that to you and retries, and the same edit goes through.
If you want a human to approve every one of these, set `mode: ask`.

## Install

You need Node 18 or newer on your PATH. Claude Code's native installer doesn't ship Node, so check
with `node --version` first.

Inside Claude Code:

```
/plugin marketplace add idk-arsh/chesterton
/plugin install chesterton@chesterton
```

That's it. The first session in a repo builds the index in the background. Nothing to configure.

## How it works

**Finding fix commits.** Each commit gets a score from things you can see in git, no model involved:

- the message says fix, bug, regression, race, crash, leak, revert, workaround and so on, or uses a
  conventional `fix:` prefix
- it links an issue or PR (`#412`, `JIRA-88`, a GitHub or Jira URL)
- it adds or changes a test file
- it's small (a few files, a few dozen lines)

Merge commits, lockfile and dependency bumps, docs-only commits and huge commits count against it.
The reasons are stored with each commit so every warning can say why it thinks this was a fix.

**The index.** For each fix commit, Chesterton stores a hash of every meaningful line it added and
removed, per file, following renames forward to the file's current name. Braces, blank lines,
`else {`, imports and other lines that mean nothing on their own are skipped. The index lives in
`.git/chesterton/`, so it's never committed and never leaves your machine. It updates incrementally
as HEAD moves.

**The check.** On every Edit, Write or MultiEdit, the hook works out which lines the edit removes and
adds, then looks for two things:

1. **Removing a fix.** It blames the lines being removed. If the commit that last touched a line is
   a fix commit, and that commit added that exact line, it's a strong hit.
2. **Putting back what a fix removed.** It hashes the lines being added and looks them up in what
   fix commits deleted from this file. Two or more matching lines in a row is a strong hit.

Weaker matches (a line a fix only touched, a line right next to one a fix added, a single long line
that a fix removed) don't block anything. They get passed to Claude as a note.

**When the session ends**, a Stop hook sweeps the files Claude changed against HEAD, so a fix taken
apart across several small edits still shows up in a short summary.

**It fails open.** If git is missing, the folder isn't a repo, the index isn't built yet, or anything
throws or runs past its time budget, the hook exits quietly and your edit goes through. Chesterton
breaking should never block you. There's no network access, no telemetry, and no API key.

## Config

Optional. Put a `.chesterton.yml` at the repo root. See
[`.chesterton.example.yml`](.chesterton.example.yml).

| Key | Default | What it does |
|---|---|---|
| `mode` | `speedbump` | `speedbump` denies a strong hit once per file and fix, then lets a retry through. `ask` hands strong hits to you to approve. `warn-only` never blocks, it only adds notes. |
| `history` | `3y` | How far back to look for fixes: `all`, or a span like `18m`, `6w`, `90d`. |
| `max_commits` | `20000` | Hard cap on commits walked when building the index. |
| `protect` | `[]` | Globs where a strong hit always asks you, whatever the mode. For example `src/payments/**`. |
| `fix_patterns_extra` | `[]` | Extra regexes that count as fix words in commit messages, like `SEV\d` or `postmortem`. |
| `ignore_commits` | `[]` | Commit shas (prefixes are fine) that should never count as fixes. Use this for false positives. |
| `hook_timeout_ms` | `1500` | Time budget for the edit check, from 100 to 4000. Past it, the edit is allowed. Higher values are capped at 4000 so the check always ends inside Claude Code's 5 second hook timeout. |

Bad values fall back to the default. `chesterton status` prints any warnings about the file.

## CLI

The plugin ships a small CLI at `dist/cli.js`. Inside Claude Code the easy way in is the slash command:

```
/chesterton:why src/socket.ts:3
```

From a shell, run it from a checkout of this repo (or the installed plugin folder) inside your project:

```
node path/to/chesterton/dist/cli.js why src/socket.ts:3
```

| Command | What it does |
|---|---|
| `index [--full] [--quiet]` | Build or update the index. `--full` rebuilds from scratch. |
| `why <file>:<line>` | Who last touched a line, the commits that shaped it, and which of them were fixes, with refs and tests. |
| `check [--staged \| --base <rev>]` | Run the same check on a git diff. With no flag it checks uncommitted changes against HEAD. `--staged` checks what you're about to commit. `--base main` checks everything since your branch left `main`. Exits 1 on a strong hit, so it works as a pre-commit hook or a CI step. |
| `status` | Whether the index exists, when it was built, whether HEAD has moved since, and how many fixes it holds. |

Exit codes: 0 when all is well, 1 for a strong hit from `check`, a failed `index`, or a `why` on a
missing file, a directory, or a line past the end of the file, and 2 for usage or setup errors. If
another index build is running, `check` waits up to 60 seconds for it (set `CHESTERTON_LOCK_WAIT_MS`
to change that) and exits 2 if it is still going, so a pre-commit hook never passes a change it did
not really check.

A pre-commit hook is one line:

```sh
node path/to/chesterton/dist/cli.js check --staged
```

## What it won't catch

- **Messy history.** If your commits say "wip" and "stuff" and never touch tests, Chesterton has much
  less to go on. The test-file and small-diff signals help, but it works best on repos with decent
  commit messages.
- **Squash-merged history** where a fix was bundled into a big feature commit. The fix is in there,
  but the commit doesn't look like a fix, so it isn't indexed.
- **Code that moved.** If a fix's lines moved to another file without git seeing it as a rename, the
  record stays with the old file. The same goes for a fix rewritten by hand into different lines.
- **Rewrites that keep the bug.** It matches lines, not meaning. If Claude replaces the fix with
  different code that brings the bug back, it won't notice.
- **Untracked files.** `check` only looks at what git diff shows.

## Roadmap

- Rerun the regression tests from the fix commits touched in a session when it ends.
- CI mode: a GitHub Action that runs `check --base` on pull requests and comments on hits.
- A benchmark of real undone fixes mined from open source repos, to measure how many it catches and
  how often it flags an edit it shouldn't. No numbers in this README until that exists.

## License

MIT. See [LICENSE](LICENSE).
