// Shared contracts between the index (git history) side and the hook (edit check) side.
// Change these only with care: both halves of the codebase depend on them.

/** A commit the classifier decided is a bug fix. */
export interface FixCommit {
  sha: string;
  /** ISO 8601 author date. */
  date: string;
  author: string;
  subject: string;
  /** Classifier score. isFix is score >= FIX_THRESHOLD. */
  score: number;
  /** Human readable reasons, e.g. "message says 'race'", "adds test file test/retry.test.ts". */
  reasons: string[];
  /** Issue or PR references found in the message: "#412", "JIRA-88", URLs. */
  refs: string[];
  /** Test files the commit added or modified. */
  testFiles: string[];
}

/** One changed line inside a fix commit, stored normalized. */
export interface LineEntry {
  /** hashLine(normalizeLine(text)). */
  hash: string;
  /** Original text, trimmed, for display. Capped at 200 chars. */
  text: string;
  /** 1-based line number: post-image for added lines, pre-image for removed lines. */
  line: number;
}

/** What one fix commit did to one file. */
export interface FileFixRecord {
  sha: string;
  /** Path at that commit, repo-relative with forward slashes. */
  path: string;
  /** Previous path if the commit renamed the file. */
  oldPath?: string;
  /** Non-trivial lines the fix added. */
  added: LineEntry[];
  /** Non-trivial lines the fix removed. */
  removed: LineEntry[];
}

export interface ChestertonIndex {
  version: 1;
  /** HEAD sha the index was built at. */
  head: string;
  builtAt: string;
  /** Every fix commit, keyed by full sha. */
  commits: Record<string, FixCommit>;
  /** Records keyed by the file's CURRENT repo-relative path (renames followed forward). */
  files: Record<string, FileFixRecord[]>;
}

/** One line of blame output for the current working tree file. */
export interface BlameLine {
  /** Current 1-based line number. */
  line: number;
  sha: string;
  /** Line number in the commit that last touched it. */
  origLine: number;
  /** Path of the file in that commit. */
  origPath: string;
}

/** What the edit check found. */
export type FindingKind =
  /** The edit deletes or changes lines that a fix commit added. */
  | "removes-fix"
  /** The edit adds lines that a fix commit deliberately removed. */
  | "re-adds-removed";

export interface Finding {
  kind: FindingKind;
  strength: "strong" | "weak";
  file: string;
  fix: FixCommit;
  /** The lines involved, as display text. */
  lines: string[];
}

/**
 * A proposed change to one file, as line lists. Built from an Edit/Write tool call by the hook,
 * or from a git diff by `chesterton check`. The analyzer only ever sees this shape.
 */
export interface EditChange {
  /** Repo-relative, forward slashes. */
  relPath: string;
  /** Lines the change deletes (or replaces), with their CURRENT 1-based line numbers. */
  removed: { line: number; text: string }[];
  /** Lines the change adds, in order, as raw text. */
  added: string[];
  /** True when the file does not exist yet. */
  isNewFile: boolean;
}

export type Mode ="speedbump" | "ask" | "warn-only";

export interface ChestertonConfig {
  mode: Mode;
  /** How far back to index, e.g. "3y", "18m", "all". */
  history: string;
  /** Hard cap on commits walked. */
  maxCommits: number;
  /** Globs where strong hits always ask the human, regardless of mode. */
  protect: string[];
  /** Extra regex sources that count as fix keywords. */
  fixPatternsExtra: string[];
  /** Commit shas (prefixes ok) never treated as fixes. */
  ignoreCommits: string[];
  /** Budget for the PreToolUse hook in ms. On overrun it allows and logs. */
  hookTimeoutMs: number;
}

export const FIX_THRESHOLD = 3;
export const INDEX_VERSION = 1 as const;
