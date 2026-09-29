import { afterEach, describe, expect, it } from "vitest";
import { analyzeChange } from "../src/analyze.js";
import { changeFromToolCall } from "../src/edit-diff.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { hashLine, normalizeLine } from "../src/normalize.js";
import type { BlameLine, ChestertonIndex, EditChange, FixCommit, LineEntry } from "../src/types.js";
import { INDEX_VERSION } from "../src/types.js";
import { makeRepo, type TestRepo } from "./helpers/repo.js";

const cfg = { ...DEFAULT_CONFIG };
let repo: TestRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

function entry(text: string, line: number): LineEntry {
  return { hash: hashLine(normalizeLine(text)), text: text.trim(), line };
}

function fixCommit(sha: string, subject = "fix: race on socket close (#412)"): FixCommit {
  return {
    sha,
    date: "2025-03-14T10:00:00Z",
    author: "Jane Doe",
    subject,
    score: 6,
    reasons: ["message says 'race'"],
    refs: ["#412"],
    testFiles: [],
  };
}

function index(commits: FixCommit[], files: ChestertonIndex["files"]): ChestertonIndex {
  return { version: INDEX_VERSION, head: "x", builtAt: "", commits: Object.fromEntries(commits.map((c) => [c.sha, c])), files };
}

const BASE = ["function close(sock) {", "  sock.end();", "  cleanup(sock);", "}", ""].join("\n");
const GUARD1 = "  if (sock.pending > 0) await flush(sock);";
const GUARD2 = "  sock.removeAllListeners('data');";

/** Repo with a base commit and a fix commit that adds two guard lines. */
function fixRepo(): { r: TestRepo; base: string; fix: string } {
  const r = makeRepo();
  repo = r;
  r.write("src/sock.ts", BASE);
  const base = r.commit("initial");
  r.write("src/sock.ts", ["function close(sock) {", GUARD1, GUARD2, "  sock.end();", "  cleanup(sock);", "}", ""].join("\n"));
  const fix = r.commit("fix: race on socket close (#412)");
  return { r, base, fix };
}

describe("analyzeChange: removes-fix", () => {
  it("strong when a removed line was added by the fix (real blame)", () => {
    const { r, fix } = fixRepo();
    const idx = index([fixCommit(fix)], {
      "src/sock.ts": [{ sha: fix, path: "src/sock.ts", added: [entry(GUARD1, 2), entry(GUARD2, 3)], removed: [] }],
    });
    const [change] = changeFromToolCall(r.dir, "Edit", { file_path: "src/sock.ts", old_string: `${GUARD1}\n`, new_string: "" });
    const f = analyzeChange(r.dir, change!, idx, cfg);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: "removes-fix", strength: "strong", file: "src/sock.ts" });
    expect(f[0]!.fix.sha).toBe(fix);
    expect(f[0]!.lines).toEqual([GUARD1.trim()]);
  });

  it("weak when blame points at the fix but the hash is not in its added lines (when blame runs)", () => {
    const { r, fix } = fixRepo();
    const idx = index([fixCommit(fix)], {
      "src/sock.ts": [{ sha: fix, path: "src/sock.ts", added: [entry("something else entirely here", 9)], removed: [] }],
    });
    const [change] = changeFromToolCall(r.dir, "Edit", { file_path: "src/sock.ts", old_string: `${GUARD2}\n`, new_string: "" });
    const f = analyzeChange(r.dir, change!, idx, cfg, { alwaysBlame: true });
    expect(f.map((x) => [x.kind, x.strength])).toEqual([["removes-fix", "weak"]]);
  });

  it("weak when a removed line sits next to a line the fix added (when blame runs)", () => {
    const { r, fix } = fixRepo();
    const idx = index([fixCommit(fix)], {
      "src/sock.ts": [{ sha: fix, path: "src/sock.ts", added: [entry(GUARD1, 2), entry(GUARD2, 3)], removed: [] }],
    });
    // "sock.end();" came from the base commit, but it is right under the fix's lines.
    const [change] = changeFromToolCall(r.dir, "Edit", { file_path: "src/sock.ts", old_string: "  sock.end();\n", new_string: "" });
    const f = analyzeChange(r.dir, change!, idx, cfg, { alwaysBlame: true });
    expect(f.map((x) => [x.kind, x.strength])).toEqual([["removes-fix", "weak"]]);
  });

  it("does not blame at all when no removed line matches a line a fix added to the file", () => {
    const sha = "c".repeat(40);
    let calls = 0;
    const blame = (_r: string, _p: string, s: number, e: number): BlameLine[] => {
      calls++;
      return Array.from({ length: e - s + 1 }, (_, i) => ({ line: s + i, sha, origLine: s + i, origPath: "a.ts" }));
    };
    const text = ["x", "validateToken(token, now)", "unrelatedCall(someArgument)", "x"];
    const idx = index([fixCommit(sha)], { "a.ts": [{ sha, path: "a.ts", added: [entry(text[1]!, 2)], removed: [] }] });
    const change: EditChange = { relPath: "a.ts", removed: [{ line: 3, text: text[2]! }], added: [], isNewFile: false };
    // Next to a fix line, so a blame would give a weak hit; the skip gives that up for speed.
    expect(analyzeChange("/nowhere", change, idx, cfg, { blame, currentContent: text.join("\n") })).toEqual([]);
    expect(calls).toBe(0);
    // A file with no fix records at all is never blamed either.
    const none: EditChange = { ...change, relPath: "b.ts" };
    expect(analyzeChange("/nowhere", none, idx, cfg, { blame, currentContent: text.join("\n") })).toEqual([]);
    expect(calls).toBe(0);
    // Once one removed line matches, blame runs and the strong hit is found.
    const hit: EditChange = { ...change, removed: [{ line: 2, text: text[1]! }, { line: 3, text: text[2]! }] };
    const f = analyzeChange("/nowhere", hit, idx, cfg, { blame, currentContent: text.join("\n") });
    expect(calls).toBe(1);
    expect(f.map((x) => [x.kind, x.strength])).toEqual([["removes-fix", "strong"]]);
  });

  it("alwaysBlame blames even when nothing could match", () => {
    let calls = 0;
    const blame = (): BlameLine[] => {
      calls++;
      return [];
    };
    const change: EditChange = { relPath: "a.ts", removed: [{ line: 1, text: "doSomethingImportant()" }], added: [], isNewFile: false };
    analyzeChange("/nowhere", change, index([], {}), cfg, { blame, alwaysBlame: true, currentContent: "doSomethingImportant()\n" });
    expect(calls).toBe(1);
  });

  it("nothing when the blamed commit is not a fix", () => {
    const { r, fix } = fixRepo();
    const idx = index([], {});
    void fix;
    const [change] = changeFromToolCall(r.dir, "Edit", { file_path: "src/sock.ts", old_string: `${GUARD1}\n`, new_string: "" });
    expect(analyzeChange(r.dir, change!, idx, cfg)).toEqual([]);
  });

  it("ignores trivial removed lines and does not blame them", () => {
    const calls: number[][] = [];
    const blame = (_r: string, _p: string, s: number, e: number): BlameLine[] => {
      calls.push([s, e]);
      return [];
    };
    const change: EditChange = { relPath: "a.ts", removed: [{ line: 4, text: "  }" }, { line: 5, text: "" }], added: [], isNewFile: false };
    expect(analyzeChange("/nowhere", change, index([], {}), cfg, { blame, currentContent: "" })).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("groups removed lines into one blame call per window and honors ignoreCommits", () => {
    const sha = "a".repeat(40);
    const calls: number[][] = [];
    const blame = (_r: string, _p: string, s: number, e: number): BlameLine[] => {
      calls.push([s, e]);
      const out: BlameLine[] = [];
      for (let l = s; l <= e; l++) out.push({ line: l, sha, origLine: l, origPath: "a.ts" });
      return out;
    };
    const text = ["x", "x", "x", "x", "return retryWithBackoff(req)", "validateToken(token, now)", "x", "x", "x", "x"];
    const idx = index([fixCommit(sha)], {
      "a.ts": [{ sha, path: "a.ts", added: [entry(text[4]!, 5), entry(text[5]!, 6)], removed: [] }],
    });
    const change: EditChange = {
      relPath: "a.ts",
      removed: [
        { line: 5, text: text[4]! },
        { line: 6, text: text[5]! },
      ],
      added: [],
      isNewFile: false,
    };
    const f = analyzeChange("/nowhere", change, idx, cfg, { blame, currentContent: text.join("\n") });
    expect(calls).toEqual([[2, 9]]);
    expect(f).toHaveLength(1);
    expect(f[0]!.strength).toBe("strong");
    expect(f[0]!.lines).toHaveLength(2);
    expect(analyzeChange("/nowhere", change, idx, { ...cfg, ignoreCommits: ["aaaa"] }, { blame, currentContent: text.join("\n") })).toEqual([]);
  });

  it("skips uncommitted lines", () => {
    const blame = (_r: string, _p: string, s: number, e: number): BlameLine[] =>
      Array.from({ length: e - s + 1 }, (_, i) => ({ line: s + i, sha: "0".repeat(40), origLine: s + i, origPath: "a.ts" }));
    const change: EditChange = { relPath: "a.ts", removed: [{ line: 1, text: "doSomethingImportant()" }], added: [], isNewFile: false };
    expect(analyzeChange("/nowhere", change, index([], {}), cfg, { blame, currentContent: "doSomethingImportant()\n" })).toEqual([]);
  });
});

describe("analyzeChange: re-adds-removed", () => {
  const sha = "b".repeat(40);
  const OLD1 = "setTimeout(retry, 0); // spin until ready";
  const OLD2 = "state.ready = true;";
  const noBlame = () => [] as BlameLine[];
  const idx = index([fixCommit(sha, "fix: busy loop on reconnect")], {
    "src/net.ts": [{ sha, path: "src/net.ts", added: [entry("await waitForReady(state);", 10)], removed: [entry(OLD1, 10), entry(OLD2, 11)] }],
  });
  const add = (added: string[]): EditChange[] => [{ relPath: "src/net.ts", removed: [], added, isNewFile: false }];

  it("strong for 2+ consecutive lines the fix removed, in order", () => {
    const [c] = add(["  " + OLD1, "    " + OLD2]);
    const f = analyzeChange("/nowhere", c!, idx, cfg, { blame: noBlame, currentContent: "function x() {\n}\n" });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: "re-adds-removed", strength: "strong" });
    expect(f[0]!.lines).toEqual([OLD1, OLD2]);
  });

  it("trivial lines between them do not break the run", () => {
    const [c] = add([OLD1, "", "  }", OLD2]);
    const f = analyzeChange("/nowhere", c!, idx, cfg, { blame: noBlame, currentContent: "" });
    expect(f[0]?.strength).toBe("strong");
  });

  it("out of order lines are only weak", () => {
    const [c] = add([OLD2, OLD1]);
    const f = analyzeChange("/nowhere", c!, idx, cfg, { blame: noBlame, currentContent: "" });
    expect(f).toHaveLength(1);
    expect(f[0]!.strength).toBe("weak");
    // Only the long line qualifies for a single weak match.
    expect(f[0]!.lines).toEqual([OLD1]);
  });

  it("weak for a single long line, nothing for a single short one", () => {
    const [c] = add([OLD1]);
    expect(analyzeChange("/nowhere", c!, idx, cfg, { blame: noBlame, currentContent: "" })[0]?.strength).toBe("weak");
    const [d] = add([OLD2]);
    expect(analyzeChange("/nowhere", d!, idx, cfg, { blame: noBlame, currentContent: "" })).toEqual([]);
  });

  it("does not flag lines the file already contains (code being moved)", () => {
    const [c] = add([OLD1, OLD2]);
    const current = `function x() {\n  ${OLD1}\n  ${OLD2}\n}\n`;
    expect(analyzeChange("/nowhere", c!, idx, cfg, { blame: noBlame, currentContent: current })).toEqual([]);
  });

  it("pure move fixes contribute nothing", () => {
    const moved = index([fixCommit(sha)], {
      "src/net.ts": [{ sha, path: "src/net.ts", added: [entry(OLD1, 1), entry(OLD2, 2)], removed: [entry(OLD1, 20), entry(OLD2, 21)] }],
    });
    const [c] = add([OLD1, OLD2]);
    expect(analyzeChange("/nowhere", c!, moved, cfg, { blame: noBlame, currentContent: "" })).toEqual([]);
  });

  it("dedupes per fix and caps lines at 8", () => {
    const many = Array.from({ length: 12 }, (_, i) => `const value${i} = computeSomething(${i});`);
    const big = index([fixCommit(sha)], {
      "src/net.ts": [{ sha, path: "src/net.ts", added: [], removed: many.map((t, i) => entry(t, i + 1)) }],
    });
    const f = analyzeChange("/nowhere", { relPath: "src/net.ts", removed: [], added: [...many.slice(0, 6), "zzz other", ...many.slice(6)], isNewFile: false }, big, cfg, {
      blame: noBlame,
      currentContent: "",
    });
    expect(f).toHaveLength(1);
    expect(f[0]!.lines).toHaveLength(8);
  });
});

describe("analyzeChange with the real index builder", () => {
  it("finds the fix end to end", async () => {
    const { buildIndex } = await import("../src/index-builder.js");
    const { r, fix } = fixRepo();
    const idx = buildIndex(r.dir, cfg, { full: true });
    expect(idx.commits[fix]).toBeTruthy();
    const [change] = changeFromToolCall(r.dir, "Edit", { file_path: "src/sock.ts", old_string: `${GUARD1}\n${GUARD2}\n`, new_string: "" });
    const f = analyzeChange(r.dir, change!, idx, cfg);
    expect(f[0]).toMatchObject({ kind: "removes-fix", strength: "strong" });

    // Revert the fix and try to re-add the removed original: build a second fix that removes lines.
    r.write("src/sock.ts", ["function close(sock) {", GUARD1, GUARD2, "  sock.end();", "}", ""].join("\n"));
    const fix2 = r.commit("fix: double cleanup crash (#500)");
    const idx2 = buildIndex(r.dir, cfg, { full: true });
    expect(idx2.commits[fix2]).toBeTruthy();
    const [c2] = changeFromToolCall(r.dir, "Edit", { file_path: "src/sock.ts", old_string: "  sock.end();\n", new_string: "  sock.end();\n  cleanup(sock);\n" });
    const f2 = analyzeChange(r.dir, c2!, idx2, cfg);
    // One re-added line, short, so it does not count. Nothing flagged.
    expect(f2.filter((x) => x.kind === "re-adds-removed" && x.strength === "strong")).toEqual([]);
  });
});

describe("analyzeChange: noise filters", () => {
  const sha = "c".repeat(40);
  const LINE_A = "return retryWithBackoff(req)";
  const LINE_B = "validateToken(token, now)";
  const blameAll = (_r: string, p: string, s: number, e: number): BlameLine[] =>
    Array.from({ length: e - s + 1 }, (_, i) => ({ line: s + i, sha, origLine: s + i, origPath: p }));
  const idxFor = (path: string) =>
    index([fixCommit(sha)], { [path]: [{ sha, path, added: [entry(LINE_A, 1), entry(LINE_B, 2)], removed: [entry("oldCall(a, b, c, d)", 1)] }] });
  const removal = (relPath: string): EditChange => ({
    relPath,
    removed: [
      { line: 1, text: LINE_A },
      { line: 2, text: LINE_B },
    ],
    added: [],
    isNewFile: false,
  });

  it("never checks docs, changelogs, CI config or lockfiles", () => {
    for (const p of ["README.md", "History.md", "docs/api.rst", ".github/workflows/ci.yml", ".travis.yml", "package-lock.json"]) {
      expect(analyzeChange("/nowhere", removal(p), idxFor(p), cfg, { blame: blameAll, currentContent: `${LINE_A}\n${LINE_B}\n` }), p).toEqual([]);
    }
    const code = analyzeChange("/nowhere", removal("src/a.ts"), idxFor("src/a.ts"), cfg, { blame: blameAll, currentContent: `${LINE_A}\n${LINE_B}\n` });
    expect(code.map((f) => f.strength)).toEqual(["strong"]);
  });

  it("caps removals in test files at weak", () => {
    const p = "tests/test_retry.py";
    const f = analyzeChange("/nowhere", removal(p), idxFor(p), cfg, { blame: blameAll, currentContent: `${LINE_A}\n${LINE_B}\n` });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: "removes-fix", strength: "weak" });
  });

  it("re-adding removed lines in a test file can still be strong", () => {
    const p = "test/net.test.ts";
    const OLD1 = "setTimeout(retry, 0); // spin until ready";
    const OLD2 = "state.ready = true;";
    const idx = index([fixCommit(sha)], { [p]: [{ sha, path: p, added: [], removed: [entry(OLD1, 1), entry(OLD2, 2)] }] });
    const f = analyzeChange("/nowhere", { relPath: p, removed: [], added: [OLD1, OLD2], isNewFile: false }, idx, cfg, { blame: () => [], currentContent: "" });
    expect(f.map((x) => [x.kind, x.strength])).toEqual([["re-adds-removed", "strong"]]);
  });

  it("produces nothing for a whitespace-only reflow", () => {
    const change: EditChange = {
      relPath: "src/a.ts",
      removed: [
        { line: 1, text: LINE_A },
        { line: 2, text: LINE_B },
      ],
      added: ["return retryWithBackoff(", "  req", ")", "  validateToken(token,   now)"],
      isNewFile: false,
    };
    expect(analyzeChange("/nowhere", change, idxFor("src/a.ts"), cfg, { blame: blameAll, currentContent: `${LINE_A}\n${LINE_B}\n` })).toEqual([]);
    // Drop one of the lines for real and it counts again.
    const real: EditChange = { ...change, added: ["return retryWithBackoff(", "  req", ")"] };
    expect(analyzeChange("/nowhere", real, idxFor("src/a.ts"), cfg, { blame: blameAll, currentContent: `${LINE_A}\n${LINE_B}\n` })).not.toEqual([]);
  });
});
