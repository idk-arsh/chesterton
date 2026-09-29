# Architecture

Chesterton is a Claude Code plugin that stops the agent from quietly undoing past bug fixes.
This file describes how the pieces fit together, for anyone changing the code.

## The idea in one line

Index what every fix commit added and removed. On each edit, flag it when the edit
**deletes lines a fix added** (`removes-fix`) or **re-adds lines a fix removed** (`re-adds-removed`).

## Ground rules

- Node 18+, TypeScript, **zero runtime dependencies**. Only `node:` builtins. Bundled by esbuild into `dist/hook-main.js` and
  `dist/cli-main.js`. `dist/hook.js` and `dist/cli.js` are small launchers written by `scripts/build.mjs`: they turn on Node's
  compile cache when it exists (22.1+) and load the bundle. The hook launcher exits 0 silently if the bundle fails to load.
- The edit hook is on the hot path of every edit. A no-finding edit should start no git process: the repo and its git dir are
  found by walking up to `.git` in JS (`locateRepo` in `src/git.ts`, which hands unusual layouts to git), the index is read one
  shard at a time, and blame only runs when a strong hit is possible.
- The hook must **fail open**: any error, timeout, missing git, not-a-repo, missing index means exit 0 with no output. Never block the user because Chesterton broke.
- No network, no model calls, no telemetry. Everything stays in `<git-dir>/chesterton/`.
- Windows, macOS, Linux. Watch CRLF, backslash paths, spaces in paths. Always repo-relative forward-slash paths internally (`toPosix`).
- Shared contracts live in `src/types.ts` and `src/normalize.ts`. Both halves of the code depend on them, so change them with care.
- Every module gets vitest tests using `test/helpers/repo.ts` (real throwaway git repos).
- Public text (README, messages Claude sees) in plain human voice. No em dashes.

## Modules

| Area | Files | Job |
|---|---|---|
| Shared | `src/types.ts`, `src/normalize.ts`, `src/git.ts`, `test/helpers/repo.ts`, `scripts/build.mjs` | Types, line normalization, git runner, test repos, bundling |
| History | `src/classify.ts`, `src/index-store.ts`, `src/index-builder.ts`, `src/blame.ts` | Find fix commits, build and store the index, blame |
| Edit check | `src/edit-diff.ts`, `src/analyze.ts`, `src/decide.ts`, `src/session.ts`, `src/hook.ts` | Turn a tool call into findings and a hook response |
| Shell | `src/config.ts`, `src/cli.ts`, `src/why.ts`, `src/diff-change.ts`, `.claude-plugin/`, `hooks/hooks.json`, `skills/`, `commands/` | Config, CLI, plugin packaging |

## Module interfaces

### History

```ts
// src/classify.ts
export interface CommitFileChange { path: string; oldPath?: string; status: string; added: number; removed: number }
export interface ClassifyInput { sha: string; subject: string; body: string; files: CommitFileChange[]; parents: number }
export interface ClassifyResult { isFix: boolean; score: number; reasons: string[]; refs: string[]; testFiles: string[] }
export function classifyCommit(input: ClassifyInput, cfg: ChestertonConfig): ClassifyResult;

// src/index-store.ts
export function indexDir(repoRoot: string): string;            // absolute <git-dir>/chesterton, created if missing. Works in worktrees.
export function loadMeta(repoRoot: string): IndexMeta | null;  // meta.json only: head, builtAt, fixCommits, files. For SessionStart and status.
export function loadIndexForFiles(repoRoot: string, relPaths: string[], opts?: { allCommits?: boolean }): ChestertonIndex | null;
//   Only those files' shards and the fix commits they point at (or every fix commit with allCommits). What the hook reads.
export function loadIndex(repoRoot: string): ChestertonIndex | null;   // every shard; null if missing, corrupt, or wrong version
export function saveIndex(repoRoot: string, idx: ChestertonIndex): void; // atomic writes (tmp + rename), meta.json last
//   Layout (index version 3), all in <git-dir>/chesterton/:
//     meta.json            { version, id, head, builtAt, fixCommits, files }
//     manifest-<id>.json   { version, id, files: { path: shard } }
//     commits-<id>.json    { version, id, commits }
//     shards/<hash>.json   { version, path, records, commits }  one file's records and the fix commits they name
//   Shards are named by a hash of their content, so an incremental build only writes the ones that changed. A damaged shard
//   is deleted when read, so the next build writes it again. Older generations and a version 2 index.json are removed.
export function recordsForFile(idx: ChestertonIndex, relPath: string): FileFixRecord[];

// src/index-builder.ts
export interface BuildOptions { full?: boolean; timeoutMs?: number }
export function buildIndex(repoRoot: string, cfg: ChestertonConfig, opts?: BuildOptions): ChestertonIndex;
//   Incremental when a saved index exists and its head is an ancestor of HEAD; otherwise full.
//   Uses a lock file in indexDir so two builds never run at once (second caller returns the existing index or waits briefly).
//   Follows renames forward so records are keyed by the file's CURRENT path.
//   Respects cfg.history, cfg.maxCommits, cfg.ignoreCommits. Skips merges, binary files, and noise files (isNoiseFile).
export function isIndexFresh(repoRoot: string, idx: { head: string } | null): boolean; // idx.head === HEAD

// src/blame.ts
export function blameRange(repoRoot: string, relPath: string, start: number, end: number, timeoutMs?: number): BlameLine[];
//   Blames the working-tree file. Returns [] for untracked files. Uncommitted lines come back with sha "0000000...".
```

### Edit check

```ts
// src/edit-diff.ts
export function changeFromToolCall(repoRoot: string, toolName: string, toolInput: unknown): EditChange[];
//   Edit: {file_path, old_string, new_string, replace_all}. Write: {file_path, content}. MultiEdit (legacy): {file_path, edits[]}.
//   Returns [] for paths outside the repo, unreadable files, or when old_string is not found.
export function diffLines(before: string[], after: string[]): { removed: { line: number; text: string }[]; added: string[] };
//   LCS based, exported so C's `check` command can reuse it.

// src/analyze.ts
export function analyzeChange(repoRoot: string, change: EditChange, idx: ChestertonIndex, cfg: ChestertonConfig, deps?: AnalyzeDeps): Finding[];
//   deps: blame function and budget, current content, and alwaysBlame (the no-index fallback sets it).

// src/decide.ts
export interface HookResponse { stdout: string | null }  // JSON to print, or null for silent allow
export function decidePreToolUse(findings: Finding[], session: SessionState, cfg: ChestertonConfig, relPath: string): HookResponse;

// src/session.ts
export interface SessionState { sessionId: string; acknowledged: string[]; findings: { at: string; key: string; kind: string; strength: string; file: string; sha: string; decision: string }[] }
export function loadSession(repoRoot: string, sessionId: string): SessionState;
export function saveSession(repoRoot: string, s: SessionState): void;

// src/hook.ts  (entry point, bundled to dist/hook.js)
//   Reads hook JSON from stdin, dispatches on hook_event_name: SessionStart, PreToolUse, Stop.
```

### Shell

```ts
// src/config.ts
export function loadConfig(repoRoot: string): ChestertonConfig;   // parses .chesterton.yml, never throws

// src/diff-change.ts
export function changesFromGitDiff(repoRoot: string, range: { staged?: boolean; base?: string }): EditChange[];

// src/why.ts
export function explainLine(repoRoot: string, relPath: string, line: number, idx: ChestertonIndex | null): string; // human readable

// src/cli.ts (entry point, bundled to dist/cli.js)
//   chesterton index [--full] [--quiet]
//   chesterton why <file>:<line>
//   chesterton check [--staged | --base <rev>]   exit 1 on strong findings (for pre-commit / CI)
//   chesterton status
```

## Hook behavior

- **SessionStart** (`startup|resume|clear|compact`): if not a repo or there is no HEAD, exit 0. The first SessionStart of a session
  saves which files are already dirty, with a content hash (`baselines/<session>.json`), for the Stop sweep. It reads only
  `meta.json`. If the index is missing or stale, spawn `node <dist>/cli.js index --quiet` detached and unref'd so the session never waits. Print nothing, or a one-line `additionalContext` only if an index already exists ("Chesterton: N fix commits indexed").
- **PreToolUse** matcher `Edit|Write|MultiEdit`: build EditChange(s), analyze, decide.
  - No findings: silent exit 0.
  - Weak only: allow with `hookSpecificOutput.additionalContext` describing the fix commit(s).
  - Strong, mode `speedbump`, first time this key (file + fix sha) is seen this session: `permissionDecision: "deny"` with a clear `permissionDecisionReason` (what the fix was, sha, date, subject, reasons it looks like a fix, refs, test files, the exact lines, and what to do: keep the fix, rework around it, or explain to the user why removing it is safe and retry). Record the key as acknowledged.
  - Strong, same key seen again: allow with `additionalContext`, log "acknowledged".
  - Strong in a `protect` path, or mode `ask`: `permissionDecision: "ask"` with the reason.
  - Mode `warn-only`: always allow, context only.
  - Whole thing wrapped in a timer (cfg.hookTimeoutMs); on overrun print nothing and exit 0.
  - Reads meta.json, the manifest and the edited files' shards, nothing else.
  - If the index is missing: fall back to blame only (removes-fix via blame + classify the blamed commits on the fly, looking
    each commit's lines up under the path the file had in that commit), capped by the timeout.
- **Stop**: sweep `git diff HEAD` for files edited this session (from the session log) plus files that became dirty since
  SessionStart or changed since then (edits made through the shell), analyze each as whole-file changes, and if there are strong findings that were never surfaced, return `hookSpecificOutput.additionalContext` with a short ledger. Never block the stop in v1.

## Detection rules

- Fix classifier score (threshold `FIX_THRESHOLD = 3`):
  - +3 message matches `\b(fix(e[sd])?|bug|hotfix|regression|revert|race|deadlock|crash|leak|workaround|incident|cve-\d+|oncall|segfault|null ?pointer|npe|off.by.one)\b` (case-insensitive) or conventional `^fix(\(.+\))?!?:`
  - +1 message references an issue/PR (`#\d+`, `[A-Z]+-\d+`, a github/gitlab/jira URL)
  - +2 the commit adds or modifies a test file (`test/`, `tests/`, `__tests__/`, `spec/`, `*_test.*`, `*.test.*`, `*.spec.*`, `test_*.py`)
  - +1 small change (<= 5 files and <= 60 changed lines)
  - -5 merge commit, -5 only lockfiles/deps/formatting/docs/CI, -3 more than 40 files or 1500 lines
  - cfg.fixPatternsExtra regexes count like the keyword rule
- isFix also needs (index version 2):
  - a **fix signal**: the keyword rule, conventional `fix:`, or a fixPatternsExtra match. Refs, tests and size only add score.
  - not **demoted**: `fix(deps|devdeps|dev-deps|ci|build|refactor|docs|lint|style|typo|test|tests):`, `build(deps):`, `deps:`,
    `docs:`/`style:`/`lint:`/`ci:`/`test:`/`refactor:` types, `pkg@1.2.3` subjects, `chore:` unless it names race/crash/leak/regression/cve,
    subjects with bump, dependency updates, typo, spelling, codespell, lint, formatting/reformat, whitespace.
    A subject starting with a feature verb (add, support, implement, allow, introduce, feat, feature, new, enable) needs fix wording
    in the subject itself ("Fixes #N" closers do not count). Refactor verbs (refactor, rename, clean up, tidy, reorganize) are the
    same, except a strong keyword anywhere in the message rescues them.
  - **size veto**: at most 40 files and 1500 changed lines, not counting noise files (below).
  - **reverts**: "revert" is not a fix signal by itself and the quoted reverted subject is ignored; a revert counts only with its own
    fix wording or an issue ref. `Revert "Revert ...` is never a fix.
- Noise files (`isNoiseFile` in classify.ts) are never indexed and never checked: docs and changelogs (`*.md`, `*.rst`, `*.txt`,
  `*.adoc`, `History*`, `CHANGELOG*`, `README*`, `LICENSE*` ..., root `docs/` and `doc/`), CI config (`.github/`, `.gitlab-ci.yml`,
  `.travis.yml`, `appveyor.yml`, `.circleci/`, `azure-pipelines.yml`, `.pre-commit-config.yaml`), and lockfiles.
- `removes-fix` strong: a removed line's blame points at fix commit F and F's `added` contains that line's hash.
  weak: the removed line was last touched by F but hash not in F.added, or within 3 lines of a line F added.
  Blame only runs when at least one removed line hashes to a line some fix added to this file, so these weak hits only
  show up next to a possible strong one. That trade keeps ordinary edits free of git calls.
  Removals in test files are always weak.
- A change whose removed and added text are identical once all whitespace is deleted (a reflow) yields no findings.
- `re-adds-removed` strong: 2+ consecutive non-trivial added lines whose hashes appear in one fix commit's `removed` for this file (or its old paths), in order.
  weak: exactly 1 non-trivial added line of length >= 25 chars matches.
- Only non-trivial lines count (`isTrivial`). Besides braces, keywords and imports, this covers `const x = require(...)`, version pins (`"pkg": "^1.2.3",`, `version = "..."`, `pkg>=1,<2`, `uses: owner/action@v4`) and lone `"string",` list entries.
- A fix whose own removed lines equal its added lines (pure moves) contributes nothing.
