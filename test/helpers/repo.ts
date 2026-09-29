import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runGit } from "../../src/git.js";

/**
 * Throwaway git repo for tests. Commits get deterministic dates so history order is stable.
 *
 *   const r = makeRepo();
 *   r.write("src/a.ts", "x\n");
 *   r.commit("initial");
 *   r.write("src/a.ts", "x\nawait sleep(50) // wait for socket flush\n");
 *   r.commit("fix: race on socket close (#412)");
 */
export interface TestRepo {
  dir: string;
  write(path: string, content: string): void;
  read(path: string): string;
  rm(path: string): void;
  mv(from: string, to: string): void;
  /** Stage everything and commit. Returns the new sha. */
  commit(message: string): string;
  git(...args: string[]): string;
  cleanup(): void;
}

export function makeRepo(): TestRepo {
  const dir = mkdtempSync(join(tmpdir(), "chesterton-test-"));
  let tick = 0;
  const git = (...args: string[]) => runGit(args, dir);
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test User");
  git("config", "user.email", "test@example.com");
  git("config", "core.autocrlf", "false");
  git("config", "commit.gpgsign", "false");

  return {
    dir,
    write(path, content) {
      const full = join(dir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    },
    read(path) {
      return readFileSync(join(dir, path), "utf8");
    },
    rm(path) {
      git("rm", "-q", path);
    },
    mv(from, to) {
      mkdirSync(dirname(join(dir, to)), { recursive: true });
      git("mv", from, to);
    },
    commit(message) {
      tick += 1;
      const date = new Date(Date.UTC(2025, 0, 1) + tick * 3600_000).toISOString();
      git("add", "-A");
      const res = runGitEnv(["commit", "-q", "--allow-empty", "-m", message], dir, {
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      });
      void res;
      return git("rev-parse", "HEAD").trim();
    },
    git,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

import { spawnSync } from "node:child_process";
function runGitEnv(args: string[], cwd: string, env: Record<string, string>): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env }, windowsHide: true });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout;
}
