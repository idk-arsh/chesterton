import { afterEach, describe, expect, it } from "vitest";
import { blameAt, changesFromGitDiff, gitDiffChanges, parseBlamePorcelain, parseUnifiedDiff, unquotePath } from "../src/diff-change.js";
import { makeRepo, type TestRepo } from "./helpers/repo.js";

describe("parseUnifiedDiff", () => {
  it("numbers removed lines in the pre-image and keeps added lines in order", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -3,2 +3 @@ function x() {",
      "-  await sleep(50)",
      "-  retry()",
      "+  go()",
      "@@ -10 +9,0 @@",
      "-  last",
      "@@ -20,0 +20,2 @@",
      "+  new one",
      "+  new two",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual([
      {
        relPath: "src/a.ts",
        removed: [
          { line: 3, text: "  await sleep(50)" },
          { line: 4, text: "  retry()" },
          { line: 10, text: "  last" },
        ],
        added: ["  go()", "  new one", "  new two"],
        isNewFile: false,
      },
    ]);
  });

  it("keeps lines that look like diff headers inside a hunk", () => {
    const diff = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1 @@", "--- not a header", "+++ also not", ""].join("\n");
    const [c] = parseUnifiedDiff(diff);
    expect(c?.removed).toEqual([{ line: 1, text: "-- not a header" }]);
    expect(c?.added).toEqual(["++ also not"]);
  });

  it("strips CR from CRLF content lines", () => {
    const diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\r\n+new\r\n";
    const [c] = parseUnifiedDiff(diff);
    expect(c?.removed[0]?.text).toBe("old");
    expect(c?.added).toEqual(["new"]);
  });

  it("skips binary and deleted files", () => {
    const diff = [
      "diff --git a/img.png b/img.png",
      "index 1..2 100644",
      "Binary files a/img.png and b/img.png differ",
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "",
    ].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual([]);
  });

  it("unquotes paths git quotes", () => {
    expect(unquotePath('"caf\\303\\251 \\"x\\".ts"')).toBe('café "x".ts');
    expect(unquotePath("b/with space.ts\t")).toBe("b/with space.ts");
  });
});

describe("gitDiffChanges on real repos", () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it("reads uncommitted changes against HEAD with pre-image line numbers", () => {
    repo = makeRepo();
    repo.write("a.txt", "one\ntwo\nthree\nfour\nfive\n");
    const head = repo.commit("initial");
    repo.write("a.txt", "zero\none\nthree\nfour\nFIVE\n");
    const { preImage, changes } = gitDiffChanges(repo.dir, {});
    expect(preImage).toBe(head);
    expect(changes).toEqual([
      {
        relPath: "a.txt",
        removed: [
          { line: 2, text: "two" },
          { line: 5, text: "five" },
        ],
        added: ["zero", "FIVE"],
        isNewFile: false,
      },
    ]);
  });

  it("reads only staged changes with staged: true", () => {
    repo = makeRepo();
    repo.write("a.txt", "one\ntwo\n");
    repo.write("b.txt", "bee\n");
    repo.commit("initial");
    repo.write("a.txt", "one\n");
    repo.git("add", "a.txt");
    repo.write("b.txt", "wasp\n"); // unstaged
    const changes = changesFromGitDiff(repo.dir, { staged: true });
    expect(changes.map((c) => c.relPath)).toEqual(["a.txt"]);
    expect(changes[0]?.removed).toEqual([{ line: 2, text: "two" }]);
  });

  it("marks new files and follows renames", () => {
    repo = makeRepo();
    repo.write("old/name.ts", "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\n");
    repo.commit("initial");
    repo.mv("old/name.ts", "new/name.ts");
    repo.write("new/name.ts", "const a = 1;\nconst b = 2;\nconst c = 33;\nconst d = 4;\nconst e = 5;\n");
    repo.write("fresh.ts", "hello\n");
    repo.git("add", "-A");
    const changes = changesFromGitDiff(repo.dir, { staged: true });
    const renamed = changes.find((c) => c.relPath === "new/name.ts") as (typeof changes)[number] & { oldPath?: string };
    expect(renamed).toBeDefined();
    expect(renamed.oldPath).toBe("old/name.ts");
    expect(renamed.isNewFile).toBe(false);
    expect(renamed.removed).toEqual([{ line: 3, text: "const c = 3;" }]);
    expect(renamed.added).toEqual(["const c = 33;"]);
    const fresh = changes.find((c) => c.relPath === "fresh.ts");
    expect(fresh).toEqual({ relPath: "fresh.ts", removed: [], added: ["hello"], isNewFile: true });
  });

  it("diffs from the merge base with base", () => {
    repo = makeRepo();
    repo.write("a.txt", "one\ntwo\n");
    repo.commit("initial");
    repo.git("checkout", "-q", "-b", "feature");
    repo.write("a.txt", "one\n");
    repo.commit("drop two");
    repo.git("checkout", "-q", "main");
    repo.write("other.txt", "main moved on\n");
    repo.commit("main work");
    repo.git("checkout", "-q", "feature");
    const { changes } = gitDiffChanges(repo.dir, { base: "main" });
    expect(changes).toEqual([{ relPath: "a.txt", removed: [{ line: 2, text: "two" }], added: [], isNewFile: false }]);
  });

  it("throws on an unknown base", () => {
    repo = makeRepo();
    repo.write("a.txt", "x\n");
    repo.commit("initial");
    expect(() => gitDiffChanges(repo!.dir, { base: "nope" })).toThrow(/unknown revision/);
  });

  it("handles a repo with no commits", () => {
    repo = makeRepo();
    repo.write("a.txt", "x\n");
    repo.git("add", "a.txt");
    const changes = changesFromGitDiff(repo.dir, { staged: true });
    expect(changes).toEqual([{ relPath: "a.txt", removed: [], added: ["x"], isNewFile: true }]);
  });

  it("handles paths with spaces", () => {
    repo = makeRepo();
    repo.write("dir with space/my file.ts", "a\nb\n");
    repo.commit("initial");
    repo.write("dir with space/my file.ts", "a\n");
    const changes = changesFromGitDiff(repo.dir, {});
    expect(changes[0]?.relPath).toBe("dir with space/my file.ts");
  });
});

describe("blameAt", () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it("blames a revision, not the working tree", () => {
    repo = makeRepo();
    repo.write("a.txt", "one\n");
    const first = repo.commit("initial");
    repo.write("a.txt", "one\ntwo\n");
    const second = repo.commit("fix: add two");
    repo.write("a.txt", "one\n"); // two is gone from the working tree
    expect(blameAt(repo.dir, "a.txt", 2, 2)).toEqual([]);
    const [line] = blameAt(repo.dir, "a.txt", 2, 2, second);
    expect(line).toMatchObject({ line: 2, sha: second, origLine: 2, origPath: "a.txt", author: "Test User", summary: "fix: add two" });
    expect(blameAt(repo.dir, "a.txt", 1, 1, second)[0]?.sha).toBe(first);
  });

  it("parses repeated commits in porcelain output", () => {
    const sha = "a".repeat(40);
    const out = [
      `${sha} 1 1 2`,
      "author A",
      "author-time 1700000000",
      "author-tz +0000",
      "summary s",
      "filename f.ts",
      "\tline one",
      `${sha} 2 2`,
      "filename f.ts",
      "\tline two",
      "",
    ].join("\n");
    const lines = parseBlamePorcelain(out, "f.ts");
    expect(lines.map((l) => [l.line, l.author, l.summary])).toEqual([
      [1, "A", "s"],
      [2, "A", "s"],
    ]);
    expect(lines[0]?.date).toBe("2023-11-14T22:13:20+00:00");
  });
});
