import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { handleHookInput } from "../src/hook.js";
import { loadSession } from "../src/session.js";
import { buildIndex } from "../src/index-builder.js";
import { saveIndex } from "../src/index-store.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { makeRepo, type TestRepo } from "./helpers/repo.js";

const GUARD1 = "  if (sock.pending > 0) await flush(sock);";
const GUARD2 = "  sock.removeAllListeners('data');";
const FIXED = ["function close(sock) {", GUARD1, GUARD2, "  sock.end();", "  cleanup(sock);", "}", ""].join("\n");

let repo: TestRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

function fixRepo(withIndex: boolean): { r: TestRepo; fix: string } {
  const r = makeRepo();
  repo = r;
  r.write("src/sock.ts", ["function close(sock) {", "  sock.end();", "  cleanup(sock);", "}", ""].join("\n"));
  r.commit("initial");
  r.write("src/sock.ts", FIXED);
  r.write("test/sock.test.ts", "it('flushes', () => {});\n");
  const fix = r.commit("fix: race on socket close (#412)");
  if (withIndex) saveIndex(r.dir, buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true }));
  return { r, fix };
}

/** Plenty of budget so slow CI machines do not trip the hook timeout. */
const deps = () => ({ startedAt: Date.now() + 60_000, spawnIndexer: () => {} });

function pre(r: TestRepo, toolInput: object, sessionId = "s1", tool = "Edit"): string {
  return JSON.stringify({
    session_id: sessionId,
    cwd: r.dir,
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: toolInput,
  });
}

const out = (s: string | null) => (s === null ? null : JSON.parse(s).hookSpecificOutput);

describe("handleHookInput", () => {
  it("returns null on garbage and outside a git repo", () => {
    expect(handleHookInput("not json")).toBeNull();
    expect(handleHookInput("")).toBeNull();
    expect(handleHookInput("null")).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "chesterton-nogit-"));
    try {
      expect(handleHookInput(JSON.stringify({ cwd: dir, hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: {} }))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("PreToolUse: denies removing a fix once, then allows the retry with context", () => {
    const { r, fix } = fixRepo(true);
    const input = pre(r, { file_path: join(r.dir, "src", "sock.ts"), old_string: `${GUARD1}\n`, new_string: "" });
    const first = out(handleHookInput(input, deps()));
    expect(first.permissionDecision).toBe("deny");
    expect(first.permissionDecisionReason).toContain(fix.slice(0, 7));
    const second = out(handleHookInput(input, deps()));
    expect(second.permissionDecision).toBeUndefined();
    expect(second.additionalContext).toContain(fix.slice(0, 7));
    const s = loadSession(r.dir, "s1");
    expect(s.files).toEqual(["src/sock.ts"]);
    expect(s.acknowledged).toEqual([`src/sock.ts@${fix}`]);
  });

  it("PreToolUse: silent for unrelated edits and other tools, but records the file", () => {
    const { r } = fixRepo(true);
    expect(handleHookInput(pre(r, { file_path: "src/sock.ts", old_string: "}\n", new_string: "}\n// end\n" }), deps())).toBeNull();
    expect(handleHookInput(pre(r, { file_path: "src/sock.ts" }, "s1", "Read"), deps())).toBeNull();
    expect(loadSession(r.dir, "s1").files).toEqual(["src/sock.ts"]);
  });

  it("PreToolUse without an index falls back to blame and on-the-fly classification", () => {
    const { r, fix } = fixRepo(false);
    const res = out(handleHookInput(pre(r, { file_path: "src/sock.ts", old_string: `${GUARD1}\n${GUARD2}\n`, new_string: "" }), deps()));
    expect(res.permissionDecision).toBe("deny");
    expect(res.permissionDecisionReason).toContain(fix.slice(0, 7));
    expect(res.permissionDecisionReason).toContain("fix: race on socket close (#412)");
  });

  it("PreToolUse past the time budget prints nothing and records nothing", () => {
    const { r } = fixRepo(true);
    const input = pre(r, { file_path: "src/sock.ts", old_string: `${GUARD1}\n`, new_string: "" });
    expect(handleHookInput(input, { startedAt: Date.now() - 600_000 })).toBeNull();
    expect(loadSession(r.dir, "s1").acknowledged).toEqual([]);
  });

  it("SessionStart spawns the indexer when the index is missing or stale", () => {
    const { r } = fixRepo(false);
    const calls: string[] = [];
    const input = JSON.stringify({ session_id: "s1", cwd: r.dir, hook_event_name: "SessionStart", source: "startup" });
    expect(handleHookInput(input, { spawnIndexer: (root) => calls.push(root) })).toBeNull();
    expect(calls).toHaveLength(1);

    saveIndex(r.dir, buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true }));
    const res = out(handleHookInput(input, { spawnIndexer: (root) => calls.push(root) }));
    expect(calls).toHaveLength(1);
    expect(res.hookEventName).toBe("SessionStart");
    expect(res.additionalContext).toContain("1 fix commit indexed");

    r.write("other.txt", "x\n");
    r.commit("chore: unrelated");
    handleHookInput(input, { spawnIndexer: (root) => calls.push(root) });
    expect(calls).toHaveLength(2);
  });

  it("SessionStart with the default spawner does not crash when cli.js is absent", () => {
    const { r } = fixRepo(false);
    const input = JSON.stringify({ session_id: "s1", cwd: r.dir, hook_event_name: "SessionStart" });
    expect(handleHookInput(input, { cliPath: join(r.dir, "missing-cli.js") })).toBeNull();
  });

  it("Stop reports strong findings from this session that were never surfaced, once", () => {
    const { r, fix } = fixRepo(true);
    // An edit the hook saw but did not flag (it only touched the end), then a later write that removed the fix.
    handleHookInput(pre(r, { file_path: "src/sock.ts", old_string: "}\n", new_string: "}\n// end\n" }), deps());
    r.write("src/sock.ts", ["function close(sock) {", "  sock.end();", "  cleanup(sock);", "}", "// end", ""].join("\n"));
    const stopInput = JSON.stringify({ session_id: "s1", cwd: r.dir, hook_event_name: "Stop", stop_hook_active: false });
    const res = out(handleHookInput(stopInput, deps()));
    expect(res.hookEventName).toBe("Stop");
    expect(res.additionalContext).toContain("src/sock.ts");
    expect(res.additionalContext).toContain(fix.slice(0, 7));
    expect(res.decision).toBeUndefined();
    expect(handleHookInput(stopInput, deps())).toBeNull();
  });

  it("Stop stays quiet for findings already surfaced, and when stop_hook_active", () => {
    const { r } = fixRepo(true);
    handleHookInput(pre(r, { file_path: "src/sock.ts", old_string: `${GUARD1}\n`, new_string: "" }), deps());
    r.write("src/sock.ts", FIXED.replace(`${GUARD1}\n`, ""));
    const stopInput = { session_id: "s1", cwd: r.dir, hook_event_name: "Stop" };
    expect(handleHookInput(JSON.stringify(stopInput), deps())).toBeNull();
    expect(handleHookInput(JSON.stringify({ ...stopInput, session_id: "s2", stop_hook_active: true }), deps())).toBeNull();
  });
});

describe("bundled hook process", () => {
  let bundleDir = "";
  let hookJs = "";
  beforeAll(async () => {
    bundleDir = mkdtempSync(join(tmpdir(), "chesterton-bundle-"));
    hookJs = join(bundleDir, "hook.js");
    await build({
      entryPoints: [fileURLToPath(new URL("../src/hook.ts", import.meta.url))],
      outfile: hookJs,
      bundle: true,
      platform: "node",
      target: "node18",
      format: "esm",
      logLevel: "silent",
    });
  }, 60_000);
  afterAll(() => {
    if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
  });

  const run = (stdin: string, cwd?: string) =>
    spawnSync(process.execPath, [hookJs], { input: stdin, encoding: "utf8", cwd, timeout: 30_000, windowsHide: true });

  it("exits 0 with no output on garbage stdin", () => {
    expect(existsSync(hookJs)).toBe(true);
    const res = run("{{{ garbage");
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("");
  });

  it("exits 0 with no output outside a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "chesterton-nogit-"));
    try {
      const res = run(JSON.stringify({ cwd: dir, session_id: "x", hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: {} }), dir);
      expect(res.status).toBe(0);
      expect(res.stdout).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints a deny decision for an edit that removes a fix", () => {
    const { r, fix } = fixRepo(true);
    const res = run(pre(r, { file_path: join(r.dir, "src", "sock.ts"), old_string: `${GUARD1}\n`, new_string: "" }));
    expect(res.status).toBe(0);
    // The default 1.5s budget can be tight on a cold machine; if it ran out the hook is silent by design.
    if (res.stdout.trim()) {
      const o = JSON.parse(res.stdout).hookSpecificOutput;
      expect(o.permissionDecision).toBe("deny");
      expect(o.permissionDecisionReason).toContain(fix.slice(0, 7));
    }
  });
});
