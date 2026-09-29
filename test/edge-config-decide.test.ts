// Edge cases for .chesterton.yml and for the allow / deny / ask decision.
import { afterEach, describe, expect, it, vi } from "vitest";

// Real git repos on Windows are slow; give every test room when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 60_000 });
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleHookInput } from "../src/hook.js";
import { buildIndex } from "../src/index-builder.js";
import { DEFAULT_CONFIG, loadConfig, loadConfigWithWarnings, parseConfig } from "../src/config.js";
import { matchGlob } from "../src/decide.js";
import { makeRepo, type TestRepo } from "./helpers/repo.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const G1 = "  if (sock.pending > 0) await flush(sock);";
const G2 = "  sock.removeAllListeners('data');";
const H1 = "  if (!sock.destroyed) sock.setTimeout(0);";

let repo: TestRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

/** Two fix commits in one file: A adds G1, B adds H1. */
function twoFixRepo(path = "src/sock.ts", yml?: string): { r: TestRepo; a: string; b: string; file: string } {
  const r = makeRepo();
  repo = r;
  if (yml !== undefined) r.write(".chesterton.yml", yml);
  r.write(path, ["function close(sock) {", G2, "  sock.end();", "  cleanup(sock);", "}", ""].join("\n"));
  r.commit("initial");
  r.write(path, ["function close(sock) {", G1, G2, "  sock.end();", "  cleanup(sock);", "}", ""].join("\n"));
  r.write("test/a.test.ts", "it('a', () => {});\n");
  const a = r.commit("fix: race on socket close (#412)");
  r.write(path, ["function close(sock) {", G1, G2, "  sock.end();", H1, "  cleanup(sock);", "}", ""].join("\n"));
  r.write("test/b.test.ts", "it('b', () => {});\n");
  const b = r.commit("fix: timeout leak on close (#413)");
  buildIndex(r.dir, loadConfig(r.dir), { full: true });
  return { r, a, b, file: join(r.dir, ...path.split("/")) };
}

const deps = () => ({ startedAt: Date.now() + 60_000, spawnIndexer: () => {} });
function edit(r: TestRepo, file: string, oldS: string, newS: string, sid: string): any {
  const s = handleHookInput(
    JSON.stringify({ session_id: sid, cwd: r.dir, hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: file, old_string: oldS, new_string: newS } }),
    deps(),
  );
  return s === null ? null : JSON.parse(s).hookSpecificOutput;
}
const dec = (o: any) => (o === null ? null : o.permissionDecision ?? "allow");

describe("config parsing edge cases", () => {
  it("malformed .chesterton.yml never throws and falls back to defaults", () => {
    const junk = [
      "\u0000\u0001\u0002binary",
      "mode: [unclosed",
      "mode:\n  nested: map\n  deeper:\n    - x",
      "\tmode: ask",
      ": : :",
      "mode: 'unterminated",
      "- just a list\n- at top level",
      "mode: ask\nmode: warn-only\nmode: bogus",
      "a".repeat(100_000),
      "protect:\n  - 'src/**'\n  -\n  - \"\"",
      "﻿mode: ask",
    ];
    for (const j of junk) {
      expect(() => parseConfig(j)).not.toThrow();
      const { config } = parseConfig(j);
      expect(["speedbump", "ask", "warn-only"]).toContain(config.mode);
    }
    expect(parseConfig("﻿mode: ask").config.mode).toBe("ask");
    // Later keys win, and a bad last value means the default.
    expect(parseConfig("mode: ask\nmode: warn-only\nmode: bogus").config.mode).toBe("speedbump");
    expect(parseConfig("mode: ask\nmode: warn-only").config.mode).toBe("warn-only");
  });

  it("unknown keys produce a warning and are ignored", () => {
    const { config, warnings } = parseConfig("mood: ask\nprotec: [src/**]\nmode: ask\n");
    expect(config.mode).toBe("ask");
    expect(config.protect).toEqual([]);
    expect(warnings.some((w) => w.includes('"mood"'))).toBe(true);
    expect(warnings.some((w) => w.includes('"protec"'))).toBe(true);
  });

  it("bad regex in fix_patterns_extra is skipped with a warning, good ones kept", () => {
    const { config, warnings } = parseConfig('fix_patterns_extra: ["(unclosed", "SEV\\\\d", "[z-a]", "postmortem"]\n');
    expect(config.fixPatternsExtra).toEqual(["SEV\\d", "postmortem"]);
    expect(warnings.filter((w) => w.includes("not a valid regex"))).toHaveLength(2);
  });

  it("bad regex in the repo config does not break the hook or the index", () => {
    const { r, file } = twoFixRepo("src/sock.ts", 'fix_patterns_extra: ["(unclosed", "*bad"]\n');
    expect(dec(edit(r, file, `${G1}\n`, "", "badre"))).toBe("deny");
  });

  it("protect globs with backslashes match forward-slash paths", () => {
    expect(parseConfig("protect: [src\\payments\\**]\n").config.protect).toEqual(["src/payments/**"]);
    expect(parseConfig('protect: ["src\\\\payments\\\\**"]\n').config.protect).toEqual(["src/payments/**"]);
    expect(matchGlob("src/payments/card.ts", "src\\payments\\**")).toBe(true);
    expect(matchGlob("src/payments", "src\\payments")).toBe(true);
    expect(matchGlob("src/payments/deep/x.ts", "src\\payments")).toBe(true);
    expect(matchGlob("src/paymentsx/y.ts", "src/payments")).toBe(false);
  });

  it("mode typos fall back to speedbump with a warning; case is ignored", () => {
    for (const bad of ["warn_only", "warnonly", "speed-bump", "deny", "off", "\"\"", "[ask]"]) {
      const { config, warnings } = parseConfig(`mode: ${bad}\n`);
      expect(config.mode).toBe("speedbump");
      expect(warnings.some((w) => w.startsWith("mode:"))).toBe(true);
    }
    expect(parseConfig("mode: ASK\n").config.mode).toBe("ask");
    expect(parseConfig("mode: Warn-Only\n").config.mode).toBe("warn-only");
  });

  it("hook_timeout_ms: 100 and 60000 accepted, 99 / 60001 / junk rejected", () => {
    expect(parseConfig("hook_timeout_ms: 100").config.hookTimeoutMs).toBe(100);
    expect(parseConfig("hook_timeout_ms: 60000").config.hookTimeoutMs).toBe(60000);
    expect(parseConfig("hook_timeout_ms: 60_000").config.hookTimeoutMs).toBe(60000);
    for (const v of ["99", "60001", "-5", "1.5e3", "abc", "", "0x100"]) {
      expect(parseConfig(`hook_timeout_ms: ${v}`).config.hookTimeoutMs).toBe(DEFAULT_CONFIG.hookTimeoutMs);
    }
  });

  it("hook_timeout_ms: 100 in a real repo fails open quickly (null or a normal answer, never a throw)", () => {
    const { r, file } = twoFixRepo("src/sock.ts", "hook_timeout_ms: 100\n");
    const t0 = Date.now();
    const s = handleHookInput(
      JSON.stringify({ session_id: "fast", cwd: r.dir, hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: file, old_string: `${G1}\n`, new_string: "" } }),
      { spawnIndexer: () => {} },
    );
    expect(Date.now() - t0).toBeLessThan(2000);
    if (s !== null) expect(JSON.parse(s).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("hook_timeout_ms: 60000 behaves normally", () => {
    const { r, file } = twoFixRepo("src/sock.ts", "hook_timeout_ms: 60000\n");
    expect(dec(edit(r, file, `${G1}\n`, "", "slow"))).toBe("deny");
  });

  // BUG (cosmetic): hook_timeout_ms accepts up to 60000, but hooks/hooks.json gives the PreToolUse
  // hook a 5 s timeout (and Stop, whose budget is 3x hook_timeout_ms, 15 s). Anything above about
  // 4500 ms is cut off by Claude Code, which reports a hook error instead of Chesterton quietly
  // allowing. Either cap hook_timeout_ms under the hooks.json timeout or raise the timeout.
  it.fails("hooks.json timeouts cover the largest hook_timeout_ms the config accepts", () => {
    const hooks = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8"));
    const pre = hooks.hooks.PreToolUse[0].hooks[0].timeout * 1000;
    const stop = hooks.hooks.Stop[0].hooks[0].timeout * 1000;
    expect(pre).toBeGreaterThan(60_000);
    expect(stop).toBeGreaterThan(3 * 60_000);
  });

  it("status reports config warnings", () => {
    const r = makeRepo();
    repo = r;
    r.write(".chesterton.yml", "mode: warn_only\nbogus: 1\nfix_patterns_extra: ['(']\n");
    const { warnings, found } = loadConfigWithWarnings(r.dir);
    expect(found).toBe(true);
    expect(warnings.length).toBe(3);
  });
});

describe("decisions", () => {
  it("speedbump: deny, then the identical retry is allowed with context", () => {
    const { r, a, file } = twoFixRepo();
    const first = edit(r, file, `${G1}\n`, "", "sb");
    expect(dec(first)).toBe("deny");
    expect(first.permissionDecisionReason).toContain(a.slice(0, 7));
    const second = edit(r, file, `${G1}\n`, "", "sb");
    expect(dec(second)).toBe("allow");
    expect(second.additionalContext).toContain(a.slice(0, 7));
  });

  it("speedbump: a slightly different retry touching the same fix is also allowed (ack is per file and fix)", () => {
    const { r, file } = twoFixRepo();
    expect(dec(edit(r, file, `${G1}\n`, "", "sb2"))).toBe("deny");
    expect(dec(edit(r, file, `${G1}\n`, "  // flush removed\n", "sb2"))).toBe("allow");
  });

  it("speedbump: an ack in one session does not carry to another session", () => {
    const { r, file } = twoFixRepo();
    expect(dec(edit(r, file, `${G1}\n`, "", "one"))).toBe("deny");
    expect(dec(edit(r, file, `${G1}\n`, "", "two"))).toBe("deny");
  });

  it("two different fixes in one edit: one deny naming both, then the retry is allowed", () => {
    const { r, a, b, file } = twoFixRepo();
    const current = r.read("src/sock.ts");
    const stripped = current.replace(`${G1}\n`, "").replace(`${H1}\n`, "");
    const s = handleHookInput(
      JSON.stringify({ session_id: "two", cwd: r.dir, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: file, content: stripped } }),
      deps(),
    );
    const o = JSON.parse(s!).hookSpecificOutput;
    expect(o.permissionDecision).toBe("deny");
    expect(o.permissionDecisionReason).toContain(a.slice(0, 7));
    expect(o.permissionDecisionReason).toContain(b.slice(0, 7));
    const again = JSON.parse(
      handleHookInput(
        JSON.stringify({ session_id: "two", cwd: r.dir, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: file, content: stripped } }),
        deps(),
      )!,
    ).hookSpecificOutput;
    expect(again.permissionDecision).toBeUndefined();
  });

  it("first fix acked, then an edit touching both: denied again for the new one only", () => {
    const { r, b, file } = twoFixRepo();
    expect(dec(edit(r, file, `${G1}\n`, "", "mix"))).toBe("deny");
    const current = r.read("src/sock.ts");
    const stripped = current.replace(`${G1}\n`, "").replace(`${H1}\n`, "");
    const o = JSON.parse(
      handleHookInput(
        JSON.stringify({ session_id: "mix", cwd: r.dir, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: file, content: stripped } }),
        deps(),
      )!,
    ).hookSpecificOutput;
    expect(o.permissionDecision).toBe("deny");
    expect(o.permissionDecisionReason).toContain(b.slice(0, 7));
  });

  it("protect path always asks, first time and on every retry, in every mode", () => {
    for (const mode of ["speedbump", "warn-only", "ask"]) {
      const { r, file } = twoFixRepo("src/payments/sock.ts", `mode: ${mode}\nprotect: ["src\\\\payments\\\\**"]\n`);
      for (let i = 0; i < 3; i++) expect(dec(edit(r, file, `${G1}\n`, "", "prot"))).toBe("ask");
      r.cleanup();
      repo = null;
    }
  }, 60_000);

  it("warn-only never denies or asks", () => {
    const { r, file } = twoFixRepo("src/sock.ts", "mode: warn-only\n");
    for (let i = 0; i < 3; i++) {
      const o = edit(r, file, `${G1}\n`, "", "wo");
      expect(dec(o)).toBe("allow");
      expect(o.additionalContext).toContain("Chesterton");
    }
  });

  it("ask mode asks every time", () => {
    const { r, file } = twoFixRepo("src/sock.ts", "mode: ask\n");
    for (let i = 0; i < 2; i++) expect(dec(edit(r, file, `${G1}\n`, "", "ask"))).toBe("ask");
  });

  it("Stop: stop_hook_active short-circuits; unknown session is silent", () => {
    const { r } = twoFixRepo();
    expect(handleHookInput(JSON.stringify({ cwd: r.dir, session_id: "x", hook_event_name: "Stop", stop_hook_active: true }), deps())).toBeNull();
    expect(handleHookInput(JSON.stringify({ cwd: r.dir, session_id: "never", hook_event_name: "Stop" }), deps())).toBeNull();
  });

  it("Stop: a file from the session that was deleted from disk does not crash the sweep", () => {
    const { r, file } = twoFixRepo();
    edit(r, file, "  sock.end();\n", "  sock.end(); // x\n", "gone");
    r.rm("src/sock.ts");
    expect(() => handleHookInput(JSON.stringify({ cwd: r.dir, session_id: "gone", hook_event_name: "Stop" }), deps())).not.toThrow();
  });
});
