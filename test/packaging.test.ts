// Plugin packaging: the dist launchers.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe("dist launchers", () => {
  it("turn on the compile cache only when Node has it, and never throw doing so", () => {
    for (const f of ["hook.js", "cli.js"]) {
      const text = readFileSync(join(ROOT, "dist", f), "utf8");
      expect(text).toMatch(/typeof module\.enableCompileCache === "function"/);
      expect(text).toMatch(/try \{[\s\S]*enableCompileCache\(\);[\s\S]*\} catch/);
    }
  });

  it("hook launcher fails open when the bundle is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "chesterton-launcher-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    copyFileSync(join(ROOT, "dist", "hook.js"), join(dir, "hook.js"));
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    const res = spawnSync(process.execPath, [join(dir, "hook.js")], { input: "{}", encoding: "utf8", windowsHide: true });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("");
  });

  it("cli launcher runs the bundle", () => {
    const res = spawnSync(process.execPath, [join(ROOT, "dist", "cli.js"), "--version"], { encoding: "utf8", windowsHide: true });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
