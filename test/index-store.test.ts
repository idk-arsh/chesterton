import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { makeRepo, type TestRepo } from "./helpers/repo.js";
import { emptyIndex, indexDir, loadIndex, recordsForFile, saveIndex } from "../src/index-store.js";
import type { ChestertonIndex } from "../src/types.js";

const repos: TestRepo[] = [];
function repo(): TestRepo {
  const r = makeRepo();
  repos.push(r);
  return r;
}
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

function sample(): ChestertonIndex {
  const idx = emptyIndex("a".repeat(40));
  idx.files["src/a.ts"] = [{ sha: "b".repeat(40), path: "src/a.ts", added: [{ hash: "1234", text: "x()", line: 1 }], removed: [] }];
  return idx;
}

describe("index-store", () => {
  it("indexDir is an absolute path inside .git and is created", () => {
    const r = repo();
    const dir = indexDir(r.dir);
    expect(isAbsolute(dir)).toBe(true);
    expect(resolve(dir)).toBe(resolve(r.dir, ".git", "chesterton"));
    expect(existsSync(dir)).toBe(true);
  });

  it("indexDir works in a linked worktree", () => {
    const r = repo();
    r.write("a.txt", "a\n");
    r.commit("initial");
    const wt = join(r.dir, "..", `${r.dir.split(/[\\/]/).pop()}-wt`);
    r.git("worktree", "add", "-q", wt);
    try {
      const dir = indexDir(wt);
      expect(isAbsolute(dir)).toBe(true);
      expect(existsSync(dir)).toBe(true);
      expect(resolve(dir)).not.toBe(resolve(indexDir(r.dir)));
      expect(resolve(dir).startsWith(resolve(r.dir, ".git"))).toBe(true);
    } finally {
      r.git("worktree", "remove", "--force", wt);
    }
  });

  it("round-trips through save and load, atomically", () => {
    const r = repo();
    const idx = sample();
    saveIndex(r.dir, idx);
    expect(loadIndex(r.dir)).toEqual(idx);
    saveIndex(r.dir, { ...idx, head: "c".repeat(40) });
    expect(loadIndex(r.dir)!.head).toBe("c".repeat(40));
    expect(readdirSync(indexDir(r.dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("loadIndex returns null for missing, corrupt, and wrong-version files", () => {
    const r = repo();
    expect(loadIndex(r.dir)).toBeNull();
    const file = join(indexDir(r.dir), "index.json");
    writeFileSync(file, "{not json");
    expect(loadIndex(r.dir)).toBeNull();
    writeFileSync(file, JSON.stringify({ ...sample(), version: 99 }));
    expect(loadIndex(r.dir)).toBeNull();
  });

  it("loadIndex returns null outside a repo", () => {
    const r = repo();
    expect(loadIndex(join(r.dir, "..", "definitely-not-here-chesterton"))).toBeNull();
  });

  it("recordsForFile accepts either slash style", () => {
    const idx = sample();
    expect(recordsForFile(idx, "src/a.ts")).toHaveLength(1);
    expect(recordsForFile(idx, "src\\a.ts")).toHaveLength(1);
    expect(recordsForFile(idx, "./src/a.ts")).toHaveLength(1);
    expect(recordsForFile(idx, "src/b.ts")).toEqual([]);
  });
});
