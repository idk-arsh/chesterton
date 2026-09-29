// Hardening against a hostile repo: config that could hang the hook or the indexer, the index
// watchdog, and which git binary runs on Windows.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { GitError, gitExecutable, runGit } from "../src/git.js";
import { buildIndex } from "../src/index-builder.js";
import { hasNestedRepeat, parseConfig } from "../src/config.js";
import { matchGlob } from "../src/decide.js";
import { INDEX_WATCHDOG_MS, main, type CliIO } from "../src/cli.js";
import { makeRepo, type TestRepo } from "./helpers/repo.js";

vi.setConfig({ testTimeout: 60_000 });

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
let repo: TestRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

describe("repo config that could hang the hook or the indexer", () => {
  it("protect globs match in linear time", () => {
    const glob = Array(14).fill("**").join("/") + "/zz";
    const path = Array(40).fill("a").join("/") + "/b.ts";
    const t = Date.now();
    expect(matchGlob(path, glob)).toBe(false);
    expect(matchGlob(`${path}/zz`, glob)).toBe(true);
    expect(matchGlob("zz", "**/**/zz")).toBe(true);
    expect(matchGlob("a/b/zz", "**/**/zz")).toBe(true);
    expect(matchGlob("a/b/zzz", "**/**/zz")).toBe(false);
    expect(matchGlob("a".repeat(200), `${"*a".repeat(30)}*b`)).toBe(false);
    expect(Date.now() - t).toBeLessThan(500);
  });

  it.each([
    ["(a+)+$", true],
    ["(a*)*", true],
    ["(\\w+\\s?){3,}", true],
    ["((a+))+", true],
    ["(a{2})+", true],
    ["(ab)+", false],
    ["(a+)?", false],
    ["(a{0,1})+", false],
    ["[(a+)]+", false],
    ["\\(a+\\)+", false],
    ["SEV\\d+", false],
    ["(sev|p)[0-3]", false],
    ["post-?mortem", false],
  ])("hasNestedRepeat(%s) is %s", (src, want) => {
    expect(hasNestedRepeat(src)).toBe(want);
  });

  it("fix_patterns_extra skips nested repeats with a warning and keeps the rest", () => {
    const { config, warnings } = parseConfig('fix_patterns_extra: ["^(a+)+$", "SEV\\\\d"]');
    expect(config.fixPatternsExtra).toEqual(["SEV\\d"]);
    expect(warnings.join("\n")).toContain("(a+)+");
  });

  it("indexing a repo whose config holds a runaway regex finishes", () => {
    const r = makeRepo();
    repo = r;
    r.write(".chesterton.yml", 'fix_patterns_extra: ["^(a+)+$"]\n');
    r.write("f.js", "x\n");
    r.commit("a".repeat(40) + "!");
    const cfg = parseConfig(readFileSync(join(r.dir, ".chesterton.yml"), "utf8")).config;
    const t = Date.now();
    buildIndex(r.dir, cfg, { full: true });
    expect(Date.now() - t).toBeLessThan(20_000);
  });
});

describe("index watchdog", () => {
  let dir = "";
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "chesterton-watchdog-"));
    await build({
      entryPoints: [join(ROOT, "src", "watchdog.ts")],
      outfile: join(dir, "watchdog.mjs"),
      bundle: true,
      platform: "node",
      target: "node18",
      format: "esm",
      logLevel: "silent",
    });
    writeFileSync(
      join(dir, "stuck.mjs"),
      'import { armWatchdog } from "./watchdog.mjs";\narmWatchdog(300);\n/^(a+)+$/.test("a".repeat(60) + "!");\nconsole.log("finished");\n',
    );
  }, 60_000);
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("kills a process stuck in a regex", () => {
    const t = Date.now();
    const res = spawnSync(process.execPath, [join(dir, "stuck.mjs")], { encoding: "utf8", timeout: 30_000, windowsHide: true });
    expect(res.error).toBeUndefined();
    expect(res.stdout).not.toContain("finished");
    expect(res.status === 0).toBe(false);
    expect(Date.now() - t).toBeLessThan(15_000);
  });

  it("index arms it with the documented limit; other commands do not", () => {
    const r = makeRepo();
    repo = r;
    r.write("a.js", "x\n");
    r.commit("initial");
    const armed: number[] = [];
    const io: CliIO = { out: () => {}, err: () => {}, cwd: r.dir, watchdog: (ms) => armed.push(ms) };
    expect(main(["index", "--quiet"], io)).toBe(0);
    expect(main(["status"], io)).toBe(0);
    expect(armed).toEqual([INDEX_WATCHDOG_MS]);
  });
});

describe("which git runs", () => {
  const savedPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = savedPath;
  });

  it.runIf(process.platform === "win32")("on Windows, git is an absolute path from PATH, never a file in the working directory", () => {
    const git = gitExecutable();
    expect(git).not.toBeNull();
    expect(isAbsolute(git!)).toBe(true);
    expect(git!.toLowerCase()).toMatch(/git\.(exe|com)$/);

    // A relative PATH entry is how a planted binary would sneak back in; it is skipped.
    const dir = mkdtempSync(join(tmpdir(), "chesterton-plant-"));
    try {
      copyFileSync(process.execPath, join(dir, "git.exe"));
      process.env.PATH = `.;${dir.slice(0, 2)}relative;${savedPath}`;
      expect(gitExecutable()).toBe(git);
      expect(runGit(["--version"], dir)).toMatch(/^git version/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")("on Windows, no git on PATH means a GitError, not a lookup in the working directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "chesterton-plant-"));
    try {
      copyFileSync(process.execPath, join(dir, "git.exe"));
      process.env.PATH = "";
      expect(gitExecutable()).toBeNull();
      expect(() => runGit(["--version"], dir)).toThrow(GitError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")("elsewhere, the plain name is used (execvp only searches PATH)", () => {
    expect(gitExecutable()).toBe("git");
  });
});
