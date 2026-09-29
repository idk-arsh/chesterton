---
description: Explain why a line of code is there, using git history and the fix commits Chesterton has indexed
argument-hint: <file:line>
allowed-tools: Bash(node *), Bash(git show *), Bash(git log *), Bash(git blame *), Read
---

Explain why this line exists: `$ARGUMENTS`

1. Run this command with the Bash tool and read its output:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" why "$ARGUMENTS"
   ```

   If no argument was given, or it is not in `file:line` form, ask for one and stop.

2. If the output marks any commit as a fix, run `git show <sha>` on the most recent one to see the
   full change and any test it added.

3. Summarize for the user in a few short sentences:
   - what the line does and which commit put it there
   - whether a bug fix is behind it, what that bug was, and any linked issue, PR or test
   - whether it looks safe to change, and what would break if it were removed

Keep it plain. Quote the sha and subject of each commit you mention.
