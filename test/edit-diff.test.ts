import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { changeFromToolCall, diffLines, resolveRepoPath } from "../src/edit-diff.js";
import { makeRepo, type TestRepo } from "./helpers/repo.js";

let repo: TestRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

function setup(files: Record<string, string>): TestRepo {
  repo = makeRepo();
  for (const [p, c] of Object.entries(files)) repo.write(p, c);
  return repo;
}

/** Reference LCS length by DP, to check diffLines is minimal. */
function lcsLen(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
  return dp[a.length]![b.length]!;
}

/** Kept lines and added lines must both be subsequences of `after` and add up to it. */
function isSubsequence(sub: string[], full: string[]): boolean {
  let k = 0;
  for (const line of full) if (k < sub.length && sub[k] === line) k++;
  return k === sub.length;
}
function applyDiff(before: string[], after: string[], d: ReturnType<typeof diffLines>): boolean {
  const removed = new Set(d.removed.map((r) => r.line));
  const kept = before.filter((_, i) => !removed.has(i + 1));
  const textsMatch = d.removed.every((r) => before[r.line - 1] === r.text);
  return textsMatch && kept.length + d.added.length === after.length && isSubsequence(kept, after) && isSubsequence(d.added, after);
}

describe("diffLines", () => {
  it("returns nothing for equal input", () => {
    expect(diffLines(["a", "b"], ["a", "b"])).toEqual({ removed: [], added: [] });
  });

  it("finds a replaced line with its before line number", () => {
    const d = diffLines(["a", "b", "c", "d"], ["a", "B", "c", "d"]);
    expect(d.removed).toEqual([{ line: 2, text: "b" }]);
    expect(d.added).toEqual(["B"]);
  });

  it("handles pure insertions and deletions", () => {
    expect(diffLines([], ["x", "y"])).toEqual({ removed: [], added: ["x", "y"] });
    expect(diffLines(["x", "y"], [])).toEqual({ removed: [{ line: 1, text: "x" }, { line: 2, text: "y" }], added: [] });
    const d = diffLines(["a", "b", "c"], ["a", "c"]);
    expect(d.removed).toEqual([{ line: 2, text: "b" }]);
    expect(d.added).toEqual([]);
  });

  it("is minimal and correct on random inputs", () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let t = 0; t < 200; t++) {
      const a = Array.from({ length: Math.floor(rnd() * 25) }, () => "abcde"[Math.floor(rnd() * 5)]!);
      const b = Array.from({ length: Math.floor(rnd() * 25) }, () => "abcde"[Math.floor(rnd() * 5)]!);
      const d = diffLines(a, b);
      expect(applyDiff(a, b, d)).toBe(true);
      const l = lcsLen(a, b);
      expect(d.removed.length).toBe(a.length - l);
      expect(d.added.length).toBe(b.length - l);
    }
  });

  it("falls back to a trim diff on huge, totally different inputs", () => {
    const a = Array.from({ length: 6000 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 6000 }, (_, i) => `b${i}`);
    const t = Date.now();
    const d = diffLines(["same", ...a, "end"], ["same", ...b, "end"]);
    expect(Date.now() - t).toBeLessThan(5000);
    expect(d.removed.length).toBe(6000);
    expect(d.removed[0]).toEqual({ line: 2, text: "a0" });
    expect(d.added.length).toBe(6000);
  });
});

describe("resolveRepoPath", () => {
  it("accepts relative, absolute and backslash paths, rejects outside", () => {
    const r = setup({ "src/a.ts": "x\n" });
    expect(resolveRepoPath(r.dir, "src/a.ts")?.rel).toBe("src/a.ts");
    expect(resolveRepoPath(r.dir, join(r.dir, "src", "a.ts"))?.rel).toBe("src/a.ts");
    expect(resolveRepoPath(r.dir, join(r.dir, "src", "a.ts").replace(/\\/g, "/"))?.rel).toBe("src/a.ts");
    expect(resolveRepoPath(r.dir, join(r.dir, "..", "elsewhere.ts"))).toBeNull();
    expect(resolveRepoPath(r.dir, "../x.ts")).toBeNull();
    expect(resolveRepoPath(r.dir, ".git/config")).toBeNull();
    expect(resolveRepoPath(r.dir, "")).toBeNull();
  });
});

describe("changeFromToolCall", () => {
  const file = "a\nb\nold line one\nold line two\nc\n";

  it("Edit replaces a block and maps removed lines to file line numbers", () => {
    const r = setup({ "src/a.ts": file });
    const ch = changeFromToolCall(r.dir, "Edit", {
      file_path: join(r.dir, "src", "a.ts"),
      old_string: "old line one\nold line two\n",
      new_string: "new line\n",
    });
    expect(ch).toHaveLength(1);
    expect(ch[0]).toEqual({
      relPath: "src/a.ts",
      removed: [
        { line: 3, text: "old line one" },
        { line: 4, text: "old line two" },
      ],
      added: ["new line"],
      isNewFile: false,
    });
  });

  it("Edit inside a single line counts that whole line", () => {
    const r = setup({ "a.ts": "const x = 1;\nconst y = 2;\n" });
    const ch = changeFromToolCall(r.dir, "Edit", { file_path: "a.ts", old_string: "y = 2", new_string: "y = 3" });
    expect(ch[0]!.removed).toEqual([{ line: 2, text: "const y = 2;" }]);
    expect(ch[0]!.added).toEqual(["const y = 3;"]);
  });

  it("replace_all merges every occurrence into one change", () => {
    const r = setup({ "a.ts": "foo()\nbar\nfoo()\nbaz\nfoo()\n" });
    const ch = changeFromToolCall(r.dir, "Edit", { file_path: "a.ts", old_string: "foo()", new_string: "qux()", replace_all: true });
    expect(ch).toHaveLength(1);
    expect(ch[0]!.removed.map((x) => x.line)).toEqual([1, 3, 5]);
    expect(ch[0]!.added).toEqual(["qux()", "qux()", "qux()"]);
  });

  it("without replace_all only the first occurrence changes", () => {
    const r = setup({ "a.ts": "foo()\nbar\nfoo()\n" });
    const ch = changeFromToolCall(r.dir, "Edit", { file_path: "a.ts", old_string: "foo()", new_string: "qux()" });
    expect(ch[0]!.removed).toEqual([{ line: 1, text: "foo()" }]);
  });

  it("returns [] when old_string is not found", () => {
    const r = setup({ "a.ts": file });
    expect(changeFromToolCall(r.dir, "Edit", { file_path: "a.ts", old_string: "nope", new_string: "x" })).toEqual([]);
  });

  it("handles CRLF files when old_string uses LF", () => {
    const r = setup({ "a.ts": file.replace(/\n/g, "\r\n") });
    const ch = changeFromToolCall(r.dir, "Edit", { file_path: "a.ts", old_string: "old line one\nold line two", new_string: "new" });
    expect(ch[0]!.removed).toEqual([
      { line: 3, text: "old line one" },
      { line: 4, text: "old line two" },
    ]);
    expect(ch[0]!.added).toEqual(["new"]);
  });

  it("handles CRLF old_string against an LF file", () => {
    const r = setup({ "a.ts": file });
    const ch = changeFromToolCall(r.dir, "Edit", { file_path: "a.ts", old_string: "old line one\r\nold line two", new_string: "new" });
    expect(ch[0]!.removed.map((x) => x.line)).toEqual([3, 4]);
  });

  it("returns [] for paths outside the repo", () => {
    const r = setup({ "a.ts": file });
    expect(changeFromToolCall(r.dir, "Write", { file_path: join(r.dir, "..", "x.ts"), content: "x\n" })).toEqual([]);
  });

  it("Write to a new file adds every line", () => {
    const r = setup({});
    const ch = changeFromToolCall(r.dir, "Write", { file_path: "src/new.ts", content: "one\ntwo\n" });
    expect(ch).toEqual([{ relPath: "src/new.ts", removed: [], added: ["one", "two"], isNewFile: true }]);
  });

  it("Write over an existing file diffs the whole file", () => {
    const r = setup({ "a.ts": file });
    const ch = changeFromToolCall(r.dir, "Write", { file_path: "a.ts", content: "a\nb\nc\n" });
    expect(ch[0]!.removed.map((x) => x.line)).toEqual([3, 4]);
    expect(ch[0]!.added).toEqual([]);
  });

  it("MultiEdit applies edits in order and diffs original against final", () => {
    const r = setup({ "a.ts": file });
    const ch = changeFromToolCall(r.dir, "MultiEdit", {
      file_path: "a.ts",
      edits: [
        { old_string: "old line one", new_string: "tmp" },
        { old_string: "tmp\nold line two", new_string: "merged line" },
      ],
    });
    expect(ch[0]!.removed.map((x) => x.line)).toEqual([3, 4]);
    expect(ch[0]!.added).toEqual(["merged line"]);
  });

  it("MultiEdit with a missing old_string returns []", () => {
    const r = setup({ "a.ts": file });
    expect(
      changeFromToolCall(r.dir, "MultiEdit", { file_path: "a.ts", edits: [{ old_string: "a", new_string: "z" }, { old_string: "zzz", new_string: "q" }] }),
    ).toEqual([]);
  });

  it("ignores other tools and bad input", () => {
    const r = setup({ "a.ts": file });
    expect(changeFromToolCall(r.dir, "Read", { file_path: "a.ts" })).toEqual([]);
    expect(changeFromToolCall(r.dir, "Edit", null)).toEqual([]);
    expect(changeFromToolCall(r.dir, "Edit", { file_path: 3 })).toEqual([]);
  });

  it("no-op edits return []", () => {
    const r = setup({ "a.ts": file });
    expect(changeFromToolCall(r.dir, "Edit", { file_path: "a.ts", old_string: "a\n", new_string: "a\n" })).toEqual([]);
  });
});
