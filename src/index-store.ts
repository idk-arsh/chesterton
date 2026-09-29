import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ChestertonIndex, FileFixRecord } from "./types.js";
import { INDEX_VERSION } from "./types.js";
import { runGit } from "./git.js";
import { toPosix } from "./normalize.js";

export const INDEX_FILE = "index.json";

const dirCache = new Map<string, string>();

/**
 * Absolute `<git-dir>/chesterton`, created if missing.
 * Uses the per-worktree git dir, so each worktree (which can sit at its own HEAD) keeps its own index.
 * Throws GitError when repoRoot is not inside a git repo.
 */
export function indexDir(repoRoot: string): string {
  const cached = dirCache.get(repoRoot);
  if (cached && existsSync(cached)) return cached;
  let gitDir: string;
  try {
    gitDir = runGit(["rev-parse", "--absolute-git-dir"], repoRoot, 5_000).trim();
  } catch {
    // Older git without --absolute-git-dir: resolve --git-dir against the repo root.
    gitDir = runGit(["rev-parse", "--git-dir"], repoRoot, 5_000).trim();
  }
  if (!isAbsolute(gitDir)) gitDir = resolve(repoRoot, gitDir);
  const dir = join(gitDir, "chesterton");
  mkdirSync(dir, { recursive: true });
  dirCache.set(repoRoot, dir);
  return dir;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const isStrArr = (x: unknown): boolean => Array.isArray(x) && x.every((v) => typeof v === "string");

function isValidEntries(x: unknown): boolean {
  if (!Array.isArray(x)) return false;
  for (const e of x) {
    if (!isObj(e) || typeof e.hash !== "string" || typeof e.text !== "string" || typeof e.line !== "number") return false;
  }
  return true;
}

function isValidCommit(x: unknown): boolean {
  return (
    isObj(x) &&
    typeof x.sha === "string" &&
    typeof x.date === "string" &&
    typeof x.author === "string" &&
    typeof x.subject === "string" &&
    typeof x.score === "number" &&
    isStrArr(x.reasons) &&
    isStrArr(x.refs) &&
    isStrArr(x.testFiles)
  );
}

function isValidRecord(x: unknown): boolean {
  return (
    isObj(x) &&
    typeof x.sha === "string" &&
    typeof x.path === "string" &&
    (x.oldPath === undefined || typeof x.oldPath === "string") &&
    isValidEntries(x.added) &&
    isValidEntries(x.removed)
  );
}

/**
 * Checks the whole shape, records included: one malformed record would otherwise make every
 * incremental build throw, and the index would never update again.
 */
function isValidIndex(x: unknown): x is ChestertonIndex {
  if (!isObj(x)) return false;
  if (x.version !== INDEX_VERSION || typeof x.head !== "string" || typeof x.builtAt !== "string") return false;
  if (!isObj(x.commits) || !isObj(x.files)) return false;
  for (const c of Object.values(x.commits)) if (!isValidCommit(c)) return false;
  for (const recs of Object.values(x.files)) {
    if (!Array.isArray(recs) || !recs.every(isValidRecord)) return false;
  }
  return true;
}

/** The saved index, or null when it is missing, unreadable, corrupt, or from another version. Never throws. */
export function loadIndex(repoRoot: string): ChestertonIndex | null {
  try {
    const file = join(indexDir(repoRoot), INDEX_FILE);
    if (!existsSync(file)) return null;
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isValidIndex(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Write the index atomically: write a temp file next to it, then rename over the old one. */
export function saveIndex(repoRoot: string, idx: ChestertonIndex): void {
  const dir = indexDir(repoRoot);
  const file = join(dir, INDEX_FILE);
  const tmp = join(dir, `${INDEX_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmp, JSON.stringify(idx));
  let lastErr: unknown;
  // Windows can refuse the rename for a moment while another process has the old file open.
  for (let i = 0; i < 10; i++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      const until = Date.now() + 20 * (i + 1);
      while (Date.now() < until) {
        /* short spin; this path is rare */
      }
    }
  }
  try {
    unlinkSync(tmp);
  } catch {
    /* ignore */
  }
  throw lastErr;
}

/** Records for a repo-relative path (either slash style, optional leading "./"). */
export function recordsForFile(idx: ChestertonIndex, relPath: string): FileFixRecord[] {
  const key = toPosix(relPath).replace(/^(\.\/)+/, "");
  return idx.files[key] ?? [];
}

/** A valid index with nothing in it. */
export function emptyIndex(head = ""): ChestertonIndex {
  return { version: INDEX_VERSION, head, builtAt: new Date().toISOString(), commits: {}, files: {} };
}
