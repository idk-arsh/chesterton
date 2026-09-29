import { describe, expect, it } from "vitest";
import { classifyCommit, extractRefs, isNoiseFile, isTestFile, type CommitFileChange, type ClassifyInput } from "../src/classify.js";
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

  it("gives a test file bonus and names the file, but tests alone do not make a fix", () => {
    const r = classifyCommit(input("Handle empty retry list", [f("src/retry.py"), f("tests/test_retry.py", 10, 0, "A")]), cfg);
    expect(r.testFiles).toEqual(["tests/test_retry.py"]);
    expect(r.reasons).toContain("adds test tests/test_retry.py");
    expect(r.score).toBe(2 + 1);
    expect(r.isFix).toBe(false);
    expect(r.reasons).toContain("no fix wording in the message");
    const withWord = classifyCommit(input("Fix empty retry list", [f("src/retry.py"), f("tests/test_retry.py", 10, 0, "A")]), cfg);
    expect(withWord.isFix).toBe(true);
    expect(withWord.score).toBe(3 + 2 + 1);
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
    expect(r.reasons).toContain("only touches lockfiles, dependency, CI or formatting files");
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

describe("classifyCommit: fix signal required", () => {
  it("refs plus tests plus a small change is not a fix without fix wording", () => {
    // psf/requests 561e4b688
    const r = classifyCommit(input("Add inline types to Requests (#7272)", [f("src/requests/sessions.py", 20, 10), f("tests/test_requests.py", 5, 1)]), cfg);
    expect(r.isFix).toBe(false);
    expect(r.score).toBeGreaterThanOrEqual(3);
    expect(r.refs).toEqual(["#7272"]);
  });

  it("keeps real fixes with fix wording", () => {
    for (const s of ["Fix compatibility with pytest 8", "Avoid a deadlock in pool shutdown", "fix(router): handle empty path"]) {
      expect(classifyCommit(input(s), cfg).isFix, s).toBe(true);
    }
  });
});

describe("classifyCommit: housekeeping and feature subjects", () => {
  it("demotes housekeeping conventional scopes even though they say fix", () => {
    for (const s of [
      "fix(deps): update rust crate regex to 1.10",
      "fix(devdeps): bump eslint",
      "fix(dev-deps): pin mocha",
      "fix(ci): cache cargo registry",
      "fix(build): drop old target",
      "fix(refactor): split module",
      "fix(docs): broken link",
      "fix(lint): unused import",
      "fix(style): quotes",
      "fix(typo): recieve",
      "fix(test): flaky timer",
      "fix(tests): flaky timer",
    ]) {
      const r = classifyCommit(input(s), cfg);
      expect(r.isFix, s).toBe(false);
      expect(r.reasons.some((x) => x.startsWith("not a fix:")), s).toBe(true);
    }
  });

  it("demotes dependency and chore commits", () => {
    for (const s of ["build(deps): bump the npm group", "deps: update qs to fix a warning", "chore: fix typo", "chore(release): fix version"]) {
      expect(classifyCommit(input(s), cfg).isFix, s).toBe(false);
    }
  });

  it("keeps chore commits that name a crash, race, leak, regression or CVE", () => {
    expect(classifyCommit(input("chore: fix crash on empty config"), cfg).isFix).toBe(true);
    expect(classifyCommit(input("chore: patch CVE-2024-1234"), cfg).isFix).toBe(true);
  });

  it("demotes bump, dependency update, typo, spelling, lint, formatting and whitespace subjects", () => {
    for (const s of [
      "Bump urllib3 to fix warning",
      "Update dependencies to fix audit",
      "Upgrade dev dependencies (fixes CI)",
      "Fix typos in comments",
      "fix spelling",
      "Run codespell and fix findings",
      "Fix lint errors",
      "Fix clippy warnings",
      "Fix formatting",
      "reformat with black, fixes style",
      "format: fix indentation",
      "Fix whitespace",
    ]) {
      expect(classifyCommit(input(s), cfg).isFix, s).toBe(false);
    }
  });

  it("does not demote a real fix that merely mentions a format", () => {
    expect(classifyCommit(input("Fix date format in cookie expiry"), cfg).isFix).toBe(true);
  });

  it("feature verbs are not fixes unless the subject itself has fix wording", () => {
    // BurntSushi/ripgrep: the body closes an issue, but the subject is a feature.
    const r = classifyCommit(input("cli: add --stop-on-nonmatch flag", [f("crates/core/flags.rs", 30, 2)], { body: "Fixes #1930" }), cfg);
    expect(r.isFix).toBe(false);
    expect(r.reasons).toContain("not a fix: subject describes a feature");
    for (const s of ["Add retry option", "adds a flag", "Added --json", "Support HTTP/2", "Implement streaming", "Allow empty paths", "Introduce cache", "feat: new router", "feature: dark mode", "New config loader"]) {
      expect(classifyCommit(input(s, undefined, { body: "fixes #1" }), cfg).isFix, s).toBe(false);
    }
    // "Fixes #12" in the subject is a closer, not fix wording.
    expect(classifyCommit(input("Add retry option, fixes #12"), cfg).isFix).toBe(false);
    // Real fix wording in the subject rescues it.
    expect(classifyCommit(input("Add missing null check to fix crash"), cfg).isFix).toBe(true);
    expect(classifyCommit(input("fix: added a missing semicolon"), cfg).isFix).toBe(true);
  });

  it("refactor verbs are not fixes unless the subject says fix or the message names a strong bug", () => {
    for (const s of ["Refactor zsh completion function", "Rename helper", "Clean up pool", "cleanup: drop dead code", "Reorganize modules"]) {
      expect(classifyCommit(input(s, undefined, { body: "- Fix --count error" }), cfg).isFix, s).toBe(false);
    }
    expect(classifyCommit(input("Tidy pool shutdown", undefined, { body: "This plugs a memory leak." }), cfg).isFix).toBe(true);
    expect(classifyCommit(input("Refactor retry to fix double send"), cfg).isFix).toBe(true);
  });

  it("demotes housekeeping conventional types and pkg@version subjects", () => {
    for (const s of ["docs: fix link", "doc: fix wording", "style: fix new lints", "lint: fix warnings", "ci: fix cache", "test: fix flaky", "refactor: fix naming", "merge-descriptors@1.0.3 (#5781)", "update to fresh@2.0.0 (#5916)"]) {
      expect(classifyCommit(input(s, undefined, { body: "fixes handling of X" }), cfg).isFix, s).toBe(false);
    }
  });

  it("custom fix patterns in the subject also rescue a feature verb", () => {
    const c = { ...cfg, fixPatternsExtra: ["\\bharden\\b"] };
    expect(classifyCommit(input("Add harden step for ingest"), c).isFix).toBe(true);
  });
});

describe("classifyCommit: size veto", () => {
  it("a 47-file, 18k-line commit is never a fix", () => {
    const files = Array.from({ length: 47 }, (_, i) => f(`src/m${i}.py`, 300, 90));
    const r = classifyCommit(input("Fix everything (#6095)", [...files, f("tests/test_all.py", 50, 0)]), cfg);
    expect(r.isFix).toBe(false);
    expect(r.reasons.some((x) => x.startsWith("large change"))).toBe(true);
  });

  it("more than 1500 changed lines in few files is not a fix", () => {
    const r = classifyCommit(input("Fix parser", [f("src/parser.rs", 1400, 200)]), cfg);
    expect(r.isFix).toBe(false);
  });

  it("docs, CI and lockfiles do not count toward size", () => {
    const r = classifyCommit(input("Fix parser", [f("src/parser.rs", 10, 2), f("package-lock.json", 4000, 3000), f("CHANGELOG.md", 5, 0)]), cfg);
    expect(r.isFix).toBe(true);
  });
});

describe("classifyCommit: reverts", () => {
  it("a double revert is not a fix", () => {
    const r = classifyCommit(input('Revert "Revert "Fix header merge (#12)""', undefined, { body: "This reverts commit 0123456789abcdef0123456789abcdef01234567." }), cfg);
    expect(r.isFix).toBe(false);
    expect(r.reasons).toContain("not a fix: puts back a reverted change");
  });

  it("a plain revert is not a fix on the word revert or the reverted subject alone", () => {
    const r = classifyCommit(input('Revert "Fix header merge"', undefined, { body: "This reverts commit 0123456789abcdef0123456789abcdef01234567." }), cfg);
    expect(r.isFix).toBe(false);
  });

  it("a revert with its own fix wording or an issue reference is a fix", () => {
    const withRef = classifyCommit(input('Revert "Use new pool"', undefined, { body: "This reverts commit 0123456789abcdef.\n\nSee #88." }), cfg);
    expect(withRef.isFix).toBe(true);
    expect(withRef.reasons).toContain("reverts a change tied to an issue");
    const withWord = classifyCommit(input('Revert "Use new pool"', undefined, { body: "It causes a crash on shutdown." }), cfg);
    expect(withWord.isFix).toBe(true);
  });
});

describe("isNoiseFile", () => {
  it("covers docs, changelogs, CI config and lockfiles", () => {
    for (const p of [
      "README.md", "docs/index.rst", "doc/guide.html", "History.md", "HISTORY.rst", "CHANGELOG", "CHANGES.txt", "NEWS",
      "AUTHORS", "LICENSE-MIT", "notes.adoc", "a/b/c.markdown", "requirements-dev.txt", ".github/workflows/ci.yml",
      ".gitlab-ci.yml", ".travis.yml", "appveyor.yml", ".circleci/config.yml", "azure-pipelines.yml",
      ".pre-commit-config.yaml", "package-lock.json", "sub/Cargo.lock",
    ]) {
      expect(isNoiseFile(p), p).toBe(true);
    }
  });

  it("leaves code alone, including nested doc folders", () => {
    for (const p of ["src/a.ts", "crates/core/flags/doc/help.rs", "CMakeLists.txt", "lib/history.js", "setup.py", "src/docs.py"]) {
      expect(isNoiseFile(p), p).toBe(false);
    }
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
