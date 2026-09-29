import { afterEach, describe, expect, it } from "vitest";
import { existsSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, type TestRepo } from "./helpers/repo.js";
import { buildIndex, isIndexFresh, parsePatches, sinceArg } from "../src/index-builder.js";
import { indexDir, loadIndex, recordsForFile, saveIndex } from "../src/index-store.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { hashLine, normalizeLine } from "../src/normalize.js";
import type { ChestertonConfig } from "../src/types.js";

const cfg: ChestertonConfig = { ...DEFAULT_CONFIG, history: "all" };
const repos: TestRepo[] = [];
function repo(): TestRepo {
  const r = makeRepo();
  repos.push(r);
  return r;
}
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

const h = (s: string) => hashLine(normalizeLine(s));

describe("buildIndex", () => {
  it("captures added and removed lines of a fix commit with line numbers", () => {
    const r = repo();
    r.write("src/net.ts", ["function close(sock) {", "  sock.end();", "  sock.destroy();", "}", ""].join("\n"));
    r.commit("initial socket code");
    r.write(
      "src/net.ts",
      ["function close(sock) {", "  sock.end();", "  await sleep(50); // wait for socket flush", "  sock.destroy();", "}", ""].join("\n"),
    );
    r.write("src/other.ts", "export const retries = computeRetries(config);\nlegacyRetryPath(config);\n");
    const fix1 = r.commit("fix: race on socket close (#412)");
    r.write("src/other.ts", "export const retries = computeRetries(config);\n");
    const fix2 = r.commit("fix: drop legacy retry path");

    const idx = buildIndex(r.dir, cfg);
    expect(Object.keys(idx.commits).sort()).toEqual([fix1, fix2].sort());
    expect(idx.commits[fix1]!.refs).toEqual(["#412"]);

    const net = recordsForFile(idx, "src/net.ts");
    expect(net).toHaveLength(1);
    expect(net[0]!.sha).toBe(fix1);
    expect(net[0]!.added).toEqual([{ hash: h("  await sleep(50); // wait for socket flush"), text: "await sleep(50); // wait for socket flush", line: 3 }]);
    expect(net[0]!.removed).toEqual([]);

    const other = recordsForFile(idx, "src/other.ts");
    const f2 = other.find((x) => x.sha === fix2)!;
    expect(f2.removed).toEqual([{ hash: h("legacyRetryPath(config);"), text: "legacyRetryPath(config);", line: 2 }]);
    expect(f2.added).toEqual([]);
    // fix1 created other.ts, so it added both lines.
    const f1 = other.find((x) => x.sha === fix1)!;
    expect(f1.added.map((e) => e.line)).toEqual([1, 2]);
  });

  it("excludes non-fix commits and trivial lines", () => {
    const r = repo();
    r.write("a.js", "const a = 1;\n");
    r.commit("initial");
    r.write("a.js", "const a = 1;\nfunction feature() {\n  return computeFeature();\n}\n");
    const feat = r.commit("Add feature");
    r.write("a.js", "const a = 1;\nfunction feature() {\n  if (!ready) {\n    return null;\n  }\n  return computeFeature();\n}\n");
    const fix = r.commit("fix crash when not ready");

    const idx = buildIndex(r.dir, cfg);
    expect(idx.commits[feat]).toBeUndefined();
    const recs = recordsForFile(idx, "a.js");
    expect(recs).toHaveLength(1);
    expect(recs[0]!.sha).toBe(fix);
    // "}" is trivial and dropped; the meaningful lines stay.
    expect(recs[0]!.added.map((e) => e.text)).toEqual(["if (!ready) {", "return null;"]);
    expect(recs[0]!.added.map((e) => e.line)).toEqual([3, 4]);
  });

  it("drops lines that were only moved within the file", () => {
    const r = repo();
    r.write("m.py", "def a():\n    return compute_alpha()\n\ndef b():\n    return compute_beta()\n");
    r.commit("initial");
    r.write("m.py", "def b():\n    return compute_beta()\n\ndef a():\n    return compute_alpha()\n");
    const fix = r.commit("fix: reorder to avoid import race");
    const idx = buildIndex(r.dir, cfg);
    expect(idx.commits[fix]).toBeDefined();
    expect(recordsForFile(idx, "m.py")).toEqual([]);
  });

  it("follows renames forward to the current path", () => {
    const r = repo();
    r.write("old/name.ts", "export function go() {\n  return 1;\n}\n");
    r.commit("initial");
    r.write("old/name.ts", "export function go() {\n  guardAgainstNull(input);\n  return 1;\n}\n");
    const fix = r.commit("fix: null pointer in go");
    r.mv("old/name.ts", "new/place.ts");
    r.commit("Move module");
    r.mv("new/place.ts", "final/spot.ts");
    r.commit("Move module again");

    const idx = buildIndex(r.dir, cfg);
    expect(idx.files["old/name.ts"]).toBeUndefined();
    const recs = recordsForFile(idx, "final/spot.ts");
    expect(recs).toHaveLength(1);
    expect(recs[0]!.sha).toBe(fix);
    expect(recs[0]!.path).toBe("old/name.ts");
    expect(recs[0]!.added[0]!.text).toBe("guardAgainstNull(input);");
  });

  it("sets oldPath when the fix itself renames the file", () => {
    const r = repo();
    r.write("src/a.ts", "line one of the file\nline two of the file\nline three of the file\nline four here\n");
    r.commit("initial");
    r.mv("src/a.ts", "src/b.ts");
    r.write("src/b.ts", "line one of the file\nline two of the file\nline three of the file\nline four here\nguardAgainstNull(input);\n");
    const fix = r.commit("fix: crash after rename");
    const idx = buildIndex(r.dir, cfg);
    const recs = recordsForFile(idx, "src/b.ts");
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ sha: fix, path: "src/b.ts", oldPath: "src/a.ts" });
    expect(recs[0]!.added).toEqual([{ hash: h("guardAgainstNull(input);"), text: "guardAgainstNull(input);", line: 5 }]);
  });

  it("drops records for deleted files", () => {
    const r = repo();
    r.write("gone.ts", "start\n");
    r.commit("initial");
    r.write("gone.ts", "start\nprotectAgainstLeak(handle);\n");
    r.commit("fix: leak");
    r.rm("gone.ts");
    r.commit("Remove module");
    const idx = buildIndex(r.dir, cfg);
    expect(idx.files["gone.ts"]).toBeUndefined();
  });

  it("builds incrementally after new commits", () => {
    const r = repo();
    r.write("a.ts", "export const value = compute();\n");
    r.commit("initial");
    r.write("a.ts", "export const value = compute();\nvalidateValue(value);\n");
    const fix1 = r.commit("fix: validate value");
    const first = buildIndex(r.dir, cfg);
    expect(first.head).toBe(fix1);
    expect(isIndexFresh(r.dir, first)).toBe(true);
    // Plant a marker in the saved index: only an incremental build carries it forward.
    const marker = "f".repeat(40);
    saveIndex(r.dir, { ...first, commits: { ...first.commits, [marker]: { ...first.commits[fix1]!, sha: marker } } });

    r.write("a.ts", "export const value = compute();\nvalidateValue(value);\nclampValue(value);\n");
    const fix2 = r.commit("fix: clamp value overflow crash");
    r.mv("a.ts", "lib/a.ts");
    const head = r.commit("Move a.ts");
    expect(isIndexFresh(r.dir, first)).toBe(false);

    const second = buildIndex(r.dir, cfg);
    expect(second.head).toBe(head);
    expect(Object.keys(second.commits).sort()).toEqual([fix1, fix2, "f".repeat(40)].sort());
    expect(second.files["a.ts"]).toBeUndefined();
    const recs = recordsForFile(second, "lib/a.ts");
    expect(recs.map((x) => x.sha).sort()).toEqual([fix1, fix2].sort());
    // Carried-over records keep their original content.
    expect(recs.find((x) => x.sha === fix1)!.added[0]!.text).toBe("validateValue(value);");
    expect(loadIndex(r.dir)!.head).toBe(head);
    // Same HEAD: returns the saved index untouched.
    expect(buildIndex(r.dir, cfg).builtAt).toBe(second.builtAt);
  });

  it("does a full rebuild when the saved head is not an ancestor (history rewrite)", () => {
    const r = repo();
    r.write("a.ts", "export const value = compute();\n");
    const base = r.commit("initial");
    r.write("a.ts", "export const value = compute();\nvalidateValue(value);\n");
    const fix1 = r.commit("fix: validate value");
    expect(Object.keys(buildIndex(r.dir, cfg).commits)).toEqual([fix1]);

    r.git("reset", "-q", "--hard", base);
    r.write("a.ts", "export const value = compute();\nsanitizeValue(value);\n");
    const fix2 = r.commit("fix: sanitize value");
    const idx = buildIndex(r.dir, cfg);
    expect(Object.keys(idx.commits)).toEqual([fix2]);
    expect(recordsForFile(idx, "a.ts").map((x) => x.sha)).toEqual([fix2]);
  });

  it("returns an empty index for a repo with no commits", () => {
    const r = repo();
    const idx = buildIndex(r.dir, cfg);
    expect(idx.commits).toEqual({});
    expect(idx.files).toEqual({});
    expect(isIndexFresh(r.dir, idx)).toBe(false);
  });

  it("handles CRLF content", () => {
    const r = repo();
    r.write("w.cs", "class A {\r\n    void Run() {\r\n    }\r\n}\r\n");
    r.commit("initial");
    r.write("w.cs", "class A {\r\n    void Run() {\r\n        EnsureConnectionOpen();\r\n    }\r\n}\r\n");
    r.commit("fix: deadlock on run");
    const idx = buildIndex(r.dir, cfg);
    const recs = recordsForFile(idx, "w.cs");
    expect(recs[0]!.added).toEqual([{ hash: h("EnsureConnectionOpen();"), text: "EnsureConnectionOpen();", line: 3 }]);
  });

  it("handles paths with spaces", () => {
    const r = repo();
    r.write("my dir/some file.ts", "export const a = 1;\n");
    r.commit("initial");
    r.write("my dir/some file.ts", "export const a = 1;\nensureNotNegative(a);\n");
    const fix = r.commit("fix: negative a");
    r.mv("my dir/some file.ts", "my dir/renamed file.ts");
    r.commit("rename");
    const idx = buildIndex(r.dir, cfg);
    const recs = recordsForFile(idx, "my dir/renamed file.ts");
    expect(recs).toHaveLength(1);
    expect(recs[0]!.sha).toBe(fix);
    expect(recs[0]!.path).toBe("my dir/some file.ts");
  });

  it("skips lockfiles and binary files", () => {
    const r = repo();
    r.write("package-lock.json", '{\n  "a": "1.0.0"\n}\n');
    r.write("img.bin", "\u0000\u0001\u0002");
    r.write("src/x.ts", "export const x = 1;\n");
    r.commit("initial");
    r.write("package-lock.json", '{\n  "a": "1.0.1"\n}\n');
    r.write("img.bin", "\u0000\u0001\u0003");
    r.write("src/x.ts", "export const x = 1;\nassertPositive(x);\n");
    r.commit("fix: crash with bad x");
    const idx = buildIndex(r.dir, cfg);
    expect(Object.keys(idx.files)).toEqual(["src/x.ts"]);
  });

  it("respects ignoreCommits and maxCommits", () => {
    const r = repo();
    r.write("a.ts", "export const v = 1;\n");
    r.commit("initial");
    r.write("a.ts", "export const v = 1;\ncheckValueOne(v);\n");
    const fix1 = r.commit("fix: one");
    r.write("a.ts", "export const v = 1;\ncheckValueOne(v);\ncheckValueTwo(v);\n");
    const fix2 = r.commit("fix: two");

    const ignored = buildIndex(r.dir, { ...cfg, ignoreCommits: [fix2.slice(0, 8)] }, { full: true });
    expect(Object.keys(ignored.commits)).toEqual([fix1]);

    const capped = buildIndex(r.dir, { ...cfg, maxCommits: 1 }, { full: true });
    expect(Object.keys(capped.commits)).toEqual([fix2]);
  });

  it("returns the saved index without building while another build holds the lock", () => {
    const r = repo();
    r.write("a.ts", "export const v = 1;\n");
    r.commit("initial");
    r.write("a.ts", "export const v = 1;\ncheckValueOne(v);\n");
    r.commit("fix: one");
    const lock = join(indexDir(r.dir), "index.lock");
    writeFileSync(lock, "{}");
    const idx = buildIndex(r.dir, cfg);
    expect(idx.commits).toEqual({});
    expect(loadIndex(r.dir)).toBeNull();

    // A lock older than five minutes is stale and gets taken over.
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, old, old);
    const built = buildIndex(r.dir, cfg);
    expect(Object.keys(built.commits)).toHaveLength(1);
    expect(existsSync(lock)).toBe(false);
  });
});

describe("helpers", () => {
  it("sinceArg maps history settings", () => {
    expect(sinceArg("3y")).toBe("--since=3.years.ago");
    expect(sinceArg("18m")).toBe("--since=18.months.ago");
    expect(sinceArg("90d")).toBe("--since=90.days.ago");
    expect(sinceArg("all")).toBeNull();
    expect(sinceArg("nonsense")).toBeNull();
  });

  it("parsePatches is not fooled by removed lines that look like file headers", () => {
    const out = [
      "\x1eabc",
      "",
      "diff --git a/q.sql b/q.sql",
      "index 1..2 100644",
      "--- a/q.sql",
      "+++ b/q.sql",
      "@@ -3,2 +3 @@",
      "--- a/secret comment line",
      "-select slow_query from t;",
      "+select fast_query from t;",
    ].join("\n");
    const recs = parsePatches(out).get("abc")!;
    expect(recs).toHaveLength(1);
    expect(recs[0]!.path).toBe("q.sql");
    expect(recs[0]!.removed.map((e) => [e.text, e.line])).toEqual([
      ["-- a/secret comment line", 3],
      ["select slow_query from t;", 4],
    ]);
    expect(recs[0]!.added.map((e) => [e.text, e.line])).toEqual([["select fast_query from t;", 3]]);
  });
});
