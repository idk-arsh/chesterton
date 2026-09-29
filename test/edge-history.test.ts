// Edge cases for odd git histories.
import { afterEach, describe, expect, it, vi } from "vitest";

// Real git repos on Windows are slow; give every test room when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 60_000 });
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleHookInput } from "../src/hook.js";
import { buildIndex } from "../src/index-builder.js";
import { loadIndex } from "../src/index-store.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { makeRepo, type TestRepo } from "./helpers/repo.js";

const G1 = "  if (sock.pending > 0) await flush(sock);";
const G2 = "  sock.removeAllListeners('data');";
const BASE = ["function close(sock) {", "  sock.end();", "  cleanup(sock);", "}"];
const FIXED = ["function close(sock) {", G1, G2, "  sock.end();", "  cleanup(sock);", "}"];
const text = (lines: string[]) => lines.join("\n") + "\n";

let repo: TestRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});
function newRepo(): TestRepo {
  repo = makeRepo();
  return repo;
}

const deps = () => ({ startedAt: Date.now() + 60_000, spawnIndexer: () => {} });

function hook(r: TestRepo, tool: string, toolInput: object, sid: string): { decision: string | null; out: any } {
  const s = handleHookInput(
    JSON.stringify({ session_id: sid, cwd: r.dir, hook_event_name: "PreToolUse", tool_name: tool, tool_input: toolInput }),
    deps(),
  );
  if (s === null) return { decision: null, out: null };
  const o = JSON.parse(s).hookSpecificOutput;
  return { decision: o.permissionDecision ?? "allow", out: o };
}
const removeGuard = (r: TestRepo, path: string, sid: string) =>
  hook(r, "Edit", { file_path: join(r.dir, ...path.split("/")), old_string: `${G1}\n`, new_string: "" }, sid);

function withFix(r: TestRepo, path = "src/sock.ts", msg = "fix: race on socket close (#412)"): string {
  r.write(path, text(BASE));
  r.commit("initial");
  r.write(path, text(FIXED));
  r.write("test/sock.test.ts", "it('flushes', () => {});\n");
  return r.commit(msg);
}

describe("renames and deletes", () => {
  it("rename chain: fix, rename, edit, rename again, then edit at the newest path", () => {
    const r = newRepo();
    const fix = withFix(r, "src/a.ts");
    r.mv("src/a.ts", "src/b.ts");
    r.commit("move a to b");
    r.write("src/b.ts", text([...FIXED, "// tweak"]));
    r.commit("tweak b");
    r.mv("src/b.ts", "lib/c.ts");
    r.commit("move b to c");
    buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true });
    const res = removeGuard(r, "lib/c.ts", "rc");
    expect(res.decision).toBe("deny");
    expect(res.out.permissionDecisionReason).toContain(fix.slice(0, 7));
  });

  it("rename chain built incrementally keeps the records", () => {
    const r = newRepo();
    withFix(r, "src/a.ts");
    buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true });
    r.mv("src/a.ts", "src/b.ts");
    r.commit("move a to b");
    buildIndex(r.dir, { ...DEFAULT_CONFIG });
    r.mv("src/b.ts", "lib/c.ts");
    r.commit("move b to c");
    const idx = buildIndex(r.dir, { ...DEFAULT_CONFIG });
    expect(Object.keys(idx.files)).toContain("lib/c.ts");
    expect(Object.keys(idx.files)).not.toContain("src/a.ts");
    expect(Object.keys(idx.files)).not.toContain("src/b.ts");
    expect(removeGuard(r, "lib/c.ts", "rci").decision).toBe("deny");
  });

  it("file deleted and recreated with the same content: no crash, old fix no longer linked (limitation)", () => {
    const r = newRepo();
    withFix(r, "src/a.ts");
    r.rm("src/a.ts");
    r.commit("remove a");
    r.write("src/a.ts", text(FIXED));
    r.commit("bring a back");
    const idx = buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true });
    expect(idx.files["src/a.ts"]).toBeUndefined();
    expect(removeGuard(r, "src/a.ts", "dr").decision).toBeNull();
  });
});

describe("branches and rewritten history", () => {
  it("fix made on a branch and merged with a merge commit: deny fires on main", () => {
    const r = newRepo();
    r.write("src/sock.ts", text(BASE));
    r.commit("initial");
    r.git("checkout", "-q", "-b", "hotfix");
    r.write("src/sock.ts", text(FIXED));
    r.write("test/sock.test.ts", "it('x', () => {});\n");
    const fix = r.commit("fix: race on socket close (#412)");
    r.git("checkout", "-q", "main");
    r.write("README.md", "hi\n");
    r.commit("docs");
    r.git("merge", "-q", "--no-ff", "-m", "Merge branch 'hotfix'", "hotfix");
    const idx = buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true });
    expect(Object.keys(idx.commits)).toEqual([fix]);
    expect(removeGuard(r, "src/sock.ts", "mb").decision).toBe("deny");
  });

  it("squash-merged branch with a non-fix message: not indexed (documented limitation)", () => {
    const r = newRepo();
    r.write("src/sock.ts", text(BASE));
    r.commit("initial");
    r.git("checkout", "-q", "-b", "feat");
    r.write("src/sock.ts", text(FIXED));
    r.write("src/extra.ts", "export const a = 1;\n");
    r.commit("fix: race on socket close (#412)");
    r.git("checkout", "-q", "main");
    r.git("merge", "-q", "--squash", "feat");
    r.commit("Add socket feature");
    r.git("branch", "-D", "-q", "feat");
    const idx = buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true });
    expect(Object.keys(idx.commits)).toHaveLength(0);
  });

  it("history rewritten after indexing (index head not an ancestor): full rebuild, deny uses new shas", () => {
    const r = newRepo();
    withFix(r);
    const old = buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true });
    r.git("commit", "-q", "--amend", "-m", "fix: race on socket close, reworded (#412)");
    const fresh = buildIndex(r.dir, { ...DEFAULT_CONFIG });
    expect(fresh.head).not.toBe(old.head);
    expect(Object.keys(fresh.commits)).not.toEqual(Object.keys(old.commits));
    expect(Object.keys(fresh.commits)).toHaveLength(1);
    expect(removeGuard(r, "src/sock.ts", "rw").decision).toBe("deny");
  });

  it("stale index after a rewrite: SessionStart asks for a rebuild, PreToolUse does not crash", () => {
    const r = newRepo();
    withFix(r);
    buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true });
    r.git("commit", "-q", "--amend", "-m", "fix: reworded (#412)");
    let spawned = 0;
    handleHookInput(JSON.stringify({ cwd: r.dir, hook_event_name: "SessionStart" }), { spawnIndexer: () => spawned++ });
    expect(spawned).toBe(1);
    expect(() => removeGuard(r, "src/sock.ts", "stale")).not.toThrow();
  });

  it("cherry-picked fix: the cherry-pick sha is indexed and used", () => {
    const r = newRepo();
    r.write("src/sock.ts", text(BASE));
    r.commit("initial");
    r.git("checkout", "-q", "-b", "release");
    r.git("checkout", "-q", "main");
    r.write("src/sock.ts", text(FIXED));
    r.write("test/sock.test.ts", "it('x', () => {});\n");
    const fix = r.commit("fix: race on socket close (#412)");
    r.git("checkout", "-q", "release");
    r.git("cherry-pick", "-x", fix);
    const picked = r.git("rev-parse", "HEAD").trim();
    buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true });
    const res = removeGuard(r, "src/sock.ts", "cp");
    expect(res.decision).toBe("deny");
    expect(res.out.permissionDecisionReason).toContain(picked.slice(0, 7));
  });

  it("revert of a fix: re-applying the original fix is flagged as re-adding what the revert removed", () => {
    const r = newRepo();
    const fix = withFix(r);
    r.git("revert", "--no-edit", fix);
    const rev = r.git("rev-parse", "HEAD").trim();
    const idx = buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true });
    // "Revert "fix: ..."" reads like a fix to the classifier.
    expect(idx.commits[rev]).toBeDefined();
    const res = hook(r, "Write", { file_path: join(r.dir, "src", "sock.ts"), content: text(FIXED) }, "rv");
    expect(res.decision).toBe("deny");
    expect(res.out.permissionDecisionReason).toContain(rev.slice(0, 7));
  });
});

describe("fix commit shapes", () => {
  it("a fix that only deletes lines: putting them back is denied", () => {
    const r = newRepo();
    r.write("src/sock.ts", text(FIXED));
    r.commit("initial");
    r.write("src/sock.ts", text(BASE));
    r.write("test/sock.test.ts", "it('x', () => {});\n");
    r.commit("fix: double flush deadlock (#77)");
    buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true });
    const res = hook(r, "Write", { file_path: join(r.dir, "src", "sock.ts"), content: text(FIXED) }, "del");
    expect(res.decision).toBe("deny");
    // And removing a line from the current file is not a removes-fix hit.
    expect(hook(r, "Edit", { file_path: join(r.dir, "src", "sock.ts"), old_string: "  cleanup(sock);\n", new_string: "" }, "del2").decision).toBeNull();
  });

  it("a fix that touches 50 files: scored down (documented), index still builds", () => {
    const r = newRepo();
    for (let i = 0; i < 50; i++) r.write(`src/f${i}.ts`, `export const v${i} = compute(${i});\n`);
    r.commit("initial");
    for (let i = 0; i < 50; i++) r.write(`src/f${i}.ts`, `export const v${i} = compute(${i});\nif (v${i} == null) throw new Error('null v${i}');\n`);
    r.commit("fix: null crash everywhere (#5)");
    const idx = buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true });
    // +3 keyword, +1 ref, -3 more than 40 files = 1: not a fix.
    expect(Object.keys(idx.commits)).toHaveLength(0);
  });

  it("unicode, emoji and a very long body in the message; odd author name", () => {
    const r = newRepo();
    r.git("config", "user.name", "Zoë \"Ops\" O'Neil 🚀 <not-an-email>");
    const body = "🐛 ".repeat(20) + "\n\n" + "Long body line with ünïcødé and 日本語. ".repeat(3000);
    r.write("src/sock.ts", text(BASE));
    r.commit("initial");
    r.write("src/sock.ts", text(FIXED));
    r.write("test/sock.test.ts", "it('flushes', () => {});\n");
    // A body this long does not fit on a Windows command line, so commit from a file outside the repo.
    const msgFile = join(r.dir, ".git", "chesterton-test-msg.txt");
    writeFileSync(msgFile, `fix: 修复 race on close 🔥 (#412)\n\n${body}\n`);
    r.git("add", "-A");
    r.git("commit", "-q", "-F", msgFile);
    const fix = r.git("rev-parse", "HEAD").trim();
    const idx = buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true });
    expect(idx.commits[fix]?.subject).toBe("fix: 修复 race on close 🔥 (#412)");
    expect(idx.commits[fix]?.author).toContain("Zoë");
    const res = removeGuard(r, "src/sock.ts", "uni");
    expect(res.decision).toBe("deny");
    expect(res.out.permissionDecisionReason).toContain("修复");
  });

  // Was a bug (wrong result, low): commit metadata is split on \x1e and \x1f. A message that contains either
  // control character (pasted from a terminal or a tool) shifts the fields, so the commit is dropped or
  // its subject, author and body land in the wrong fields.
  it("a commit message containing \\x1e or \\x1f is still parsed correctly", () => {
    const r = newRepo();
    const fix = withFix(r, "src/sock.ts", "fix: race on close \x1f odd \x1e chars (#412)");
    const idx = buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true });
    expect(idx.commits[fix]).toBeDefined();
    expect(idx.files["src/sock.ts"]?.length).toBe(1);
  });

  it("fix and a later commit to the same line: blame points at the later commit, only weak or nothing", () => {
    const r = newRepo();
    withFix(r);
    r.write("src/sock.ts", text(FIXED.map((l) => (l === G1 ? "  if (sock.pending > 0) await flush(sock, { force: true });" : l))));
    r.commit("tune flush");
    buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true });
    const res = hook(
      r,
      "Edit",
      { file_path: join(r.dir, "src", "sock.ts"), old_string: "  if (sock.pending > 0) await flush(sock, { force: true });\n", new_string: "" },
      "later",
    );
    expect(res.decision === null || res.decision === "allow").toBe(true);
  });

  it("merge commits are never classified as fixes even with a fix message", () => {
    const r = newRepo();
    r.write("a.ts", "export const a = 1;\n");
    r.commit("initial");
    r.git("checkout", "-q", "-b", "b");
    r.write("b.ts", "export const b = 2;\n");
    r.commit("add b");
    r.git("checkout", "-q", "main");
    r.write("c.ts", "export const c = 3;\n");
    r.commit("add c");
    r.git("merge", "-q", "--no-ff", "-m", "fix: merge the crash fix branch (#1)", "b");
    const idx = buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true });
    expect(Object.keys(idx.commits)).toHaveLength(0);
    expect(loadIndex(r.dir)?.head).toBe(r.git("rev-parse", "HEAD").trim());
  });
});
