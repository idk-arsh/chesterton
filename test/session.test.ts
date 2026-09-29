import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadSession, sanitizeSessionId, saveSession, sessionPath } from "../src/session.js";
import { makeRepo, type TestRepo } from "./helpers/repo.js";

let repo: TestRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

describe("session", () => {
  it("missing session gives an empty state", () => {
    repo = makeRepo();
    expect(loadSession(repo.dir, "abc")).toEqual({ sessionId: "abc", acknowledged: [], findings: [], files: [] });
  });

  it("round trips through disk under the git dir", () => {
    repo = makeRepo();
    const s = loadSession(repo.dir, "abc-123");
    s.acknowledged.push("src/a.ts@deadbeef");
    s.files.push("src/a.ts");
    s.findings.push({ at: "now", key: "src/a.ts@deadbeef", kind: "removes-fix", strength: "strong", file: "src/a.ts", sha: "deadbeef", decision: "deny" });
    saveSession(repo.dir, s);
    const p = sessionPath(repo.dir, "abc-123");
    expect(p.replace(/\\/g, "/")).toContain("/.git/chesterton/sessions/abc-123.json");
    expect(existsSync(p)).toBe(true);
    expect(loadSession(repo.dir, "abc-123")).toEqual(s);
  });

  it("corrupt files are tolerated", () => {
    repo = makeRepo();
    const p = sessionPath(repo.dir, "bad");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{not json");
    expect(loadSession(repo.dir, "bad").acknowledged).toEqual([]);
    writeFileSync(p, JSON.stringify({ acknowledged: "nope", files: [1, "a.ts"], findings: [null, { key: "k" }] }));
    const s = loadSession(repo.dir, "bad");
    expect(s.acknowledged).toEqual([]);
    expect(s.files).toEqual(["a.ts"]);
    expect(s.findings).toHaveLength(1);
  });

  it("sanitizes session ids for filenames", () => {
    expect(sanitizeSessionId("../../etc/passwd")).not.toContain("/");
    expect(sanitizeSessionId("a:b*c?")).toMatch(/^a_b_c_\.h[0-9a-f]{12}$/);
    expect(sanitizeSessionId("abc-123")).toBe("abc-123");
    expect(sanitizeSessionId("a/b")).not.toBe(sanitizeSessionId("a_b"));
    expect(sanitizeSessionId("")).toBe("default");
    expect(sanitizeSessionId("..")).not.toBe("..");
  });
});
