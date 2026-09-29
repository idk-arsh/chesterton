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

function isValidIndex(x: unknown): x is ChestertonIndex {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    o.version === INDEX_VERSION &&
    typeof o.head === "string" &&
    typeof o.builtAt === "string" &&
    !!o.commits &&
    typeof o.commits === "object" &&
    !!o.files &&
    typeof o.files === "object"
  );
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
