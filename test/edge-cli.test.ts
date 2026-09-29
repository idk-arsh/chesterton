// Edge cases for the CLI: bad arguments, odd targets, and exit codes.
import { afterEach, describe, expect, it, vi } from "vitest";

// Real git repos on Windows are slow; give every test room when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 60_000 });
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main, type CliIO } from "../src/cli.js";
import { makeRepo, type TestRepo } from "./helpers/repo.js";

const CLI_JS = join(fileURLToPath(new URL(".", import.meta.url)), "..", "dist", "cli.js");
const GUARD = "  await sleep(50); // wait for the kernel to drain the buffer";
const BASE = ["export async function close(sock) {", "  await sock.flush();", "  sock.end();", "}", ""].join("\n");
const FIXED = ["export async function close(sock) {", "  await sock.flush();", GUARD, "  sock.end();", "}", ""].join("\n");

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()!();
    } catch {
      /* ignore */
    }
  }
});

function fixRepo(): TestRepo {
  const r = makeRepo();
  cleanups.push(() => r.cleanup());
  r.write("src/socket.ts", BASE);
  r.commit("initial");
  r.write("src/socket.ts", FIXED);
  r.write("test/socket.test.ts", "it('closes', () => {});\n");
  r.commit("fix: race on socket close (#412)");
  return r;
}

function noGit(): string {
  const d = mkdtempSync(join(tmpdir(), "chesterton-cli-nogit-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function run(argv: string[], cwd: string): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const io: CliIO = { out: (t) => (out += t + "\n"), err: (t) => (err += t + "\n"), cwd };
  return { code: main(argv, io), out, err };
}

function proc(argv: string[], cwd: string): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [CLI_JS, ...argv], { cwd, encoding: "utf8", timeout: 60_000, windowsHide: true });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("bad arguments exit 2 with a message on stderr", () => {
  it("every command", () => {
    const r = fixRepo();
    const bad: string[][] = [
      ["frobnicate"],
      ["INDEX"],
      ["index", "extra"],
      ["index", "--full=yes"],
      ["index", "--nope"],
      ["index", "-f"],
      ["why"],
      ["why", "a.ts:abc"],
      ["why", ":5"],
      ["why", "src/socket.ts:0"],
      ["why", "src/socket.ts:-3"],
      ["why", "src/socket.ts", "x"],
      ["why", "a", "1", "extra"],
      ["why", "src/socket.ts:3", "--full"],
      ["check", "extra"],
      ["check", "--base"],
      ["check", "--base="],
      ["check", "--staged=1"],
      ["check", "--staged", "--base", "main"],
      ["check", "--nope"],
      ["status", "extra"],
      ["status", "--full"],
    ];
    for (const argv of bad) {
      const res = run(argv, r.dir);
      expect({ argv, code: res.code }).toEqual({ argv, code: 2 });
      expect(res.err).toMatch(/chesterton:/);
      expect(res.out).toBe("");
    }
  });

  it("help and version forms exit 0", () => {
    for (const argv of [[], ["help"], ["--help"], ["-h"], ["--version"], ["-v"], ["version"]]) {
      expect(run(argv, process.cwd()).code).toBe(0);
    }
  });
});

describe("outside a repo and in odd repos", () => {
  it("every command outside a git repo exits 2 (index --quiet prints nothing)", () => {
    const d = noGit();
    for (const argv of [["index"], ["why", "a.ts:1"], ["check"], ["check", "--staged"], ["status"]]) {
      const res = run(argv, d);
      expect({ argv, code: res.code }).toEqual({ argv, code: 2 });
    }
    const q = run(["index", "--quiet"], d);
    expect(q.code).toBe(2);
    expect(q.out + q.err).toBe("");
  });

  it("zero-commit repo: index, status, check all behave", () => {
    const r = makeRepo();
    cleanups.push(() => r.cleanup());
    r.write("a.ts", "export const a = 1;\n");
    r.git("add", "a.ts");
    expect(run(["index"], r.dir)).toMatchObject({ code: 0 });
    expect(run(["index"], r.dir).out).toContain("No commits yet");
    const st = run(["status"], r.dir);
    expect(st.code).toBe(0);
    expect(st.out).toContain("(no commits)");
    expect(run(["check"], r.dir).code).toBe(0);
    expect(run(["check", "--staged"], r.dir).code).toBe(0);
  });
});

describe("why", () => {
  it("line inside range: exit 0 and names the fix", () => {
    const r = fixRepo();
    const res = run(["why", "src/socket.ts:3"], r.dir);
    expect(res.code).toBe(0);
    expect(res.out).toContain("race on socket close");
  });

  it("Windows absolute path with a drive colon, and `file line` as two args", () => {
    const r = fixRepo();
    expect(run(["why", `${join(r.dir, "src", "socket.ts")}:3`], r.dir).code).toBe(0);
    expect(run(["why", "src/socket.ts", "3"], r.dir).code).toBe(0);
    expect(run(["why", "src/socket.ts:3:7"], r.dir).code).toBe(0);
  });

  it("from a subdirectory with a relative path", () => {
    const r = fixRepo();
    const res = run(["why", "socket.ts:3"], join(r.dir, "src"));
    expect(res.code).toBe(0);
    expect(res.out).toContain("src/socket.ts:3");
  });

  it("file outside the repo: exit 2", () => {
    const r = fixRepo();
    const d = noGit();
    writeFileSync(join(d, "x.ts"), "a\n");
    expect(run(["why", `${join(d, "x.ts")}:1`], r.dir).code).toBe(2);
    expect(run(["why", "../outside.ts:1"], r.dir).code).toBe(2);
  });

  it("untracked file: says it is not tracked", () => {
    const r = fixRepo();
    r.write("src/new.ts", "const a = 1;\nconst b = 2;\n");
    const res = run(["why", "src/new.ts:2"], r.dir);
    expect(res.out).toContain("Not tracked by git yet");
  });

  it("out of range line: explains the file length on stderr", () => {
    const r = fixRepo();
    const res = run(["why", "src/socket.ts:999"], r.dir);
    expect(res.err).toContain("no such line");
    expect(res.out).toBe("");
  });

  // Was a bug (cosmetic): `why` on a line past the end of the file, on a missing file, or on a directory
  // prints an error-ish message to stdout and exits 0. Help says usage or setup errors exit 2, so a
  // script cannot tell "here is the history" from "that line does not exist".
  it("out of range line, missing file and directory exit non-zero", () => {
    const r = fixRepo();
    expect(run(["why", "src/socket.ts:999"], r.dir).code).not.toBe(0);
    expect(run(["why", "src/missing.ts:1"], r.dir).code).not.toBe(0);
    expect(run(["why", "src:1"], r.dir).code).not.toBe(0);
  });

  it("missing index: still answers, says there is no index", () => {
    const r = fixRepo();
    const res = run(["why", "src/socket.ts:3"], r.dir);
    expect(res.code).toBe(0);
    expect(res.out).toContain("No Chesterton index yet");
  });
});

describe("check", () => {
  it("no changes: Nothing to check, exit 0", () => {
    const r = fixRepo();
    const res = run(["check"], r.dir);
    expect(res).toMatchObject({ code: 0 });
    expect(res.out).toContain("Nothing to check");
    expect(run(["check", "--staged"], r.dir).code).toBe(0);
  });

  it("--base with a revision that does not exist: exit 2", () => {
    const r = fixRepo();
    for (const rev of ["nope", "HEAD~99", "--output=x.txt", "deadbeef"]) {
      const res = run(["check", "--base", rev], r.dir);
      expect({ rev, code: res.code }).toEqual({ rev, code: 2 });
      expect(res.err).toContain("unknown revision");
    }
  });

  it("--base whose value looks like a git option does not reach git as an option", () => {
    const r = fixRepo();
    run(["check", "--base=--output=pwned.txt"], r.dir);
    expect(spawnSync("git", ["status", "--porcelain"], { cwd: r.dir, encoding: "utf8" }).stdout).not.toContain("pwned");
  });

  it("strong hit: process exit code is 1; clean: 0", () => {
    const r = fixRepo();
    expect(proc(["check"], r.dir).code).toBe(0);
    r.write("src/socket.ts", BASE);
    const res = proc(["check"], r.dir);
    expect(res.code).toBe(1);
    expect(res.out).toContain("STRONG");
    r.git("add", "-A");
    expect(proc(["check", "--staged"], r.dir).code).toBe(1);
  });

  it("uncommitted rename plus removing the fix is still caught", () => {
    const r = fixRepo();
    r.mv("src/socket.ts", "src/sock2.ts");
    r.write("src/sock2.ts", BASE);
    r.git("add", "-A");
    expect(run(["check"], r.dir).code).toBe(1);
    expect(run(["check", "--staged"], r.dir).code).toBe(1);
  });

  it("--base on a branch that removed the fix: exit 1", () => {
    const r = fixRepo();
    r.git("checkout", "-q", "-b", "cleanup");
    r.write("src/socket.ts", BASE);
    r.commit("tidy socket close");
    expect(run(["check", "--base", "main"], r.dir).code).toBe(1);
  });

  it("untracked new file is not checked (documented)", () => {
    const r = fixRepo();
    r.write("src/other.ts", FIXED);
    expect(run(["check"], r.dir).out).toContain("Nothing to check");
  });

  it("binary and deleted files in the diff do not crash check", () => {
    const r = fixRepo();
    r.write("img.bin", "a\u0000b");
    r.commit("add bin");
    r.write("img.bin", "c\u0000d");
    r.rm("test/socket.test.ts");
    const res = run(["check"], r.dir);
    expect([0, 1]).toContain(res.code);
  });
});

describe("status", () => {
  it("without an index: exit 0 and says not built", () => {
    const r = fixRepo();
    const res = run(["status"], r.dir);
    expect(res.code).toBe(0);
    expect(res.out).toContain("not built yet");
  });

  it("with an index, then after HEAD moves", () => {
    const r = fixRepo();
    run(["index"], r.dir);
    expect(run(["status"], r.dir).out).toContain("Up to date:  yes");
    r.write("README.md", "x\n");
    r.commit("docs");
    expect(run(["status"], r.dir).out).toContain("HEAD has moved");
  });

  it("from a nested subdirectory", () => {
    const r = fixRepo();
    mkdirSync(join(r.dir, "src", "deep"), { recursive: true });
    expect(run(["status"], join(r.dir, "src", "deep")).code).toBe(0);
  });
});
