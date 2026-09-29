import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { makeRepo, type TestRepo } from "./helpers/repo.js";
import { emptyIndex, indexDir, loadIndex, loadIndexForFiles, loadMeta, recordsForFile, saveIndex } from "../src/index-store.js";
import type { ChestertonIndex, FixCommit } from "../src/types.js";

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
    // Links and 8.3 short names in the temp path come back resolved, the way git prints the git dir.
    expect(resolve(dir)).toBe(resolve(realpathSync.native(r.dir), ".git", "chesterton"));
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
      expect(resolve(dir).startsWith(resolve(realpathSync.native(r.dir), ".git"))).toBe(true);
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
    const file = join(indexDir(r.dir), "meta.json");
    writeFileSync(file, "{not json");
    expect(loadIndex(r.dir)).toBeNull();
    writeFileSync(file, JSON.stringify({ ...sample(), version: 99 }));
    expect(loadIndex(r.dir)).toBeNull();
    // Version 1 indexes were built with the old classifier and must be rebuilt.
    writeFileSync(file, JSON.stringify({ ...sample(), version: 1 }));
    expect(loadIndex(r.dir)).toBeNull();
    // A version 2 single-file index is never read.
    writeFileSync(join(indexDir(r.dir), "index.json"), JSON.stringify({ ...sample(), version: 2 }));
    expect(loadIndex(r.dir)).toBeNull();
    expect(loadMeta(r.dir)).toBeNull();
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

describe("sharded index (version 3)", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const C = "c".repeat(40);
  const commit = (sha: string, subject: string): FixCommit => ({
    sha,
    date: "2025-01-01T00:00:00+00:00",
    author: "Jane",
    subject,
    score: 5,
    reasons: ["message says 'fix'"],
    refs: [],
    testFiles: [],
  });
  const rec = (sha: string, path: string, text: string) => ({ sha, path, added: [{ hash: text.length.toString(16), text, line: 1 }], removed: [] });
  function bigSample(): ChestertonIndex {
    const idx = emptyIndex("d".repeat(40));
    idx.commits = { [A]: commit(A, "fix: one"), [B]: commit(B, "fix: two"), [C]: commit(C, "fix: three, no records") };
    idx.files["src/a.ts"] = [rec(A, "src/a.ts", "guardA()")];
    idx.files["src/b.ts"] = [rec(B, "src/b.ts", "guardB()"), rec(A, "src/b.ts", "guardAB()")];
    return idx;
  }
  const shardDir = (r: TestRepo) => join(indexDir(r.dir), "shards");

  it("writes a small meta.json, a manifest, a commits file and one shard per file", () => {
    const r = repo();
    const idx = bigSample();
    saveIndex(r.dir, idx);
    const meta = loadMeta(r.dir)!;
    expect(meta).toMatchObject({ version: 3, head: "d".repeat(40), fixCommits: 3, files: 2 });
    expect(statSync(join(indexDir(r.dir), "meta.json")).size).toBeLessThan(400);
    const names = readdirSync(indexDir(r.dir));
    expect(names).toContain(`manifest-${meta.id}.json`);
    expect(names).toContain(`commits-${meta.id}.json`);
    expect(readdirSync(shardDir(r))).toHaveLength(2);
    expect(loadIndex(r.dir)).toEqual(idx);
  });

  it("loadIndexForFiles reads only the files asked for, with the commits their records name", () => {
    const r = repo();
    saveIndex(r.dir, bigSample());
    const part = loadIndexForFiles(r.dir, ["src/a.ts"])!;
    expect(Object.keys(part.files)).toEqual(["src/a.ts"]);
    expect(Object.keys(part.commits)).toEqual([A]);
    // Other files' shards are never opened: deleting one does not matter.
    const manifest = JSON.parse(readFileSync(join(indexDir(r.dir), `manifest-${loadMeta(r.dir)!.id}.json`), "utf8"));
    unlinkSync(join(shardDir(r), `${manifest.files["src/b.ts"]}.json`));
    expect(loadIndexForFiles(r.dir, ["src\\a.ts"])?.files["src/a.ts"]).toHaveLength(1);
    expect(loadIndexForFiles(r.dir, ["./src/a.ts"])?.files["src/a.ts"]).toHaveLength(1);
    expect(loadIndexForFiles(r.dir, ["src\\a.ts", "./src/a.ts"])?.files["src/a.ts"]).toHaveLength(1);
    // A file with no records gives an empty but usable index.
    expect(loadIndexForFiles(r.dir, ["src/none.ts"])).toMatchObject({ files: {}, commits: {} });
    // With allCommits, every fix commit comes along.
    expect(Object.keys(loadIndexForFiles(r.dir, ["src/a.ts"], { allCommits: true })!.commits).sort()).toEqual([A, B, C]);
    // The whole index needs every shard, so it is now unusable and gets rebuilt.
    expect(loadIndex(r.dir)).toBeNull();
    expect(loadIndexForFiles(r.dir, ["src/b.ts"])).toBeNull();
  });

  it("reuses unchanged shards on the next save and removes old generations", () => {
    const r = repo();
    saveIndex(r.dir, bigSample());
    const first = new Set(readdirSync(shardDir(r)));
    const next = bigSample();
    next.head = "e".repeat(40);
    next.files["src/b.ts"] = [rec(B, "src/b.ts", "guardB()")];
    saveIndex(r.dir, next);
    const second = readdirSync(shardDir(r));
    expect(second).toHaveLength(2);
    // src/a.ts did not change, so its shard is the same file.
    expect(second.filter((f) => first.has(f))).toHaveLength(1);
    const meta = loadMeta(r.dir)!;
    const gens = readdirSync(indexDir(r.dir)).filter((f) => /^(manifest|commits)-/.test(f));
    expect(gens.sort()).toEqual([`commits-${meta.id}.json`, `manifest-${meta.id}.json`]);
    expect(loadIndex(r.dir)!.files["src/b.ts"]).toHaveLength(1);
  });

  it("a damaged shard is dropped, so the next save writes it again", () => {
    const r = repo();
    saveIndex(r.dir, bigSample());
    const [victim] = readdirSync(shardDir(r));
    writeFileSync(join(shardDir(r), victim!), "{ damaged");
    expect(loadIndex(r.dir)).toBeNull();
    expect(existsSync(join(shardDir(r), victim!))).toBe(false);
    saveIndex(r.dir, bigSample());
    expect(loadIndex(r.dir)).not.toBeNull();
  });

  it("a manifest that names a path outside the shard folder is rejected", () => {
    const r = repo();
    saveIndex(r.dir, bigSample());
    const file = join(indexDir(r.dir), `manifest-${loadMeta(r.dir)!.id}.json`);
    const m = JSON.parse(readFileSync(file, "utf8"));
    m.files["src/a.ts"] = "../../config";
    writeFileSync(file, JSON.stringify(m));
    expect(loadIndexForFiles(r.dir, ["src/a.ts"])).toBeNull();
    expect(loadIndex(r.dir)).toBeNull();
  });
});
