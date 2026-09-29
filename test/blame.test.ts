import { afterEach, describe, expect, it } from "vitest";
import { makeRepo, type TestRepo } from "./helpers/repo.js";
import { blameRange } from "../src/blame.js";

const repos: TestRepo[] = [];
function repo(): TestRepo {
  const r = makeRepo();
  repos.push(r);
  return r;
}
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

const ZERO = "0".repeat(40);

describe("blameRange", () => {
  it("blames committed lines to the right commits", () => {
    const r = repo();
    r.write("src/a.ts", "one\ntwo\nthree\n");
    const c1 = r.commit("initial");
    r.write("src/a.ts", "one\ntwo changed\nthree\nfour\n");
    const c2 = r.commit("change");

    const lines = blameRange(r.dir, "src/a.ts", 1, 4);
    expect(lines.map((l) => [l.line, l.sha])).toEqual([
      [1, c1],
      [2, c2],
      [3, c1],
      [4, c2],
    ]);
    expect(lines[2]).toEqual({ line: 3, sha: c1, origLine: 3, origPath: "src/a.ts" });
  });

  it("returns only the requested range and clamps past the end", () => {
    const r = repo();
    r.write("a.txt", "a\nb\nc\n");
    r.commit("initial");
    expect(blameRange(r.dir, "a.txt", 2, 2).map((l) => l.line)).toEqual([2]);
    expect(blameRange(r.dir, "a.txt", 2, 99).map((l) => l.line)).toEqual([2, 3]);
    expect(blameRange(r.dir, "a.txt", 10, 12)).toEqual([]);
  });

  it("reports uncommitted lines with a zero sha", () => {
    const r = repo();
    r.write("a.txt", "a\nb\n");
    const c1 = r.commit("initial");
    r.write("a.txt", "a\nnew line\nb\n");
    const lines = blameRange(r.dir, "a.txt", 1, 3);
    expect(lines.map((l) => l.sha)).toEqual([c1, ZERO, c1]);
    expect(lines[2]!.origLine).toBe(2);
  });

  it("returns [] for untracked and missing files", () => {
    const r = repo();
    r.write("a.txt", "a\n");
    r.commit("initial");
    r.write("new.txt", "fresh\n");
    expect(blameRange(r.dir, "new.txt", 1, 1)).toEqual([]);
    expect(blameRange(r.dir, "nope.txt", 1, 1)).toEqual([]);
  });

  it("follows the original path across renames and handles spaces", () => {
    const r = repo();
    r.write("old name.txt", "alpha\nbeta\n");
    const c1 = r.commit("initial");
    r.mv("old name.txt", "new dir/new name.txt");
    r.commit("rename");
    const lines = blameRange(r.dir, "new dir/new name.txt", 1, 2);
    expect(lines.map((l) => [l.sha, l.origPath])).toEqual([
      [c1, "old name.txt"],
      [c1, "old name.txt"],
    ]);
  });

  it("handles CRLF files", () => {
    const r = repo();
    r.write("w.txt", "a\r\nb\r\nc\r\n");
    const c1 = r.commit("initial");
    expect(blameRange(r.dir, "w.txt", 1, 3).map((l) => l.sha)).toEqual([c1, c1, c1]);
  });
});
