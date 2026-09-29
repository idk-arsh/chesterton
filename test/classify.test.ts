import { describe, expect, it } from "vitest";
import { classifyCommit, extractRefs, isTestFile, type CommitFileChange, type ClassifyInput } from "../src/classify.js";
import { DEFAULT_CONFIG } from "../src/config.js";

const cfg = { ...DEFAULT_CONFIG };
const f = (path: string, added = 3, removed = 1, status = "M"): CommitFileChange => ({ path, status, added, removed });
const input = (subject: string, files: CommitFileChange[] = [f("src/a.ts")], extra: Partial<ClassifyInput> = {}): ClassifyInput => ({
  sha: "abcdef1234567890abcdef1234567890abcdef12",
  subject,
  body: "",
  files,
  parents: 1,
  ...extra,
});

describe("classifyCommit", () => {
  it("scores a conventional fix: commit as a fix", () => {
    const r = classifyCommit(input("fix(net): handle closed socket"), cfg);
    expect(r.isFix).toBe(true);
    expect(r.reasons).toContain("conventional commit type 'fix:'");
    expect(r.score).toBe(3 + 1); // fix + small change
  });

  it("scores keywords and names them", () => {
    const r = classifyCommit(input("Avoid race when closing the pool"), cfg);
    expect(r.isFix).toBe(true);
    expect(r.reasons).toContain("message says 'race'");
  });

  it("finds keywords in the body too", () => {
    const r = classifyCommit(input("Tidy pool shutdown", undefined, { body: "This plugs a memory leak." }), cfg);
    expect(r.isFix).toBe(true);
    expect(r.reasons.some((x) => x.includes("'leak'"))).toBe(true);
  });

  it("does not match keywords inside other words", () => {
    const r = classifyCommit(input("Add prefix handling and debugger docs"), cfg);
    expect(r.reasons.some((x) => x.startsWith("message says"))).toBe(false);
    expect(r.isFix).toBe(false);
  });

  it("gives a test file bonus and names the file", () => {
    const r = classifyCommit(input("Handle empty retry list", [f("src/retry.py"), f("tests/test_retry.py", 10, 0, "A")]), cfg);
    expect(r.testFiles).toEqual(["tests/test_retry.py"]);
    expect(r.reasons).toContain("adds test tests/test_retry.py");
    expect(r.score).toBe(2 + 1);
    expect(r.isFix).toBe(true);
  });

  it("references add a point", () => {
    const r = classifyCommit(input("Handle empty list (#412)"), cfg);
    expect(r.refs).toEqual(["#412"]);
    expect(r.reasons).toContain("references #412");
    expect(r.score).toBe(2);
    expect(r.isFix).toBe(false);
  });

  it("penalizes merge commits", () => {
    const r = classifyCommit(input("Merge branch 'fix/crash'", undefined, { parents: 2 }), cfg);
    expect(r.reasons).toContain("merge commit");
    expect(r.isFix).toBe(false);
  });

  it("penalizes lockfile-only commits", () => {
    const r = classifyCommit(input("fix: bump lodash for CVE", [f("package-lock.json", 40, 40)]), cfg);
    expect(r.isFix).toBe(false);
    expect(r.reasons).toContain("only touches lockfiles, dependency or formatting files");
  });

  it("penalizes docs-only commits", () => {
    const r = classifyCommit(input("fix typo in README", [f("README.md", 1, 1), f("docs/guide.md", 1, 1)]), cfg);
    expect(r.isFix).toBe(false);
    expect(r.reasons).toContain("only touches docs");
  });

  it("penalizes very large commits", () => {
    const files = Array.from({ length: 50 }, (_, i) => f(`src/f${i}.ts`));
    const r = classifyCommit(input("fix: rename helper everywhere", files), cfg);
    expect(r.score).toBe(0);
    expect(r.isFix).toBe(false);
  });

  it("counts fixPatternsExtra like a keyword", () => {
    const plain = classifyCommit(input("Harden ingest path"), cfg);
    expect(plain.isFix).toBe(false);
    const r = classifyCommit(input("Harden ingest path"), { ...cfg, fixPatternsExtra: ["\\bharden\\b","(bad regex"] });
    expect(r.isFix).toBe(true);
    expect(r.reasons.some((x) => x.includes("custom pattern"))).toBe(true);
  });

  it("never marks ignoreCommits as fixes", () => {
    const r = classifyCommit(input("fix: real crash"), { ...cfg, ignoreCommits: ["abcdef12"] });
    expect(r.isFix).toBe(false);
    expect(r.reasons).toContain("listed in ignoreCommits");
  });

  it("plain feature commits are not fixes", () => {
    const r = classifyCommit(input("Add export button", [f("src/a.ts", 80, 2), f("src/b.ts", 20, 0)]), cfg);
    expect(r.isFix).toBe(false);
  });
});

describe("helpers", () => {
  it("extractRefs handles issues, tickets and URLs", () => {
    expect(extractRefs("Closes #12, see JIRA-88 and https://github.com/o/r/issues/7")).toEqual([
      "https://github.com/o/r/issues/7",
      "#12",
      "JIRA-88",
    ]);
    expect(extractRefs("Use UTF-8 and SHA-256")).toEqual([]);
  });

  it("isTestFile covers the usual layouts", () => {
    for (const p of ["test/a.ts", "src/__tests__/a.js", "spec/x.rb", "pkg/a_test.go", "a.test.ts", "b.spec.js", "test_x.py", "a/tests/b.py"]) {
      expect(isTestFile(p), p).toBe(true);
    }
    for (const p of ["src/testing.ts", "latest/a.ts", "contest.py"]) expect(isTestFile(p), p).toBe(false);
  });
});
