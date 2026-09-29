import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { explainLine } from "../src/why.js";
import { buildIndex } from "../src/index-builder.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { makeRepo, type TestRepo } from "./helpers/repo.js";

const BEFORE = [
  "export async function close(sock) {",
  "  await sock.flush();",
  "  sock.end();",
  "}",
  "",
].join("\n");

const AFTER = [
  "export async function close(sock) {",
  "  await sock.flush();",
  "  await sleep(50); // wait for the kernel to drain the buffer",
  "  sock.end();",
  "}",
  "",
].join("\n");

function fixtureRepo(): { repo: TestRepo; fixSha: string } {
  const repo = makeRepo();
  repo.write("src/socket.ts", BEFORE);
  repo.write("README.md", "hi\n");
  repo.commit("initial");
  repo.write("src/socket.ts", AFTER);
  repo.write("test/socket.test.ts", "it('closes cleanly under load', () => {});\n");
  const fixSha = repo.commit("fix: race on socket close (#412)");
  repo.write("README.md", "hi there\n");
  repo.commit("docs: tweak readme");
  return { repo, fixSha };
}

describe("explainLine", () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it("names the fix commit behind a line, with reasons, refs and tests", () => {
    const f = fixtureRepo();
    repo = f.repo;
    const idx = buildIndex(repo.dir, DEFAULT_CONFIG);
    expect(idx.commits[f.fixSha]).toBeDefined();
    const text = explainLine(repo.dir, "src/socket.ts", 3, idx);
    expect(text).toContain("src/socket.ts:3");
    expect(text).toContain("await sleep(50);");
    expect(text).toContain(`Last touched by ${f.fixSha.slice(0, 7)}`);
    expect(text).toContain("fix: race on socket close (#412)");
    expect(text).toContain("[fix]");
    expect(text).toContain("Refs: #412");
    expect(text).toContain("Tests: test/socket.test.ts");
    expect(text).toContain(`git show ${f.fixSha.slice(0, 7)}`);
    expect(text).not.toContain("—");
  });

  it("lists history without fix markers when there is no index", () => {
    const f = fixtureRepo();
    repo = f.repo;
    const text = explainLine(repo.dir, "src/socket.ts", 2, null);
    expect(text).toContain("Commits that shaped this line");
    expect(text).toContain("initial");
    expect(text).toContain("No Chesterton index yet");
    expect(text).not.toContain("[fix]");
  });

  it("says so when no commit looks like a fix", () => {
    const f = fixtureRepo();
    repo = f.repo;
    const idx = buildIndex(repo.dir, DEFAULT_CONFIG);
    const text = explainLine(repo.dir, "src/socket.ts", 2, idx);
    expect(text).toContain("None of these commits look like bug fixes.");
  });

  it("reports uncommitted and untracked lines", () => {
    const f = fixtureRepo();
    repo = f.repo;
    repo.write("src/socket.ts", AFTER + "// new line\n");
    expect(explainLine(repo.dir, "src/socket.ts", 6, null)).toContain("uncommitted changes");
    repo.write("scratch.ts", "a\n");
    expect(explainLine(repo.dir, "scratch.ts", 1, null)).toContain("Not tracked by git");
  });

  it("rejects missing files and out of range lines", () => {
    const f = fixtureRepo();
    repo = f.repo;
    expect(explainLine(repo.dir, "nope.ts", 1, null)).toContain("file not found");
    expect(explainLine(repo.dir, "src/socket.ts", 99, null)).toContain("no such line");
  });

  it("shows one date per commit: the author date in the author's own time zone", () => {
    repo = makeRepo();
    const r = repo;
    r.write("src/socket.ts", BEFORE);
    r.commit("initial");
    r.write("src/socket.ts", AFTER);
    r.write("test/socket.test.ts", "it('closes cleanly under load', () => {});\n");
    r.git("add", "-A");
    // Late evening in UTC-5 is already the next day in UTC.
    const date = "2025-03-14T23:30:00-05:00";
    const res = spawnSync("git", ["commit", "-q", "-m", "fix: race on socket close (#412)"], {
      cwd: r.dir,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: "2025-03-16T12:00:00+00:00" },
      windowsHide: true,
    });
    expect(res.status).toBe(0);
    const sha = r.git("rev-parse", "HEAD").trim().slice(0, 7);
    const text = explainLine(r.dir, "src/socket.ts", 3, buildIndex(r.dir, DEFAULT_CONFIG));
    expect(text).toContain(`Last touched by ${sha} on 2025-03-14`);
    expect(text).toContain(`${sha}  2025-03-14  fix: race on socket close (#412)`);
    expect(text).not.toContain("2025-03-15");
    expect(text).not.toContain("2025-03-16");
  });
});
