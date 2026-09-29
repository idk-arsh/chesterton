---
name: chesterton
description: What to do when a Chesterton message blocks or annotates an Edit or Write ("Chesterton:", "undo a past bug fix", "fix commit"), and how to check git history before removing code that looks odd. Use when refactoring, simplifying, cleaning up, or deleting code that looks pointless, such as a sleep, a retry, an extra null check, a lock, or a strange guard.
---

# Chesterton

Chesterton is a hook that checks your edits against the bug fixes in this repo's git history.
It flags two things:

- **removes-fix**: your edit deletes or changes lines that a fix commit added.
- **re-adds-removed**: your edit puts back lines that a fix commit deliberately took out.

The code it protects often looks wrong on purpose. A `sleep(50)`, a second null check, or a retry
loop can be the whole fix for a bug that only showed up under load. Tests may still pass without it.

## When an edit is denied or you get a Chesterton note

The message names the fix commit (sha, date, subject), why it looks like a fix, any linked issues
or PRs, the test files the fix added, and the exact lines involved.

1. Read the fix before doing anything else:
   `git show <sha>` (add `--stat` first if it is large). Read the linked test file if there is one.
2. Decide which of these applies:
   - **Keep the fix.** Drop that part of your change. This is the right call most of the time.
   - **Rework around it.** Get what you wanted while keeping the behavior the fix added.
     If you move the code, keep the same guard, delay, check or ordering.
   - **Remove it on purpose.** Only when you can say why it is safe now, for example the
     underlying bug was fixed in a dependency, or the code path no longer exists. Tell the user
     in plain words what the fix was for and why removing it is fine, then retry the edit.
3. Retry. A strong hit denies the first attempt only. The same edit (same file, same fix commit)
   goes through on the second try, so do not retry blindly: retry only after step 2.

Never try to get around the check by splitting the edit into smaller pieces, rewriting the file
with a different tool, or editing through the shell. If the user asked for the removal and you
have explained the history, a plain retry is the right move.

A note that arrives as extra context (a weak hit) does not block you. Still read the commit if
you are about to delete or rewrite those lines.

## Before refactoring code that looks odd

Ask why a line is there before you remove it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" why path/to/file.ts:42
```

It prints the commit that last touched the line, the commits that shaped it, and marks the ones
that look like bug fixes with their reasons, refs and test files. The user can run the same thing
as `/chesterton:why path/to/file.ts:42`.

Other commands:

- `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" status` shows whether the fix index is built and fresh.
- `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" check --staged` runs the same check on staged changes.
