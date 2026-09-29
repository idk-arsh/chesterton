// Edit check correctness: path keys that clash with Object.prototype, removals the same edit
// adds back, the time budget across blame calls, and `why` arguments with spaces.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleHookInput } from "../src/hook.js";
import { buildIndex } from "../src/index-builder.js";
import { loadIndex, loadIndexForFiles, saveIndex } from "../src/index-store.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { explainLine } from "../src/why.js";
import { parseFileLine } from "../src/cli.js";
import { analyzeChange } from "../src/analyze.js";
import { hashLine, normalizeLine } from "../src/normalize.js";
import type { BlameLine, ChestertonIndex } from "../src/types.js";
import { INDEX_VERSION } from "../src/types.js";
import { makeRepo, type TestRepo } from "./helpers/repo.js";

vi.setConfig({ testTimeout: 60_000 });

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
let repo: TestRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

const FIX_LINE = "  await sleep(50); // kernel needs a moment to drain the send buffer";
const BEFORE = ["async function closeSocket(sock) {", "  sock.end();", "  sock.destroy();", "}", ""].join("\n");
const AFTER = ["async function closeSocket(sock) {", "  sock.end();", FIX_LINE, "  sock.destroy();", "}", ""].join("\n");

/** Repo where `path` got FIX_LINE from a fix commit. */
function fixRepo(path: string, withIndex = true): { r: TestRepo; fix: string } {
  const r = makeRepo();
  repo = r;
  r.write(path, BEFORE);
  r.commit("initial");
  r.write(path, AFTER);
  const fix = r.commit("fix: race on socket close under load (#412)");
  if (withIndex) saveIndex(r.dir, buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true }));
  return { r, fix };
}

const deps = () => ({ startedAt: Date.now() + 60_000, spawnIndexer: () => {} });
const out = (s: string | null) => (s === null ? null : JSON.parse(s).hookSpecificOutput);
function pre(r: TestRepo, tool: string, toolInput: object, sessionId = "s1"): string {
  return JSON.stringify({ session_id: sessionId, cwd: r.dir, hook_event_name: "PreToolUse", tool_name: tool, tool_input: toolInput });
}

describe("files named like Object.prototype members", () => {
  it.each(["constructor", "__proto__", "toString"])("a fix to a root file named %s is indexed and guarded", (name) => {
    const { r, fix } = fixRepo(name);
    const idx = loadIndex(r.dir)!;
    expect(Object.prototype.hasOwnProperty.call(idx.files, name)).toBe(true);
    expect(idx.files[name]![0]!.sha).toBe(fix);
    expect(loadIndexForFiles(r.dir, [name])!.files[name]![0]!.sha).toBe(fix);

    const denied = out(handleHookInput(pre(r, "Edit", { file_path: join(r.dir, name), old_string: `${FIX_LINE}\n`, new_string: "" }), deps()));
    expect(denied.permissionDecision).toBe("deny");
    expect(denied.permissionDecisionReason).toContain(fix.slice(0, 7));

    expect(explainLine(r.dir, name, 3, loadIndexForFiles(r.dir, [name], { allCommits: true }))).toContain("Fix commit behind this line");
  });
});

describe("removed lines the same edit adds back", () => {
  const reindent = (text: string) => text.replace(/^ {2}/gm, "    ");

  it("re-indenting the file while changing another line is not a strong hit", () => {
    const { r } = fixRepo("src/net.js");
    const content = reindent(AFTER).replace("sock.destroy();", "sock.destroy(new Error('closed'));");
    const res = out(handleHookInput(pre(r, "Write", { file_path: join(r.dir, "src", "net.js"), content }), deps()));
    expect(res?.permissionDecision).toBeUndefined();
  });

  it("the same edit without the fix line is still denied", () => {
    const { r, fix } = fixRepo("src/net.js");
    const content = reindent(AFTER).replace(`${reindent(FIX_LINE)}\n`, "");
    expect(content).not.toContain("sleep(50)");
    const res = out(handleHookInput(pre(r, "Write", { file_path: join(r.dir, "src", "net.js"), content }), deps()));
    expect(res.permissionDecision).toBe("deny");
    expect(res.permissionDecisionReason).toContain(fix.slice(0, 7));
  });

  it("without an index, the blame fallback also lets a re-indent through", () => {
    const { r } = fixRepo("src/net.js", false);
    const content = reindent(AFTER).replace("sock.destroy();", "sock.destroy(new Error('closed'));");
    const res = out(handleHookInput(pre(r, "Write", { file_path: join(r.dir, "src", "net.js"), content }), deps()));
    expect(res?.permissionDecision).toBeUndefined();
  });

  it("counts copies: removing two copies and adding one back is still strong, one for one is not", () => {
    const sha = "a".repeat(40);
    const e = { hash: hashLine(normalizeLine(FIX_LINE)), text: FIX_LINE.trim(), line: 3 };
    const idx: ChestertonIndex = {
      version: INDEX_VERSION,
      head: "x",
      builtAt: "",
      commits: { [sha]: { sha, date: "", author: "", subject: "fix: race", score: 4, reasons: [], refs: [], testFiles: [] } },
      files: { "src/net.js": [{ sha, path: "src/net.js", added: [e], removed: [] }] },
    };
    const blame = (_r: string, _p: string, s: number, en: number): BlameLine[] => {
      const lines: BlameLine[] = [];
      for (let l = s; l <= en; l++) lines.push({ line: l, sha, origLine: 3, origPath: "src/net.js" });
      return lines;
    };
    const run = (removed: number[], added: string[]) =>
      analyzeChange(
        "/nowhere",
        { relPath: "src/net.js", removed: removed.map((line) => ({ line, text: FIX_LINE })), added, isNewFile: false },
        idx,
        { ...DEFAULT_CONFIG },
        { blame, currentContent: [...Array(10)].map(() => FIX_LINE).join("\n") },
      );
    expect(run([3, 4], [`    ${FIX_LINE.trim()}`]).map((f) => f.strength)).toEqual(["strong"]);
    // One for one (plus another change, since a pure re-indent is ignored anyway): no strong hit is
    // possible, so blame is skipped and nothing comes back.
    expect(run([3], [`    ${FIX_LINE.trim()}`, "  logClose(sock);"])).toEqual([]);
    expect(run([3], []).map((f) => f.strength)).toEqual(["strong"]);
  });
});

describe("edit check budget across blame calls", () => {
  it("each blame call gets what is left of the budget, and the hook gives up silently when it runs out", () => {
    // Two fix lines far apart, so the removal needs two separate blame windows.
    const r = makeRepo();
    repo = r;
    const filler = Array.from({ length: 20 }, (_, i) => `  step${i}(sock, "value ${i}");`);
    const base = ["function close(sock) {", ...filler, "}", ""];
    r.write("src/sock.ts", base.join("\n"));
    r.write(".chesterton.yml", "hook_timeout_ms: 400\n");
    r.commit("initial");
    const withFix = [...base];
    withFix.splice(1, 0, "  if (sock.pending > 0) await flush(sock);");
    withFix.splice(18, 0, "  sock.removeAllListeners('data');");
    r.write("src/sock.ts", withFix.join("\n"));
    r.commit("fix: race on socket close (#412)");
    saveIndex(r.dir, buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true }));

    const budgets: number[] = [];
    const slowBlame = (_r: string, _p: string, _s: number, _e: number, timeoutMs?: number): BlameLine[] => {
      budgets.push(timeoutMs ?? -1);
      const until = Date.now() + 250;
      while (Date.now() < until) {
        /* a slow git blame */
      }
      return [];
    };
    const started = Date.now();
    const res = handleHookInput(
      pre(r, "Write", { file_path: join(r.dir, "src", "sock.ts"), content: base.join("\n") }),
      { startedAt: started, spawnIndexer: () => {}, blame: slowBlame },
    );
    const took = Date.now() - started;
    expect(res).toBeNull();
    expect(budgets.length).toBeGreaterThanOrEqual(1);
    for (const b of budgets) expect(b).toBeLessThanOrEqual(400);
    if (budgets.length > 1) expect(budgets[1]!).toBeLessThan(budgets[0]!);
    // Two windows at most get a turn before the budget is gone; the old code gave each the full budget.
    expect(took).toBeLessThan(1_500);
  });
});

describe("why arguments with spaces", () => {
  it("accepts a path with spaces, and file and line in one argument", () => {
    expect(parseFileLine(["src/my file.ts:3"])).toEqual({ file: "src/my file.ts", line: 3 });
    expect(parseFileLine(["src/a.ts 3"])).toEqual({ file: "src/a.ts", line: 3 });
    expect(parseFileLine(["C:\\My Repo\\a.ts:7"])).toEqual({ file: "C:\\My Repo\\a.ts", line: 7 });
  });

  it("the slash command passes its argument as one quoted word", () => {
    expect(readFileSync(join(ROOT, "commands", "why.md"), "utf8")).toContain('why "$ARGUMENTS"');
  });
});
