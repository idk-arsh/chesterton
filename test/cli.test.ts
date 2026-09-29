import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatFinding, main, parseFileLine, VERSION, type CliIO } from "../src/cli.js";
import { makeRepo, type TestRepo } from "./helpers/repo.js";

function run(argv: string[], cwd: string): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const io: CliIO = { out: (t) => (out += t + "\n"), err: (t) => (err += t + "\n"), cwd };
  const code = main(argv, io);
  return { code, out, err };
}

function fixtureRepo(): TestRepo {
  const repo = makeRepo();
  repo.write(
    "src/socket.ts",
    ["export async function close(sock) {", "  await sock.flush();", "  sock.end();", "}", ""].join("\n"),
  );
  repo.commit("initial");
  repo.write(
    "src/socket.ts",
    [
      "export async function close(sock) {",
      "  await sock.flush();",
      "  await sleep(50); // wait for the kernel to drain the buffer",
      "  sock.end();",
      "}",
      "",
    ].join("\n"),
  );
  repo.write("test/socket.test.ts", "it('closes cleanly under load', () => {});\n");
  repo.commit("fix: race on socket close (#412)");
  return repo;
}

const SIMPLIFIED = ["export async function close(sock) {", "  await sock.flush();", "  sock.end();", "}", ""].join("\n");

describe("formatFinding", () => {
  it("caps the Tests list at 3 plus a count", () => {
    const out = formatFinding({
      kind: "removes-fix",
      strength: "strong",
      file: "src/a.py",
      lines: ["x = guard(y)"],
      fix: {
        sha: "a".repeat(40),
        date: "2025-01-01T00:00:00Z",
        author: "Jane",
        subject: "Fix CI and build failures (#7190)",
        score: 6,
        reasons: ["message says 'fix'"],
        refs: ["#7190"],
        testFiles: ["t/1.py", "t/2.py", "t/3.py", "t/4.py", "t/5.py"],
      },
    });
    expect(out).toContain("  Tests: t/1.py, t/2.py, t/3.py and 2 more");
    expect(out).not.toContain("t/4.py");
  });
});

describe("cli basics", () => {
  it("prints the version, matching package.json", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
    expect(run(["--version"], process.cwd())).toMatchObject({ code: 0, out: `${VERSION}\n` });
  });

  it("prints help with no arguments", () => {
    const r = run([], process.cwd());
    expect(r.code).toBe(0);
    expect(r.out).toContain("chesterton why <file>:<line>");
  });

  it("exits 2 on usage errors", () => {
    expect(run(["frobnicate"], process.cwd()).code).toBe(2);
    expect(run(["index", "--bogus"], process.cwd()).code).toBe(2);
    expect(run(["why"], process.cwd()).code).toBe(2);
    expect(run(["why", "file-without-line"], process.cwd()).code).toBe(2);
    expect(run(["check", "--base"], process.cwd()).code).toBe(2);
    expect(run(["check", "--staged", "--base", "main"], process.cwd()).code).toBe(2);
  });

  it("parses file:line forms", () => {
    expect(parseFileLine(["src/a.ts:42"])).toEqual({ file: "src/a.ts", line: 42 });
    expect(parseFileLine(["C:\\x\\a.ts:7"])).toEqual({ file: "C:\\x\\a.ts", line: 7 });
    expect(parseFileLine(["src/a.ts:42:5"])).toEqual({ file: "src/a.ts", line: 42 });
    expect(parseFileLine(["src/a.ts", "3"])).toEqual({ file: "src/a.ts", line: 3 });
    expect(() => parseFileLine(["src/a.ts:0"])).toThrow();
  });

  it("says so outside a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "chesterton-norepo-"));
    try {
      const r = run(["status"], dir);
      expect(r.code).toBe(2);
      expect(r.err).toContain("not inside a git repository");
      expect(run(["index", "--quiet"], dir)).toMatchObject({ code: 2, err: "" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cli on a repo", () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it("index, status, why", () => {
    repo = fixtureRepo();
    const before = run(["status"], repo.dir);
    expect(before.code).toBe(0);
    expect(before.out).toContain("not built yet");

    const idx = run(["index"], repo.dir);
    expect(idx.code).toBe(0);
    expect(idx.out).toMatch(/Indexed 1 fix commit across 2 files/);
    expect(run(["index", "--quiet"], repo.dir)).toMatchObject({ code: 0, out: "" });

    const status = run(["status"], repo.dir);
    expect(status.out).toContain("Up to date:  yes");
    expect(status.out).toContain("Fix commits: 1");

    repo.write("README.md", "x\n");
    repo.commit("docs");
    expect(run(["status"], repo.dir).out).toContain("Up to date:  no");

    // why works from a subdirectory with a path relative to it.
    mkdirSync(join(repo.dir, "src"), { recursive: true });
    const why = run(["why", "socket.ts:3"], join(repo.dir, "src"));
    expect(why.code).toBe(0);
    expect(why.out).toContain("src/socket.ts:3");
    expect(why.out).toContain("fix: race on socket close (#412)");
  });

  it("why rejects files outside the repo", () => {
    repo = fixtureRepo();
    const r = run(["why", join(tmpdir(), "elsewhere.ts") + ":1"], repo.dir);
    expect(r.code).toBe(2);
    expect(r.err).toContain("outside this repository");
  });

  it("check exits 1 when uncommitted changes delete a fix", () => {
    repo = fixtureRepo();
    repo.write("src/socket.ts", SIMPLIFIED);
    const r = run(["check"], repo.dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("STRONG  src/socket.ts: removes lines added by a bug fix");
    expect(r.out).toContain("await sleep(50);");
    expect(r.out).toContain("Refs: #412");
  });

  it("check --staged only sees staged changes", () => {
    repo = fixtureRepo();
    repo.write("other.ts", "const unrelated = true;\n");
    repo.git("add", "other.ts");
    repo.write("src/socket.ts", SIMPLIFIED); // not staged
    const clean = run(["check", "--staged"], repo.dir);
    expect(clean.code).toBe(0);
    expect(clean.out).toContain("No past fixes touched");
    repo.git("add", "src/socket.ts");
    expect(run(["check", "--staged"], repo.dir).code).toBe(1);
  });

  it("check --base looks at the branch since the merge base", () => {
    repo = fixtureRepo();
    repo.git("checkout", "-q", "-b", "cleanup");
    repo.write("src/socket.ts", SIMPLIFIED);
    repo.commit("refactor: simplify close");
    const r = run(["check", "--base", "main"], repo.dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("removes lines added by a bug fix");
  });

  it("check exits 0 with nothing to check", () => {
    repo = fixtureRepo();
    expect(run(["check"], repo.dir)).toMatchObject({ code: 0, out: "Nothing to check.\n" });
  });
});
