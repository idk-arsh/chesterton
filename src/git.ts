import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

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

/** Top level of the work tree containing cwd, or null when not in a git repo. */
export function repoRoot(cwd: string): string | null {
  try {
    return runGit(["rev-parse", "--show-toplevel"], cwd, 5_000).trim();
  } catch {
    return null;
  }
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
