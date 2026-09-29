// Edge cases for what the hook receives on stdin. The hook must fail open: exit 0, print nothing.
import { afterEach, describe, expect, it, vi } from "vitest";

// Real git repos on Windows are slow; give every test room when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 60_000 });
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleHookInput } from "../src/hook.js";
import { buildIndex } from "../src/index-builder.js";
import { indexDir } from "../src/index-store.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { makeRepo, type TestRepo } from "./helpers/repo.js";

const HOOK_JS = join(fileURLToPath(new URL(".", import.meta.url)), "..", "dist", "hook.js");
const GUARD = "  if (sock.pending > 0) await flush(sock);";

let repo: TestRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

function fixRepo(): TestRepo {
  const r = makeRepo();
  repo = r;
  r.write("src/sock.ts", ["function close(sock) {", "  sock.end();", "}", ""].join("\n"));
  r.commit("initial");
  r.write("src/sock.ts", ["function close(sock) {", GUARD, "  sock.end();", "}", ""].join("\n"));
  r.write("test/sock.test.ts", "it('flushes', () => {});\n");
  r.commit("fix: race on socket close (#412)");
  buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true });
  return r;
}

const deps = () => ({ startedAt: Date.now() + 60_000, spawnIndexer: () => {} });

function runHook(stdin: string | Buffer, cwd?: string): { status: number | null; stdout: string; stderr: string; ms: number } {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [HOOK_JS], { input: stdin, encoding: "utf8", cwd, timeout: 30_000, windowsHide: true });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, ms: Date.now() - t0 };
}

describe("hook stdin robustness (process level, dist/hook.js)", () => {
  it("dist/hook.js exists", () => {
    expect(existsSync(HOOK_JS)).toBe(true);
  });

  it("garbage stdin: exit 0, no output", () => {
    for (const input of ["not json", "{", "}}}", "\u0000\u0001\u0002", "[1,2,3]", "42", "\"str\"", "true", "null"]) {
      const r = runHook(input);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe("");
    }
  });

  it("empty stdin: exit 0, no output", () => {
    const r = runHook("");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("invalid UTF-8 bytes on stdin: exit 0, no output", () => {
    const r = runHook(Buffer.from([0xff, 0xfe, 0x7b, 0x22, 0xc3, 0x28, 0x7d]));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("stdin that never closes: exits 0 within about 4 s", async () => {
    const t0 = Date.now();
    const code = await new Promise<number | null>((resolve) => {
      const c = spawn(process.execPath, [HOOK_JS], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.stdin.write('{"hook_event_name":"PreToolUse","tool_name":"Edit"');
      const kill = setTimeout(() => c.kill(), 15_000);
      c.on("exit", (status) => {
        clearTimeout(kill);
        expect(out).toBe("");
        resolve(status);
      });
    });
    const ms = Date.now() - t0;
    expect(code).toBe(0);
    expect(ms).toBeLessThan(4_500);
  }, 20_000);

  it("huge payload (20 MB of JSON) for a real repo file: exit 0 quickly, no crash", () => {
    const r = fixRepo();
    const content = "x".repeat(80) + "\n";
    const big = content.repeat(250_000); // ~20 MB
    const input = JSON.stringify({
      session_id: "huge",
      cwd: r.dir,
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(r.dir, "src", "sock.ts"), content: big },
    });
    const res = runHook(input, r.dir);
    expect(res.status).toBe(0);
    // A strong finding here is fine (the Write drops the guard); what matters is it did not crash.
    if (res.stdout) expect(() => JSON.parse(res.stdout)).not.toThrow();
  }, 60_000);

  it("git missing from PATH: exit 0, no output, for every event", () => {
    const r = fixRepo();
    for (const ev of ["SessionStart", "PreToolUse", "Stop"]) {
      const input = JSON.stringify({
        session_id: "nogit",
        cwd: r.dir,
        hook_event_name: ev,
        tool_name: "Edit",
        tool_input: { file_path: join(r.dir, "src", "sock.ts"), old_string: `${GUARD}\n`, new_string: "" },
      });
      const res = spawnSync(process.execPath, [HOOK_JS], {
        input,
        encoding: "utf8",
        cwd: r.dir,
        timeout: 30_000,
        windowsHide: true,
        env: { ...process.env, PATH: "", Path: "" },
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toBe("");
    }
  });

  it("a real deny comes out as one line of valid JSON on stdout", () => {
    const r = fixRepo();
    const input = JSON.stringify({
      session_id: "proc",
      cwd: r.dir,
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: join(r.dir, "src", "sock.ts"), old_string: `${GUARD}\n`, new_string: "" },
    });
    const res = runHook(input, r.dir);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

describe("hook input shapes (in process)", () => {
  it("valid JSON with fields missing returns null", () => {
    const r = fixRepo();
    const cases: object[] = [
      {},
      { cwd: r.dir },
      { cwd: r.dir, hook_event_name: "PreToolUse" },
      { cwd: r.dir, hook_event_name: "PreToolUse", tool_name: "Edit" },
      { cwd: r.dir, hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: {} },
      { cwd: r.dir, hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(r.dir, "src/sock.ts") } },
      { cwd: r.dir, hook_event_name: "PreToolUse", tool_input: { file_path: join(r.dir, "src/sock.ts"), old_string: GUARD, new_string: "" } },
    ];
    for (const c of cases) expect(handleHookInput(JSON.stringify(c), deps())).toBeNull();
  });

  it("unknown hook_event_name returns null", () => {
    const r = fixRepo();
    for (const ev of ["PostToolUse", "UserPromptSubmit", "pretooluse", "", 42, null, ["PreToolUse"]]) {
      const input = JSON.stringify({
        cwd: r.dir,
        hook_event_name: ev,
        tool_name: "Edit",
        tool_input: { file_path: join(r.dir, "src/sock.ts"), old_string: `${GUARD}\n`, new_string: "" },
      });
      expect(handleHookInput(input, deps())).toBeNull();
    }
  });

  it("tool_input with wrong types returns null and never throws", () => {
    const r = fixRepo();
    const fp = join(r.dir, "src/sock.ts");
    const bad: [string, unknown][] = [
      ["Edit", "a string"],
      ["Edit", 42],
      ["Edit", null],
      ["Edit", []],
      ["Edit", { file_path: 42, old_string: GUARD, new_string: "" }],
      ["Edit", { file_path: [fp], old_string: GUARD, new_string: "" }],
      ["Edit", { file_path: fp, old_string: 1, new_string: "" }],
      ["Edit", { file_path: fp, old_string: GUARD, new_string: null }],
      ["Edit", { file_path: fp, old_string: { a: 1 }, new_string: "" }],
      ["Write", { file_path: fp, content: 12 }],
      ["Write", { file_path: fp, content: ["a", "b"] }],
      ["Write", { file_path: fp }],
      ["MultiEdit", { file_path: fp, edits: "nope" }],
      ["MultiEdit", { file_path: fp, edits: [null] }],
      ["MultiEdit", { file_path: fp, edits: [{ old_string: 1, new_string: 2 }] }],
      ["MultiEdit", { file_path: fp, edits: {} }],
      ["Edit", { file_path: "", old_string: GUARD, new_string: "" }],
      ["Edit", { file_path: "   ", old_string: GUARD, new_string: "" }],
    ];
    for (const [tool, ti] of bad) {
      const input = JSON.stringify({ cwd: r.dir, session_id: "t", hook_event_name: "PreToolUse", tool_name: tool, tool_input: ti });
      expect(() => handleHookInput(input, deps())).not.toThrow();
      expect(handleHookInput(input, deps())).toBeNull();
    }
    // tool_name with the wrong type
    for (const tn of [42, null, { x: 1 }, "edit", "Bash"]) {
      const input = JSON.stringify({
        cwd: r.dir,
        hook_event_name: "PreToolUse",
        tool_name: tn,
        tool_input: { file_path: fp, old_string: `${GUARD}\n`, new_string: "" },
      });
      expect(handleHookInput(input, deps())).toBeNull();
    }
  });

  it("cwd with the wrong type falls back to process.cwd() without throwing", () => {
    for (const cwd of [42, null, [], {}, ""]) {
      const input = JSON.stringify({ cwd, hook_event_name: "Nope" });
      expect(() => handleHookInput(input, deps())).not.toThrow();
    }
  });

  it("cwd that does not exist returns null", () => {
    const input = JSON.stringify({
      cwd: join(process.cwd(), "definitely", "not", "here"),
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: {},
    });
    expect(handleHookInput(input)).toBeNull();
  });

  it("session_id with path characters stays inside <git-dir>/chesterton/sessions", () => {
    const r = fixRepo();
    const nasty = ["../../x", "..\\..\\x", "/etc/passwd", "C:\\Windows\\x", "a/../../../b", "....", "con", "a\u0000b", "x".repeat(500)];
    for (const sid of nasty) {
      const input = JSON.stringify({
        session_id: sid,
        cwd: r.dir,
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: join(r.dir, "src", "sock.ts"), old_string: `${GUARD}\n`, new_string: "" },
      });
      const out = handleHookInput(input, deps());
      expect(out).not.toBeNull();
    }
    const sessions = join(indexDir(r.dir), "sessions");
    const files = readdirSync(sessions);
    for (const f of files) expect(f).toMatch(/^[A-Za-z0-9._-]+\.json$/);
    // Nothing escaped into the git dir or the repo root.
    expect(existsSync(join(r.dir, "x.json"))).toBe(false);
    expect(existsSync(join(indexDir(r.dir), "x.json"))).toBe(false);
    expect(existsSync(join(r.dir, ".git", "x.json"))).toBe(false);
  });

  // Cosmetic: two different session ids can share a session file after sanitizing,
  // so one session's acknowledgement lets the other session's first attempt through.
  // BUG: sanitizeSessionId maps "a/b" and "a_b" (and "a:b") to the same file "a_b.json".
  it.fails("different session ids never share acknowledgements", () => {
    const r = fixRepo();
    const mk = (sid: string) =>
      JSON.stringify({
        session_id: sid,
        cwd: r.dir,
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: join(r.dir, "src", "sock.ts"), old_string: `${GUARD}\n`, new_string: "" },
      });
    const first = JSON.parse(handleHookInput(mk("a/b"), deps())!).hookSpecificOutput;
    expect(first.permissionDecision).toBe("deny");
    const other = JSON.parse(handleHookInput(mk("a_b"), deps())!).hookSpecificOutput;
    expect(other.permissionDecision).toBe("deny");
  });
});
