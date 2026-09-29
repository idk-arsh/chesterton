import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export class GitError extends Error {}

/**
 * Run git synchronously and return stdout. Throws GitError on non-zero exit or timeout.
 * Sync on purpose: the hook is a short-lived process and sync keeps control flow simple.
 */
export function runGit(args: string[], cwd: string, timeoutMs = 10_000): string {
  const res = spawnSync("git", ["-c", "core.quotepath=off", ...args], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  if (res.error) throw new GitError(`git ${args[0]} failed: ${res.error.message}`);
  if (res.status !== 0) throw new GitError(`git ${args[0]} exited ${res.status}: ${res.stderr.trim()}`);
  return res.stdout;
}

/** Where a work tree and its git dir live. */
export interface RepoLocation {
  /** Top level of the work tree, in the same form `git rev-parse --show-toplevel` prints. */
  root: string;
  /** Absolute git dir for this work tree (per-worktree dir for linked worktrees and submodules). */
  gitDir: string;
}

/** Environment variables that change how git finds the repo. With any of them set, git decides. */
const GIT_DISCOVERY_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM"];

/** Thrown by findRepoInJs when the layout needs git itself to make sense of it. */
class NeedGit extends Error {}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Git dir named by a `.git` file (`gitdir: <path>`), used by linked worktrees and submodules. */
function readGitFile(dotGit: string): string {
  const text = readFileSync(dotGit, "utf8");
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!m) throw new NeedGit("not a gitdir file");
  const target = m[1]!;
  return isAbsolute(target) ? resolve(target) : resolve(dirname(dotGit), target);
}

/** A config that moves the work tree elsewhere (core.worktree) or marks the repo bare. */
function hasUnusualConfig(gitDir: string): boolean {
  const files = [join(gitDir, "config")];
  try {
    const common = readFileSync(join(gitDir, "commondir"), "utf8").trim();
    if (common) files.push(join(isAbsolute(common) ? common : resolve(gitDir, common), "config"));
  } catch {
    // not a linked worktree
  }
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    if (/^\s*worktree\s*=/im.test(text) || /^\s*bare\s*=\s*true\s*$/im.test(text)) return true;
  }
  return false;
}

function gitStylePath(p: string): string {
  let r = p;
  try {
    r = realpathSync.native(p);
  } catch {
    // keep as is
  }
  return process.platform === "win32" ? r.replace(/\\/g, "/") : r;
}

/**
 * Find the repo that contains `cwd` by walking up and looking for `.git`, without starting git.
 * Returns null when there is none. Throws NeedGit for layouts git should decide on (GIT_DIR in the
 * environment, a broken `.git` file, core.worktree or a bare repo).
 */
export function findRepoInJs(cwd: string): RepoLocation | null {
  for (const v of GIT_DISCOVERY_ENV) if (process.env[v]) throw new NeedGit(`${v} is set`);
  let dir = resolve(cwd);
  for (;;) {
    const dotGit = join(dir, ".git");
    let gitDir: string | null = null;
    if (isDir(dotGit)) {
      if (!existsSync(join(dotGit, "HEAD"))) throw new NeedGit("no HEAD in .git");
      gitDir = dotGit;
    } else if (isFile(dotGit)) {
      gitDir = readGitFile(dotGit);
      if (!existsSync(join(gitDir, "HEAD"))) throw new NeedGit("gitdir file points nowhere");
    }
    if (gitDir) {
      if (hasUnusualConfig(gitDir)) throw new NeedGit("unusual config");
      return { root: gitStylePath(dir), gitDir };
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Repo location from git itself. Null when not in a repo or git fails. */
function findRepoWithGit(cwd: string): RepoLocation | null {
  try {
    const out = runGit(["rev-parse", "--show-toplevel", "--absolute-git-dir"], cwd, 5_000).split(/\r?\n/);
    const root = out[0]?.trim();
    const gitDir = out[1]?.trim();
    if (!root || !gitDir) return null;
    return { root, gitDir: isAbsolute(gitDir) ? gitDir : resolve(root, gitDir) };
  } catch {
    return null;
  }
}

/**
 * Repo location for cwd. Walks up in JS first (no process start); falls back to git when the
 * layout is unusual or anything goes wrong. Never throws.
 */
export function locateRepo(cwd: string): RepoLocation | null {
  try {
    return findRepoInJs(cwd);
  } catch {
    return findRepoWithGit(cwd);
  }
}

/** Top level of the work tree containing cwd, or null when not in a git repo. */
export function repoRoot(cwd: string): string | null {
  return locateRepo(cwd)?.root ?? null;
}

/** Like runGit, but feeds `input` to git's stdin (for `--stdin` style commands). Throws GitError on failure. */
export function runGitWithInput(args: string[], cwd: string, input: string, timeoutMs = 10_000): string {
  const res = spawnSync("git", ["-c", "core.quotepath=off", ...args], {
    cwd,
    input,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 1024,
    windowsHide: true,
  });
  if (res.error) throw new GitError(`git ${args[0]} failed: ${res.error.message}`);
  if (res.status !== 0) throw new GitError(`git ${args[0]} exited ${res.status}: ${res.stderr.trim()}`);
  return res.stdout;
}

/** Full sha of HEAD, or null when there is no commit yet (or not a repo). */
export function headSha(cwd: string, timeoutMs = 5_000): string | null {
  try {
    const out = runGit(["rev-parse", "--verify", "-q", "HEAD^{commit}"], cwd, timeoutMs).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Shallow clone info. `boundary` holds the grafted commits listed in <git-dir>/shallow: git shows
 * them without parents, so their diff claims every line of every file. Never throws.
 */
export function shallowInfo(cwd: string, timeoutMs = 5_000): { shallow: boolean; boundary: Set<string> } {
  const boundary = new Set<string>();
  try {
    let p = runGit(["rev-parse", "--git-path", "shallow"], cwd, timeoutMs).trim();
    if (!isAbsolute(p)) p = resolve(cwd, p);
    if (!existsSync(p)) return { shallow: false, boundary };
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const sha = line.trim();
      if (sha) boundary.add(sha);
    }
    return { shallow: boundary.size > 0, boundary };
  } catch {
    return { shallow: false, boundary };
  }
}

/** True when `ancestor` is an ancestor of (or equal to) `descendant`. False on any error. */
export function isAncestor(cwd: string, ancestor: string, descendant: string, timeoutMs = 10_000): boolean {
  try {
    runGit(["merge-base", "--is-ancestor", ancestor, descendant], cwd, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Repo-relative paths that differ from HEAD in the working tree or index: modified, added,
 * deleted, renamed (new path) and untracked files. Throws GitError when git fails.
 */
export function dirtyFiles(cwd: string, timeoutMs = 5_000): string[] {
  const out = runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], cwd, timeoutMs);
  const parts = out.split("\0");
  const files: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    // Rename and copy entries carry the old path as the next field.
    if (/[RC]/.test(xy)) i++;
    if (xy === "!!" || path.endsWith("/")) continue;
    files.push(path);
  }
  return files;
}
