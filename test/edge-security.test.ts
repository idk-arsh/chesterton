// Security review checks: no shell, no network, hostile file names cannot become git options.
import { afterEach, describe, expect, it, vi } from "vitest";

// Real git repos on Windows are slow; give every test room when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 60_000 });
import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleHookInput } from "../src/hook.js";
import { buildIndex } from "../src/index-builder.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { main, type CliIO } from "../src/cli.js";
import { makeRepo, type TestRepo } from "./helpers/repo.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const GUARD = "  if (sock.pending > 0) await flush(sock);";
const BASE = ["function close(sock) {", "  sock.end();", "}", ""].join("\n");
const FIXED = ["function close(sock) {", GUARD, "  sock.end();", "}", ""].join("\n");

let repo: TestRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

const deps = () => ({ startedAt: Date.now() + 60_000, spawnIndexer: () => {} });
const quiet: CliIO = { out: () => {}, err: () => {}, cwd: "" };

describe("static review", () => {
  const srcFiles = readdirSync(join(ROOT, "src")).filter((f) => f.endsWith(".ts"));
  const src = srcFiles.map((f) => [f, readFileSync(join(ROOT, "src", f), "utf8")] as const);
  const bundles = ["hook.js", "cli.js", "hook-main.js", "cli-main.js"].map((f) => [f, readFileSync(join(ROOT, "dist", f), "utf8")] as const);

  it("only node:fs, path, url, crypto, child_process, os and module are imported by the bundles", () => {
    for (const [name, text] of bundles) {
      const mods = new Set([...text.matchAll(/from\s+"(node:[a-z_/]+|[a-z_/]+)"/g)].map((m) => m[1]));
      for (const m of mods) expect({ name, m }).toEqual({ name, m: expect.stringMatching(/^node:(fs|path|url|crypto|child_process|os|module)$/) });
    }
  });

  it("no network APIs anywhere in src or dist", () => {
    for (const [name, text] of [...src, ...bundles]) {
      expect({ name, hit: /node:(net|http|https|http2|dgram|tls|dns)\b|\bfetch\(|WebSocket|XMLHttpRequest/.test(text) }).toEqual({ name, hit: false });
    }
  });

  it("no shell: child processes are spawned with argument arrays, never through a shell", () => {
    for (const [name, text] of src) {
      expect({ name, hit: /shell\s*:\s*true|\bexecSync\(|\bexecFileSync\(/.test(text) }).toEqual({ name, hit: false });
      // Only spawn / spawnSync are imported from child_process (no exec, which always uses a shell).
      for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"node:child_process"/g)) {
        for (const n of m[1]!.split(",").map((x) => x.trim()).filter(Boolean)) {
          expect({ name, n }).toEqual({ name, n: expect.stringMatching(/^(spawn|spawnSync)$/) });
        }
      }
      for (const m of text.matchAll(/\bspawn(?:Sync)?\(([^,]+),\s*([^\s])/g)) {
        // Second argument must be an array literal.
        expect({ name, call: m[0], ok: m[2] === "[" }).toEqual({ name, call: m[0], ok: true });
      }
    }
  });
});

describe("hostile file names", () => {
  function hostileRepo(name: string): TestRepo {
    const r = makeRepo();
    repo = r;
    r.write(name, BASE);
    r.commit("initial");
    r.write(name, FIXED);
    r.write("test/x.test.ts", "it('x', () => {});\n");
    r.commit("fix: race on close (#1)");
    buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true });
    return r;
  }

  for (const name of ["--output=pwned.ts", "-L1,1", "--exec=calc", "$(whoami).ts", "a;b&c d.ts", "`x`.ts", "%PATH%.ts"]) {
    it(`file named ${JSON.stringify(name)}: detected, no option injection`, () => {
      const r = hostileRepo(name);
      const input = (sid: string) =>
        JSON.stringify({
          session_id: sid,
          cwd: r.dir,
          hook_event_name: "PreToolUse",
          tool_name: "Edit",
          tool_input: { file_path: join(r.dir, name), old_string: `${GUARD}\n`, new_string: "" },
        });
      const out = handleHookInput(input("h"), deps());
      expect(JSON.parse(out!).hookSpecificOutput.permissionDecision).toBe("deny");
      // Stop sweep, why and check with the same name.
      r.write(name, BASE);
      handleHookInput(JSON.stringify({ cwd: r.dir, session_id: "h", hook_event_name: "Stop" }), deps());
      main(["why", "--", `${name}:2`], { ...quiet, cwd: r.dir });
      main(["check"], { ...quiet, cwd: r.dir });
      expect(existsSync(join(r.dir, "pwned.ts"))).toBe(false);
      expect(existsSync(join(r.dir, "calc"))).toBe(false);
    });
  }
});

describe("binary planting", () => {
  it.runIf(process.platform === "win32")("a git.exe planted at the repo root is not the git that runs", () => {
    const r = makeRepo();
    repo = r;
    r.write("src/sock.ts", BASE);
    r.commit("initial");
    r.write("src/sock.ts", FIXED);
    r.write("test/x.test.ts", "it('x', () => {});\n");
    r.commit("fix: race on close (#1)");
    buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true });
    // hostname.exe ignores its arguments and prints the machine name, so a hit would break every git call.
    copyFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "hostname.exe"), join(r.dir, "git.exe"));
    const out = handleHookInput(
      JSON.stringify({
        session_id: "plant",
        cwd: r.dir,
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: join(r.dir, "src", "sock.ts"), old_string: `${GUARD}\n`, new_string: "" },
      }),
      deps(),
    );
    expect(JSON.parse(out!).hookSpecificOutput.permissionDecision).toBe("deny");
  });
});
