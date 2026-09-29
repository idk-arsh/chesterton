import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dirtyFiles, findRepoInJs, locateRepo, repoRoot, runGit } from "../src/git.js";
import { indexDir } from "../src/index-store.js";
import { makeRepo, type TestRepo } from "./helpers/repo.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()!();
    } catch {
      /* ignore */
    }
  }
});

function repo(): TestRepo {
  const r = makeRepo();
  cleanups.push(() => r.cleanup());
  return r;
}

const same = (a: string, b: string) => {
  const n = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  return n(a) === n(b);
};

describe("finding the repo without starting git", () => {
  it("matches git rev-parse at the top and in a subdirectory", () => {
    const r = repo();
    r.write("src/deep/a.ts", "x\n");
    r.commit("initial");
    const want = r.git("rev-parse", "--show-toplevel").trim();
    const wantGitDir = r.git("rev-parse", "--absolute-git-dir").trim();
    for (const cwd of [r.dir, join(r.dir, "src"), join(r.dir, "src", "deep")]) {
      const loc = findRepoInJs(cwd);
      expect(loc).not.toBeNull();
      expect(loc!.root).toBe(want);
      expect(same(loc!.gitDir, wantGitDir)).toBe(true);
    }
  });

  it("returns null outside any repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "chesterton-nogit-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    // A repo higher up (a home directory under git, say) would be found by git too, so only
    // check that both agree.
    let fromGit: string | null = null;
    try {
      fromGit = runGit(["rev-parse", "--show-toplevel"], dir).trim();
    } catch {
      fromGit = null;
    }
    expect(repoRoot(dir)).toBe(fromGit);
  });

  it("follows a .git file into a linked worktree's own git dir", () => {
    const r = repo();
    r.write("a.txt", "a\n");
    r.commit("initial");
    const wt = join(r.dir, "..", `${r.dir.split(/[\\/]/).pop()}-wt2`);
    r.git("worktree", "add", "-q", wt);
    cleanups.unshift(() => rmSync(wt, { recursive: true, force: true }));
    const loc = findRepoInJs(join(wt));
    expect(loc).not.toBeNull();
    const git = runGit(["rev-parse", "--show-toplevel", "--absolute-git-dir"], wt).split(/\r?\n/);
    expect(loc!.root).toBe(git[0]!.trim());
    expect(same(loc!.gitDir, git[1]!.trim())).toBe(true);
    expect(same(indexDir(wt), join(git[1]!.trim(), "chesterton"))).toBe(true);
  });

  it("follows a relative gitdir: line (submodule style)", () => {
    const r = repo();
    r.write("a.txt", "a\n");
    r.commit("initial");
    // Fake a submodule layout: the work tree has a .git file pointing at a git dir elsewhere.
    const sub = join(r.dir, "vendor", "lib");
    mkdirSync(sub, { recursive: true });
    const modDir = join(r.dir, ".git", "modules", "lib");
    mkdirSync(join(r.dir, ".git", "modules"), { recursive: true });
    runGit(["init", "-q", "--separate-git-dir", modDir, sub], r.dir);
    // Git marks the file hidden on Windows, which blocks overwriting it in place.
    unlinkSync(join(sub, ".git"));
    writeFileSync(join(sub, ".git"), "gitdir: ../../.git/modules/lib\n");
    const loc = findRepoInJs(sub);
    expect(loc).not.toBeNull();
    expect(same(loc!.root, sub)).toBe(true);
    expect(same(loc!.gitDir, modDir)).toBe(true);
  });

  it("hands unusual layouts to git: broken .git file, GIT_DIR, core.worktree", () => {
    const dir = mkdtempSync(join(tmpdir(), "chesterton-broken-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, ".git"), "gitdir: ./does/not/exist\n");
    expect(() => findRepoInJs(dir)).toThrow();
    // locateRepo never throws; git decides (and fails here).
    expect(() => locateRepo(dir)).not.toThrow();

    const r = repo();
    r.write("a.txt", "a\n");
    r.commit("initial");
    const old = process.env.GIT_DIR;
    process.env.GIT_DIR = join(r.dir, ".git");
    try {
      expect(() => findRepoInJs(r.dir)).toThrow();
      expect(locateRepo(r.dir)).not.toBeNull();
    } finally {
      if (old === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = old;
    }

    // A ceiling directory can hide a repo from git; the JS walk must not find it either.
    const sub = join(r.dir, "src");
    mkdirSync(sub, { recursive: true });
    const oldCeil = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = r.dir;
    try {
      expect(() => findRepoInJs(sub)).toThrow();
      let fromGit: string | null = null;
      try {
        fromGit = runGit(["rev-parse", "--show-toplevel"], sub).trim();
      } catch {
        fromGit = null;
      }
      expect(repoRoot(sub)).toBe(fromGit);
    } finally {
      if (oldCeil === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = oldCeil;
    }

    r.git("config", "core.worktree", r.dir);
    expect(() => findRepoInJs(r.dir)).toThrow();
    expect(locateRepo(r.dir)?.root).toBe(r.git("rev-parse", "--show-toplevel").trim());
  });
});

describe("dirtyFiles", () => {
  it("lists modified, staged, deleted and untracked files, not ignored ones", () => {
    const r = repo();
    r.write("a.ts", "a\n");
    r.write("b.ts", "b\n");
    r.write("c.ts", "c\n");
    r.write(".gitignore", "*.log\n");
    r.commit("initial");
    r.write("a.ts", "a2\n");
    r.write("b.ts", "b2\n");
    r.git("add", "b.ts");
    r.git("rm", "-q", "c.ts");
    r.write("new dir/n.ts", "n\n");
    r.write("x.log", "ignored\n");
    expect(dirtyFiles(r.dir).sort()).toEqual(["a.ts", "b.ts", "c.ts", "new dir/n.ts"]);
  });
});
