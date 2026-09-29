// Edge cases for the environment the hook runs in: odd repos, odd paths, odd files.
import { afterEach, describe, expect, it, vi } from "vitest";

// Real git repos on Windows are slow; give every test room when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 60_000 });
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { handleHookInput } from "../src/hook.js";
import { buildIndex } from "../src/index-builder.js";
import { indexDir, loadIndex } from "../src/index-store.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { runGit } from "../src/git.js";
import { makeRepo, type TestRepo } from "./helpers/repo.js";

const GUARD = "  if (sock.pending > 0) await flush(sock);";
const BEFORE = ["function close(sock) {", "  sock.end();", "  cleanup(sock);", "}"];
const AFTER = ["function close(sock) {", GUARD, "  sock.end();", "  cleanup(sock);", "}"];

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

function track(r: TestRepo): TestRepo {
  cleanups.push(() => r.cleanup());
  return r;
}

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** Repo where `path` got a guard line from a fix commit. */
function fixRepo(path = "src/sock.ts", eol = "\n", opts: { bom?: boolean; trailingNewline?: boolean; index?: boolean } = {}): TestRepo {
  const r = track(makeRepo());
  const enc = (lines: string[]) => (opts.bom ? "﻿" : "") + lines.join(eol) + (opts.trailingNewline === false ? "" : eol);
  r.write(path, enc(BEFORE));
  r.commit("initial");
  r.write(path, enc(AFTER));
  r.write("test/sock.test.ts", "it('flushes', () => {});\n");
  r.commit("fix: race on socket close (#412)");
  if (opts.index !== false) buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true });
  return r;
}

const deps = () => ({ startedAt: Date.now() + 60_000, spawnIndexer: () => {} });

function edit(cwd: string, filePath: string, oldS: string, newS: string, sid = "env"): string | null {
  return handleHookInput(
    JSON.stringify({
      session_id: sid,
      cwd,
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: filePath, old_string: oldS, new_string: newS },
    }),
    deps(),
  );
}

function write(cwd: string, filePath: string, content: string, sid = "env"): string | null {
  return handleHookInput(
    JSON.stringify({ session_id: sid, cwd, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: filePath, content } }),
    deps(),
  );
}

const decision = (s: string | null) => (s === null ? null : JSON.parse(s).hookSpecificOutput.permissionDecision ?? "allow");

describe("repo shapes", () => {
  it("cwd that is not a git repo: null for every event", () => {
    const d = tmp("chesterton-nogit-");
    writeFileSync(join(d, "a.ts"), GUARD + "\n");
    for (const ev of ["PreToolUse", "SessionStart", "Stop"]) {
      expect(
        handleHookInput(
          JSON.stringify({ cwd: d, hook_event_name: ev, tool_name: "Edit", tool_input: { file_path: join(d, "a.ts"), old_string: GUARD, new_string: "" } }),
          deps(),
        ),
      ).toBeNull();
    }
  });

  it("git repo with zero commits: PreToolUse null, SessionStart null, index is empty", () => {
    const r = track(makeRepo());
    r.write("a.ts", AFTER.join("\n") + "\n");
    expect(edit(r.dir, join(r.dir, "a.ts"), GUARD + "\n", "")).toBeNull();
    let spawned = 0;
    expect(
      handleHookInput(JSON.stringify({ cwd: r.dir, hook_event_name: "SessionStart" }), { spawnIndexer: () => spawned++ }),
    ).toBeNull();
    expect(spawned).toBe(1);
    expect(buildIndex(r.dir, { ...DEFAULT_CONFIG }).head).toBe("");
    expect(handleHookInput(JSON.stringify({ cwd: r.dir, session_id: "z", hook_event_name: "Stop" }), deps())).toBeNull();
  });

  it("detached HEAD: index builds and the deny still fires", () => {
    const r = fixRepo("src/sock.ts", "\n", { index: false });
    r.git("checkout", "-q", "--detach", "HEAD");
    const idx = buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true });
    expect(Object.keys(idx.commits)).toHaveLength(1);
    expect(decision(edit(r.dir, join(r.dir, "src/sock.ts"), GUARD + "\n", ""))).toBe("deny");
  });

  it("bare repo path as cwd: null", () => {
    const r = fixRepo();
    const bare = join(tmp("chesterton-bare-"), "b.git");
    runGit(["clone", "-q", "--bare", r.dir, bare], process.cwd());
    expect(handleHookInput(JSON.stringify({ cwd: bare, hook_event_name: "SessionStart" }), deps())).toBeNull();
    expect(edit(bare, join(bare, "HEAD"), "ref", "x")).toBeNull();
  });

  it("git worktree: separate index per worktree, deny fires inside the worktree", () => {
    const r = fixRepo();
    const wt = join(tmp("chesterton-wt-"), "wt");
    r.git("worktree", "add", "-q", "-b", "side", wt);
    runGit(["config", "user.name", "T"], wt);
    const idx = buildIndex(wt, { ...DEFAULT_CONFIG }, { full: true });
    expect(Object.keys(idx.commits)).toHaveLength(1);
    expect(indexDir(wt)).not.toBe(indexDir(r.dir));
    expect(decision(edit(wt, join(wt, "src/sock.ts"), GUARD + "\n", ""))).toBe("deny");
    // The main checkout's index is untouched.
    expect(loadIndex(r.dir)?.head).toBe(r.git("rev-parse", "HEAD").trim());
  });

  // BUG (wrong result): in a shallow clone the boundary commit looks like it added every line of every
  // file. When that commit's message reads like a fix, every untouched line in the repo is treated as
  // "added by a fix" and any removal is a strong hit.
  // Repro: 6 commits growing lib.js, then "fix: crash on null input" adds one line, then an unrelated
  // commit; `git clone --depth 2`; `chesterton index`; delete any old line; `chesterton check` -> STRONG.
  it.fails("shallow clone: boundary commit does not claim every line as a fix", () => {
    const src = track(makeRepo());
    const lines: string[] = [];
    for (let i = 1; i <= 6; i++) {
      lines.push(`const value${i} = computeSomething(${i});`);
      src.write("lib.js", lines.join("\n") + "\n");
      src.commit(`feature step ${i}`);
    }
    lines.push("const guardAgainstNull = input ?? defaults;");
    src.write("lib.js", lines.join("\n") + "\n");
    src.commit("fix: crash on null input");
    src.write("other.txt", "x\n");
    src.commit("docs tweak");

    const dir = join(tmp("chesterton-shallow-"), "clone");
    runGit(["-c", "core.autocrlf=false", "clone", "-q", "--depth", "2", pathToFileURL(src.dir).href, dir], process.cwd());
    buildIndex(dir, { ...DEFAULT_CONFIG }, { full: true });
    // value2 was written by "feature step 2", which is not in the shallow history at all.
    const out = edit(dir, join(dir, "lib.js"), "const value2 = computeSomething(2);\n", "", "shallow");
    expect(out === null || decision(out) !== "deny").toBe(true);
  });

  it("shallow clone: the real fix line is still caught", () => {
    const src = track(makeRepo());
    src.write("lib.js", "const value1 = computeSomething(1);\n");
    src.commit("feature");
    src.write("lib.js", "const value1 = computeSomething(1);\nconst guardAgainstNull = input ?? defaults;\n");
    src.commit("fix: crash on null input");
    src.write("other.txt", "x\n");
    src.commit("docs tweak");
    const dir = join(tmp("chesterton-shallow2-"), "clone");
    runGit(["-c", "core.autocrlf=false", "clone", "-q", "--depth", "2", pathToFileURL(src.dir).href, dir], process.cwd());
    buildIndex(dir, { ...DEFAULT_CONFIG }, { full: true });
    expect(decision(edit(dir, join(dir, "lib.js"), "const guardAgainstNull = input ?? defaults;\n", "", "s2"))).toBe("deny");
  });

  // BUG (wrong result, silent miss): a file inside a submodule, edited from the parent repo's session,
  // is checked against the parent repo. The parent has no history for it, so a fix in the submodule is
  // never seen. The hook should resolve the repo from the file's own directory.
  it.fails("submodule file edited from the parent repo is checked against the submodule history", () => {
    const sub = fixRepo();
    const parent = track(makeRepo());
    parent.write("README.md", "parent\n");
    parent.commit("initial");
    parent.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", sub.dir, "sub");
    parent.commit("add submodule");
    const subDir = join(parent.dir, "sub");
    buildIndex(subDir, { ...DEFAULT_CONFIG }, { full: true });
    const out = edit(parent.dir, join(subDir, "src", "sock.ts"), GUARD + "\n", "", "sm");
    expect(decision(out)).toBe("deny");
  });

  it("submodule file edited from the parent repo: no crash", () => {
    const sub = fixRepo();
    const parent = track(makeRepo());
    parent.write("README.md", "parent\n");
    parent.commit("initial");
    parent.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", sub.dir, "sub");
    parent.commit("add submodule");
    buildIndex(parent.dir, { ...DEFAULT_CONFIG }, { full: true });
    expect(() => edit(parent.dir, join(parent.dir, "sub", "src", "sock.ts"), GUARD + "\n", "", "sm2")).not.toThrow();
  });

  it("repo path with spaces and unicode: deny fires", () => {
    const r = fixRepo("src/sock.ts", "\n", { index: false });
    const parent = tmp("chesterton-spaces-");
    const moved = join(parent, "my repo ünïcødé 日本");
    renameSync(r.dir, moved);
    cleanups.push(() => rmSync(moved, { recursive: true, force: true }));
    buildIndex(moved, { ...DEFAULT_CONFIG }, { full: true });
    expect(decision(edit(moved, join(moved, "src", "sock.ts"), GUARD + "\n", ""))).toBe("deny");
  });

  // BUG (wrong result, silent miss): git resolves junctions and symlinks in --show-toplevel, but the
  // hook compares the tool's file_path (which uses the path the session was opened with) against it
  // without resolving links, so every edit looks like it is outside the repo. On macOS the same thing
  // happens for repos under /tmp or /var (symlinks to /private/...), and on Linux for symlinked homes.
  it.fails("repo opened through a junction or symlink: deny still fires", () => {
    const r = fixRepo();
    const link = join(tmp("chesterton-link-"), "linked");
    symlinkSync(r.dir, link, process.platform === "win32" ? "junction" : "dir");
    cleanups.push(() => rmSync(link, { force: true, recursive: false }));
    expect(decision(edit(link, join(link, "src", "sock.ts"), GUARD + "\n", "", "link"))).toBe("deny");
  });

  it("very long repo path (> 260 chars): hook fails open, never throws", () => {
    // Windows cannot start a process whose cwd is longer than MAX_PATH, so every git call fails there
    // (spawnSync git ENOENT). That is a platform limit; what matters is the hook stays silent.
    const r = fixRepo("a.ts");
    let deep = tmp("chesterton-long-");
    while (deep.length < 270) deep = join(deep, "d".repeat(40));
    mkdirSync(join(deep, ".."), { recursive: true });
    renameSync(r.dir, deep);
    cleanups.push(() => rmSync(deep, { recursive: true, force: true }));
    let out: string | null = "not run";
    expect(() => {
      out = edit(deep, join(deep, "a.ts"), GUARD + "\n", "", "x".repeat(120));
    }).not.toThrow();
    if (process.platform === "win32") expect(out).toBeNull();
    else expect(decision(out)).toBe("deny");
  });
});

describe("path shapes", () => {
  it("file path with spaces, unicode and a single quote: deny fires", () => {
    const p = "src/my dir/sóck 'x' 日本.ts";
    const r = fixRepo(p);
    expect(decision(edit(r.dir, join(r.dir, ...p.split("/")), GUARD + "\n", ""))).toBe("deny");
  });

  it("Windows path forms: backslashes, forward slashes, lower-case drive, Git Bash /c/ style", () => {
    const r = fixRepo();
    const abs = join(r.dir, "src", "sock.ts");
    const forms = [abs, abs.replace(/\\/g, "/")];
    if (process.platform === "win32") {
      forms.push(abs[0]!.toLowerCase() + abs.slice(1));
      forms.push("/" + abs[0]!.toLowerCase() + abs.slice(2).replace(/\\/g, "/"));
    }
    forms.forEach((f, i) => expect(decision(edit(r.dir, f, GUARD + "\n", "", `form${i}`))).toBe("deny"));
  });

  // BUG (wrong result, low): on case-insensitive file systems (Windows, default macOS) a file_path whose
  // directory or file name case differs from git's ("SRC/Sock.ts" for "src/sock.ts") reads fine from
  // disk but misses the index key and git blame, so the fix is not seen.
  it.fails("file_path with different letter case on a case-insensitive file system still matches", () => {
    if (process.platform !== "win32" && process.platform !== "darwin") throw new Error("case-sensitive FS");
    const r = fixRepo();
    expect(decision(edit(r.dir, join(r.dir, "SRC", "Sock.ts"), GUARD + "\n", "", "case"))).toBe("deny");
  });

  it("file symlink inside the repo pointing at a fixed file: no crash (skipped where symlinks need admin)", () => {
    const r = fixRepo();
    try {
      symlinkSync("sock.ts", join(r.dir, "src", "link.ts"), "file");
    } catch {
      return; // EPERM on Windows without developer mode
    }
    expect(() => edit(r.dir, join(r.dir, "src", "link.ts"), GUARD + "\n", "", "symf")).not.toThrow();
  });

  it("relative file_path resolves against the repo root", () => {
    const r = fixRepo();
    expect(decision(edit(r.dir, "src/sock.ts", GUARD + "\n", "", "rel"))).toBe("deny");
  });

  it("file outside the repo: null", () => {
    const r = fixRepo();
    const other = tmp("chesterton-outside-");
    writeFileSync(join(other, "sock.ts"), AFTER.join("\n") + "\n");
    expect(edit(r.dir, join(other, "sock.ts"), GUARD + "\n", "")).toBeNull();
    expect(edit(r.dir, join(r.dir, "..", "sock.ts"), GUARD + "\n", "")).toBeNull();
  });

  it("file inside .git: null", () => {
    const r = fixRepo();
    expect(edit(r.dir, join(r.dir, ".git", "config"), "[core]", "[x]")).toBeNull();
    expect(write(r.dir, join(r.dir, ".git", "hooks", "pre-commit"), "echo hi\n")).toBeNull();
  });

  it("gitignored file and untracked file: null", () => {
    const r = fixRepo();
    r.write(".gitignore", "*.log\n");
    r.commit("ignore logs");
    r.write("debug.log", AFTER.join("\n") + "\n");
    r.write("src/new.ts", AFTER.join("\n") + "\n");
    expect(edit(r.dir, join(r.dir, "debug.log"), GUARD + "\n", "")).toBeNull();
    expect(edit(r.dir, join(r.dir, "src", "new.ts"), GUARD + "\n", "")).toBeNull();
  });

  it("directory as file_path: null", () => {
    const r = fixRepo();
    expect(write(r.dir, join(r.dir, "src"), "x\n")).toBeNull();
  });
});

describe("file contents", () => {
  it("binary file: null", () => {
    const r = fixRepo();
    r.write("bin.dat", "abc\u0000def\n" + GUARD + "\n");
    r.commit("fix: binary blob (#1)");
    expect(edit(r.dir, join(r.dir, "bin.dat"), GUARD, "")).toBeNull();
  });

  it("10 MB file: null, and fast", () => {
    const r = fixRepo();
    const big = (GUARD + "\n").repeat(Math.ceil((10 * 1024 * 1024) / (GUARD.length + 1)));
    r.write("big.ts", big);
    const t0 = Date.now();
    expect(write(r.dir, join(r.dir, "big.ts"), "x\n")).toBeNull();
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("CRLF file, LF old_string: deny fires", () => {
    const r = fixRepo("src/sock.ts", "\r\n");
    expect(decision(edit(r.dir, join(r.dir, "src", "sock.ts"), GUARD + "\n  sock.end();\n", "  sock.end();\n"))).toBe("deny");
  });

  it("CRLF file, Write with LF content: deny fires", () => {
    const r = fixRepo("src/sock.ts", "\r\n");
    expect(decision(write(r.dir, join(r.dir, "src", "sock.ts"), BEFORE.join("\n") + "\n"))).toBe("deny");
  });

  // BUG (wrong result, silent miss): with mixed line endings, an old_string that spans a CRLF line
  // and an LF line matches neither the as-is form nor the all-CRLF form, so the change is dropped.
  it.fails("mixed line endings: an edit spanning CRLF and LF lines is still checked", () => {
    const r = track(makeRepo());
    r.write("m.ts", "function close(sock) {\r\n  sock.end();\n}\r\n");
    r.commit("initial");
    r.write("m.ts", `function close(sock) {\r\n${GUARD}\r\n  sock.end();\n}\r\n`);
    r.write("test/m.test.ts", "it('x', () => {});\n");
    r.commit("fix: race on close (#9)");
    buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true });
    expect(decision(edit(r.dir, join(r.dir, "m.ts"), `${GUARD}\n  sock.end();\n`, "  sock.end();\n", "mixed"))).toBe("deny");
  });

  it("mixed line endings: an edit inside the LF part still works", () => {
    const r = track(makeRepo());
    r.write("m.ts", "function close(sock) {\r\n  sock.end();\n}\r\n");
    r.commit("initial");
    r.write("m.ts", `function close(sock) {\r\n  sock.end();\n${GUARD}\n}\r\n`);
    r.write("test/m.test.ts", "it('x', () => {});\n");
    r.commit("fix: race on close (#9)");
    buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true });
    expect(decision(edit(r.dir, join(r.dir, "m.ts"), `  sock.end();\n${GUARD}\n`, "  sock.end();\n", "mixed2"))).toBe("deny");
  });

  it("no trailing newline, guard on the last line: deny fires", () => {
    const r = track(makeRepo());
    r.write("t.ts", "function close(sock) {\n  sock.end();");
    r.commit("initial");
    r.write("t.ts", `function close(sock) {\n  sock.end();\n${GUARD}`);
    r.write("test/t.test.ts", "it('x', () => {});\n");
    r.commit("fix: race on close (#9)");
    buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true });
    expect(decision(edit(r.dir, join(r.dir, "t.ts"), `\n${GUARD}`, "", "nonl"))).toBe("deny");
  });

  it("UTF-8 BOM file: deny fires, including a Write that drops the BOM", () => {
    const r = fixRepo("src/sock.ts", "\n", { bom: true });
    expect(decision(edit(r.dir, join(r.dir, "src", "sock.ts"), GUARD + "\n", "", "bom1"))).toBe("deny");
    expect(decision(write(r.dir, join(r.dir, "src", "sock.ts"), BEFORE.join("\n") + "\n", "bom2"))).toBe("deny");
  });

  it("UTF-8 BOM with the fix on line 1: deny fires", () => {
    const r = track(makeRepo());
    r.write("b.ts", "﻿function close(sock) {\n}\n");
    r.commit("initial");
    r.write("b.ts", `﻿${GUARD.trim()}\nfunction close(sock) {\n}\n`);
    r.write("test/b.test.ts", "it('x', () => {});\n");
    r.commit("fix: race on close (#9)");
    buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true });
    expect(decision(write(r.dir, join(r.dir, "b.ts"), "function close(sock) {\n}\n", "bom3"))).toBe("deny");
  });

  it("UTF-16 file: null, no crash (not supported, fails open)", () => {
    const r = track(makeRepo());
    const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(AFTER.join("\r\n") + "\r\n", "utf16le")]);
    mkdirSync(join(r.dir, "w"), { recursive: true });
    writeFileSync(join(r.dir, "w", "u.txt"), u16);
    r.commit("fix: utf16 (#1)");
    buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true });
    expect(edit(r.dir, join(r.dir, "w", "u.txt"), "sock", "x")).toBeNull();
  });

  it("Write that creates a brand new file in a new directory: no crash", () => {
    const r = fixRepo();
    expect(() => write(r.dir, join(r.dir, "new", "deep", "file.ts"), "hello world\n")).not.toThrow();
  });
});

describe("no leftovers", () => {
  it("the hook only writes inside <git-dir>/chesterton", () => {
    const r = fixRepo();
    const before = readdirSync(r.dir).sort();
    edit(r.dir, join(r.dir, "src", "sock.ts"), GUARD + "\n", "", "clean");
    expect(readdirSync(r.dir).sort()).toEqual(before);
    expect(existsSync(join(indexDir(r.dir), "sessions"))).toBe(true);
    const st = spawnSync("git", ["status", "--porcelain"], { cwd: r.dir, encoding: "utf8" });
    expect(st.stdout.trim()).toBe("");
  });
});
