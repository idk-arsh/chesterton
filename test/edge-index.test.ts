// Edge cases for the on-disk index: corruption, versions, locks, concurrency, permissions.
import { afterEach, describe, expect, it, vi } from "vitest";

// Real git repos on Windows are slow; give every test room when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 60_000 });
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleHookInput } from "../src/hook.js";
import { buildIndex } from "../src/index-builder.js";
import { indexDir, loadIndex, INDEX_FILE } from "../src/index-store.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { main, type CliIO } from "../src/cli.js";
import { makeRepo, type TestRepo } from "./helpers/repo.js";

const CLI_JS = join(fileURLToPath(new URL(".", import.meta.url)), "..", "dist", "cli.js");
const GUARD = "  if (sock.pending > 0) await flush(sock);";
const BASE = ["function close(sock) {", "  sock.end();", "}", ""].join("\n");
const FIXED = ["function close(sock) {", GUARD, "  sock.end();", "}", ""].join("\n");

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

function fixRepo(): { r: TestRepo; fix: string } {
  const r = makeRepo();
  cleanups.push(() => r.cleanup());
  r.write("src/sock.ts", BASE);
  r.commit("initial");
  r.write("src/sock.ts", FIXED);
  r.write("test/sock.test.ts", "it('flushes', () => {});\n");
  const fix = r.commit("fix: race on socket close (#412)");
  return { r, fix };
}

const deps = () => ({ startedAt: Date.now() + 60_000, spawnIndexer: () => {} });
function removeGuard(r: TestRepo, sid: string): string | null {
  return handleHookInput(
    JSON.stringify({
      session_id: sid,
      cwd: r.dir,
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: join(r.dir, "src", "sock.ts"), old_string: `${GUARD}\n`, new_string: "" },
    }),
    deps(),
  );
}
const decision = (s: string | null) => (s === null ? null : JSON.parse(s).hookSpecificOutput.permissionDecision ?? "allow");

function cli(argv: string[], cwd: string): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const io: CliIO = { out: (t) => (out += t + "\n"), err: (t) => (err += t + "\n"), cwd };
  return { code: main(argv, io), out, err };
}

const indexFile = (r: TestRepo) => join(indexDir(r.dir), INDEX_FILE);

describe("corrupt and foreign index files", () => {
  it("corrupt index JSON: loadIndex null, hook falls back to blame and still denies, index rebuilds", () => {
    const { r } = fixRepo();
    for (const junk of ["", "{", "not json at all", "\u0000\u0000", "[]", "null", '{"version":1}']) {
      writeFileSync(indexFile(r), junk);
      expect(loadIndex(r.dir)).toBeNull();
    }
    expect(decision(removeGuard(r, "corrupt"))).toBe("deny");
    const idx = buildIndex(r.dir, { ...DEFAULT_CONFIG });
    expect(Object.keys(idx.commits)).toHaveLength(1);
  });

  it("index from an older or newer version number is ignored and rebuilt", () => {
    const { r } = fixRepo();
    for (const version of [0, 2, "1"]) {
      writeFileSync(indexFile(r), JSON.stringify({ version, head: "x", builtAt: "", commits: {}, files: {} }));
      expect(loadIndex(r.dir)).toBeNull();
      const idx = buildIndex(r.dir, { ...DEFAULT_CONFIG });
      expect(idx.version).toBe(1);
      expect(Object.keys(idx.commits)).toHaveLength(1);
    }
  });

  it("index copied in from a different repo: full rebuild, hook does not crash", () => {
    const a = fixRepo();
    const b = fixRepo();
    b.r.write("README.md", "a different repo\n");
    b.r.commit("docs");
    buildIndex(a.r.dir, { ...DEFAULT_CONFIG }, { full: true });
    writeFileSync(indexFile(b.r), readFileSync(indexFile(a.r)));
    expect(() => removeGuard(b.r, "foreign")).not.toThrow();
    let spawned = 0;
    handleHookInput(JSON.stringify({ cwd: b.r.dir, hook_event_name: "SessionStart" }), { spawnIndexer: () => spawned++ });
    expect(spawned).toBe(1);
    const idx = buildIndex(b.r.dir, { ...DEFAULT_CONFIG });
    expect(Object.keys(idx.commits)).toEqual([b.fix]);
  });

  it("valid-looking index with garbage records: hook fails open (null, no throw)", () => {
    const { r } = fixRepo();
    const idx = buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true });
    writeFileSync(indexFile(r), JSON.stringify({ ...idx, files: { "src/sock.ts": [null, 5, "x"] } }));
    expect(() => removeGuard(r, "garbage")).not.toThrow();
  });

  // Was a bug (blocks user, low likelihood): loadIndex only checks the top-level shape. A record list that is
  // null (hand edit, disk damage, a buggy writer) makes every incremental build throw, so the index
  // never updates again until someone runs `index --full`, and the hook silently finds nothing.
  it("an index with a null record list is treated as corrupt and rebuilt", () => {
    const { r } = fixRepo();
    const idx = buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true });
    writeFileSync(indexFile(r), JSON.stringify({ ...idx, files: { "src/sock.ts": null } }));
    r.write("README.md", "docs\n");
    r.commit("docs");
    const res = cli(["index"], r.dir);
    expect(res.code).toBe(0);
    expect(decision(removeGuard(r, "nullrec"))).toBe("deny");
  });
});

describe("lock file", () => {
  it("old lock whose owner is still running is honored; past 30 minutes it is taken over", () => {
    const { r } = fixRepo();
    const lock = join(indexDir(r.dir), "index.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, at: "2020-01-01T00:00:00Z" }));
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, old, old);
    expect(buildIndex(r.dir, { ...DEFAULT_CONFIG }).head).toBe("");
    expect(existsSync(lock)).toBe(true);
    const ancient = new Date(Date.now() - 40 * 60_000);
    utimesSync(lock, ancient, ancient);
    expect(Object.keys(buildIndex(r.dir, { ...DEFAULT_CONFIG }).commits)).toHaveLength(1);
    expect(existsSync(lock)).toBe(false);
  });

  it("stale lock (older than 5 minutes) is taken over", () => {
    const { r } = fixRepo();
    const lock = join(indexDir(r.dir), "index.lock");
    writeFileSync(lock, JSON.stringify({ pid: 999999, at: "2020-01-01T00:00:00Z" }));
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, old, old);
    const idx = buildIndex(r.dir, { ...DEFAULT_CONFIG });
    expect(Object.keys(idx.commits)).toHaveLength(1);
    expect(existsSync(lock)).toBe(false);
  });

  it("fresh lock: build returns without waiting and leaves the lock alone", () => {
    const { r } = fixRepo();
    const lock = join(indexDir(r.dir), "index.lock");
    writeFileSync(lock, JSON.stringify({ pid: 999999, at: new Date().toISOString() }));
    const t0 = Date.now();
    const idx = buildIndex(r.dir, { ...DEFAULT_CONFIG });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(existsSync(lock)).toBe(true);
    expect(idx.head).toBe("");
  });

  // Was a bug (cosmetic): with another build holding the lock, `chesterton index` says "No commits yet,
  // nothing to index." and exits 0, in a repo that has commits. It should say an index build is already
  // running.
  it("index with a fresh lock held by someone else says so", () => {
    const { r } = fixRepo();
    writeFileSync(join(indexDir(r.dir), "index.lock"), "{}");
    const res = cli(["index"], r.dir);
    expect(res.out + res.err).not.toContain("No commits yet");
  });

  // Was a bug (wrong result): `chesterton check` builds the index when it is missing or stale, but when the
  // SessionStart background build holds the lock it gets an empty index back and reports
  // "No past fixes touched" with exit 0. A pre-commit hook or CI step then passes a change that removes a
  // fix. Repro: create .git/chesterton/index.lock, delete index.json, remove the guard line, run check.
  it("check while another build holds the lock does not pass a strong hit", () => {
    const { r } = fixRepo();
    writeFileSync(join(indexDir(r.dir), "index.lock"), "{}");
    r.write("src/sock.ts", BASE);
    const prev = process.env.CHESTERTON_LOCK_WAIT_MS;
    process.env.CHESTERTON_LOCK_WAIT_MS = "600";
    let res;
    try {
      res = cli(["check"], r.dir);
    } finally {
      if (prev === undefined) delete process.env.CHESTERTON_LOCK_WAIT_MS;
      else process.env.CHESTERTON_LOCK_WAIT_MS = prev;
    }
    expect(res.code).toBe(2);
    expect(res.err).toContain("another index build is still running");
  });

  it("check waits for another build to finish, then uses its index", async () => {
    const { r } = fixRepo();
    const lock = join(indexDir(r.dir), "index.lock");
    writeFileSync(lock, "{}");
    r.write("src/sock.ts", BASE);
    // Release the lock from another process while check is waiting in this one.
    const releaser = spawn(process.execPath, ["-e", `setTimeout(() => require("fs").unlinkSync(${JSON.stringify(lock)}), 800)`], {
      stdio: "ignore",
      windowsHide: true,
    });
    const done = new Promise((resolve) => releaser.on("exit", resolve));
    const res = cli(["check"], r.dir);
    await done;
    expect(res.code).toBe(1);
    expect(res.out).toContain("STRONG");
  });

  it("check without a lock catches the same change (control)", () => {
    const { r } = fixRepo();
    r.write("src/sock.ts", BASE);
    const res = cli(["check"], r.dir);
    expect(res.code).toBe(1);
    expect(res.out).toContain("STRONG");
  });

  it("two concurrent `cli.js index` runs: both exit 0, one valid index, no lock or tmp left", async () => {
    const { r } = fixRepo();
    for (let i = 0; i < 30; i++) {
      r.write(`src/f${i}.ts`, `export const v${i} = compute(${i});\n`);
      r.commit(i % 3 === 0 ? `fix: crash in f${i} (#${i})` : `feat: f${i}`);
    }
    const run = () =>
      new Promise<number | null>((resolve) => {
        const c = spawn(process.execPath, [CLI_JS, "index", "--full"], { cwd: r.dir, stdio: "ignore", windowsHide: true });
        c.on("exit", resolve);
      });
    const codes = await Promise.all([run(), run(), run()]);
    expect(codes).toEqual([0, 0, 0]);
    const idx = loadIndex(r.dir);
    expect(idx?.head).toBe(r.git("rev-parse", "HEAD").trim());
    const leftovers = readdirSync(indexDir(r.dir)).filter((f) => f.endsWith(".tmp") || f === "index.lock");
    expect(leftovers).toEqual([]);
  }, 60_000);

  it("index while HEAD moves: saved index is at one of the two heads and the next build catches up", async () => {
    const { r } = fixRepo();
    for (let i = 0; i < 40; i++) {
      r.write(`src/g${i}.ts`, `export const g${i} = compute(${i});\n`);
      r.commit(`feat: g${i}`);
    }
    const before = r.git("rev-parse", "HEAD").trim();
    const child = new Promise<number | null>((resolve) => {
      const c = spawn(process.execPath, [CLI_JS, "index", "--full"], { cwd: r.dir, stdio: "ignore", windowsHide: true });
      c.on("exit", resolve);
    });
    r.write("src/sock.ts", FIXED.replace("sock.end();", "sock.end(); // closing"));
    const after = r.commit("fix: close crash (#9)");
    expect(await child).toBe(0);
    expect([before, after]).toContain(loadIndex(r.dir)?.head);
    expect(buildIndex(r.dir, { ...DEFAULT_CONFIG }).head).toBe(after);
  }, 60_000);
});

describe("unwritable index directory", () => {
  it("<git-dir>/chesterton is a file, not a directory: hook fails open", () => {
    const { r } = fixRepo();
    const gitDir = join(r.dir, ".git");
    rmSync(join(gitDir, "chesterton"), { recursive: true, force: true });
    writeFileSync(join(gitDir, "chesterton"), "in the way");
    expect(() => removeGuard(r, "blocked")).not.toThrow();
    expect(
      handleHookInput(JSON.stringify({ cwd: r.dir, hook_event_name: "SessionStart" }), { spawnIndexer: () => {} }),
    ).toBeNull();
    expect(handleHookInput(JSON.stringify({ cwd: r.dir, session_id: "b", hook_event_name: "Stop" }), deps())).toBeNull();
  });

  // Was a bug (cosmetic): when the index directory cannot be created, `chesterton index` prints
  // "No commits yet, nothing to index." and exits 0. The help text says a failed index exits 1.
  it("index reports a failure when <git-dir>/chesterton cannot be created", () => {
    const { r } = fixRepo();
    const gitDir = join(r.dir, ".git");
    rmSync(join(gitDir, "chesterton"), { recursive: true, force: true });
    writeFileSync(join(gitDir, "chesterton"), "in the way");
    const res = cli(["index"], r.dir);
    expect(res.code).toBe(1);
  });

  function lockDown(r: TestRepo): boolean {
    const dir = indexDir(r.dir);
    mkdirSync(join(dir, "sessions"), { recursive: true });
    if (process.platform === "win32") {
      const user = process.env.USERNAME ?? "";
      const res = spawnSync("icacls", [dir, "/deny", `${user}:(OI)(CI)(W,D,DC)`], { encoding: "utf8", windowsHide: true });
      cleanups.push(() => spawnSync("icacls", [dir, "/remove:d", user], { windowsHide: true }));
      return res.status === 0;
    }
    spawnSync("chmod", ["-R", "a-w", dir]);
    cleanups.push(() => spawnSync("chmod", ["-R", "u+w", dir]));
    return true;
  }

  it("read-only index directory: hook fails open and still produces the deny", () => {
    const { r } = fixRepo();
    buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true });
    if (!lockDown(r)) return;
    expect(decision(removeGuard(r, "ro"))).toBe("deny");
  });

  // Was a bug (blocks user): when the session file cannot be saved, the acknowledgement is lost, so the
  // "retry the same edit and Chesterton will let it through" promise breaks. Every retry is denied
  // again and Claude is stuck on that edit. When the ack cannot be persisted the hook should fall back
  // to allowing with context (fail open) instead of denying.
  it("read-only index directory: the identical retry is allowed", () => {
    const { r } = fixRepo();
    buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true });
    if (!lockDown(r)) throw new Error("could not make the directory read-only");
    expect(decision(removeGuard(r, "ro2"))).toBe("deny");
    expect(decision(removeGuard(r, "ro2"))).toBe("allow");
  });

  it("read-only index directory and no usable temp dir: allows with the explanation instead of denying", () => {
    const { r } = fixRepo();
    buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true });
    if (!lockDown(r)) throw new Error("could not make the directory read-only");
    // Point the OS temp dir at a regular file so the fallback session folder cannot be made either.
    const blocker = join(r.dir, "not-a-dir");
    writeFileSync(blocker, "x");
    const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    process.env.TEMP = process.env.TMP = process.env.TMPDIR = blocker;
    let out: string | null;
    try {
      out = removeGuard(r, "ro3");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(decision(out)).toBe("allow");
    const ctx = JSON.parse(out!).hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain("could not save");
    expect(ctx).toContain("race on socket close");
  });

  // Was a bug (cosmetic): `chesterton index` in a read-only index directory prints
  // "No commits yet, nothing to index." and exits 0 (acquireLock gets EPERM and buildIndex treats that
  // like "someone else is building"). Help says a failed index exits 1.
  it("read-only index directory: index exits 1 with a message", () => {
    const { r } = fixRepo();
    buildIndex(r.dir, { ...DEFAULT_CONFIG }, { full: true });
    if (!lockDown(r)) throw new Error("could not make the directory read-only");
    r.write("README.md", "x\n");
    r.commit("docs");
    const res = cli(["index"], r.dir);
    expect(res.code).toBe(1);
    expect(res.err).toContain("index failed");
  });
});
