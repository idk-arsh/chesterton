import { spawnSync } from "node:child_process";

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
