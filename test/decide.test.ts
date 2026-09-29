import { describe, expect, it } from "vitest";
import { decidePreToolUse, matchGlob } from "../src/decide.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { SessionState } from "../src/session.js";
import type { ChestertonConfig, Finding } from "../src/types.js";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

function finding(strength: "strong" | "weak", kind: Finding["kind"] = "removes-fix", sha = SHA): Finding {
  return {
    kind,
    strength,
    file: "src/sock.ts",
    fix: {
      sha,
      date: "2025-03-14T10:00:00Z",
      author: "Jane Doe",
      subject: "fix: race on socket close (#412)",
      score: 6,
      reasons: ["message says 'race'", "adds test test/socket.test.ts"],
      refs: ["#412"],
      testFiles: ["test/socket.test.ts"],
    },
    lines: ["if (sock.pending > 0) await flush(sock);"],
  };
}

const fresh = (): SessionState => ({ sessionId: "s1", acknowledged: [], findings: [], files: [] });
const cfg = (over: Partial<ChestertonConfig> = {}): ChestertonConfig => ({ ...DEFAULT_CONFIG, ...over });
const parse = (s: string | null) => (s === null ? null : (JSON.parse(s).hookSpecificOutput as Record<string, string>));

describe("decidePreToolUse", () => {
  it("does not re-list test files beyond the cap", () => {
    const tests = Array.from({ length: 12 }, (_, i) => `tests/test_${i}.py`);
    const f = finding("strong");
    f.fix.testFiles = tests;
    f.fix.reasons = ["message says 'fix'", "modifies test tests/test_0.py", "modifies test tests/test_1.py", "modifies test tests/test_2.py", "and 9 more test files"];
    const reason = parse(decidePreToolUse([f], fresh(), cfg(), "src/sock.ts").stdout)!.permissionDecisionReason!;
    expect(reason).toContain("and 9 more test files");
    expect(reason).not.toContain("tests/test_3.py");
    expect(reason).not.toContain("touches test");

    // With no test reasons from the classifier, list at most 3 and count the rest.
    const g = finding("strong");
    g.fix.testFiles = tests;
    g.fix.reasons = ["message says 'fix'"];
    const r2 = parse(decidePreToolUse([g], fresh(), cfg(), "src/sock.ts").stdout)!.permissionDecisionReason!;
    expect(r2).toContain("touches test tests/test_0.py, tests/test_1.py, tests/test_2.py and 9 more");
    expect(r2).not.toContain("tests/test_3.py");
  });

  it("silent with no findings", () => {
    expect(decidePreToolUse([], fresh(), cfg(), "src/sock.ts")).toEqual({ stdout: null });
  });

  it("weak only: context, no permission decision", () => {
    const s = fresh();
    const out = parse(decidePreToolUse([finding("weak")], s, cfg(), "src/sock.ts").stdout)!;
    expect(out.hookEventName).toBe("PreToolUse");
    expect(out.permissionDecision).toBeUndefined();
    expect(out.additionalContext).toContain("a1b2c3d");
    expect(s.acknowledged).toEqual([]);
    expect(s.findings[0]!.decision).toBe("context");
  });

  it("speedbump: denies the first time, then lets the retry through", () => {
    const s = fresh();
    const first = parse(decidePreToolUse([finding("strong")], s, cfg(), "src/sock.ts").stdout)!;
    expect(first.permissionDecision).toBe("deny");
    const reason = first.permissionDecisionReason!;
    expect(reason).toContain("Chesterton: this edit to src/sock.ts removes code that fix a1b2c3d added.");
    expect(reason).toContain('Fix: a1b2c3d (2025-03-14, Jane Doe) "fix: race on socket close (#412)"');
    expect(reason).toContain("message says 'race'");
    expect(reason).toContain("references #412");
    expect(reason).toContain("if (sock.pending > 0) await flush(sock);");
    expect(reason).toContain("git show a1b2c3d");
    expect(reason).toContain("retry the same edit");
    expect(reason).not.toContain("—");
    expect(s.acknowledged).toEqual([`src/sock.ts@${SHA}`]);

    const second = parse(decidePreToolUse([finding("strong")], s, cfg(), "src/sock.ts").stdout)!;
    expect(second.permissionDecision).toBeUndefined();
    expect(second.additionalContext).toContain("already flagged");
    expect(s.findings.map((f) => f.decision)).toEqual(["deny", "acknowledged"]);
  });

  it("speedbump: acknowledgement is per file and per fix", () => {
    const s = fresh();
    decidePreToolUse([finding("strong")], s, cfg(), "src/sock.ts");
    expect(parse(decidePreToolUse([finding("strong")], s, cfg(), "src/other.ts").stdout)!.permissionDecision).toBe("deny");
    const other = finding("strong", "removes-fix", "f".repeat(40));
    expect(parse(decidePreToolUse([finding("strong"), other], s, cfg(), "src/sock.ts").stdout)!.permissionDecision).toBe("deny");
  });

  it("re-adds wording", () => {
    const out = parse(decidePreToolUse([finding("strong", "re-adds-removed")], fresh(), cfg(), "src/sock.ts").stdout)!;
    expect(out.permissionDecisionReason).toContain("adds back code that fix a1b2c3d removed");
    expect(out.permissionDecisionReason).toContain("Before adding this back");
  });

  it("ask mode always asks", () => {
    const s = fresh();
    for (let i = 0; i < 2; i++) {
      const out = parse(decidePreToolUse([finding("strong")], s, cfg({ mode: "ask" }), "src/sock.ts").stdout)!;
      expect(out.permissionDecision).toBe("ask");
      expect(out.permissionDecisionReason).toContain("a1b2c3d");
    }
  });

  it("protected paths ask even in speedbump and warn-only", () => {
    for (const mode of ["speedbump", "warn-only"] as const) {
      const out = parse(decidePreToolUse([finding("strong")], fresh(), cfg({ mode, protect: ["src/**/*.ts"] }), "src/sock.ts").stdout)!;
      expect(out.permissionDecision).toBe("ask");
      expect(out.permissionDecisionReason).toContain("protected path");
    }
  });

  it("protected paths still only add context for weak findings", () => {
    const out = parse(decidePreToolUse([finding("weak")], fresh(), cfg({ protect: ["src/**"] }), "src/sock.ts").stdout)!;
    expect(out.permissionDecision).toBeUndefined();
  });

  it("warn-only never blocks", () => {
    const out = parse(decidePreToolUse([finding("strong")], fresh(), cfg({ mode: "warn-only" }), "src/sock.ts").stdout)!;
    expect(out.permissionDecision).toBeUndefined();
    expect(out.additionalContext).toContain("a1b2c3d");
  });
});

describe("matchGlob", () => {
  it.each([
    ["src/auth/login.ts", "src/auth/**", true],
    ["src/auth/deep/x.ts", "src/auth/**", true],
    ["src/authz/x.ts", "src/auth/**", false],
    ["src/a.ts", "src/*.ts", true],
    ["src/x/a.ts", "src/*.ts", false],
    ["src/x/a.ts", "src/**/*.ts", true],
    ["src/a.ts", "src/**/*.ts", true],
    ["deep/dir/payment.go", "payment.go", true],
    ["deep/dir/payments.go", "payment?.go", true],
    ["a.go", "*.go", true],
    ["migrations/001.sql", "migrations/", true],
    ["migrations/001.sql", "migrations", true],
    ["src/a.ts", "", false],
    ["src/a.ts", "./src/a.ts", true],
    ["src/a+b.ts", "src/a+b.ts", true],
  ])("%s vs %s -> %s", (path, glob, want) => {
    expect(matchGlob(path, glob)).toBe(want);
  });
});

describe("messages group findings by fix commit", () => {
  const OTHER = "ffeeddccbbaa99887766554433221100ffeeddcc";
  const readd = (sha = SHA): Finding => ({ ...finding("strong", "re-adds-removed", sha), lines: ["setTimeout(retry, 0); // spin until ready"] });

  it("one fix that is both removed and re-added: counted once, one Fix block", () => {
    const res = parse(decidePreToolUse([finding("strong"), readd()], fresh(), cfg(), "src/sock.ts").stdout)!;
    const reason = res.permissionDecisionReason!;
    expect(reason).toContain("this edit to src/sock.ts removes code that fix a1b2c3d added and adds back code it removed.");
    expect(reason).not.toContain("touches 2 past bug fixes");
    expect(reason.match(/^Fix: /gm)).toHaveLength(1);
    expect(reason).toContain("Lines it removes:\n  if (sock.pending > 0) await flush(sock);");
    expect(reason).toContain("Lines it adds back:\n  setTimeout(retry, 0); // spin until ready");
    expect(reason).toContain("check the fix commit (git show a1b2c3d)");
  });

  it("two different fixes: counted as two, one block each", () => {
    const res = parse(decidePreToolUse([finding("strong"), finding("strong", "removes-fix", OTHER), readd()], fresh(), cfg(), "src/sock.ts").stdout)!;
    const reason = res.permissionDecisionReason!;
    expect(reason).toContain("touches 2 past bug fixes");
    expect(reason.match(/^Fix: /gm)).toHaveLength(2);
    expect(reason).toContain("check the fix commits (git show a1b2c3d, git show ffeeddc)");
  });

  it("ask and context messages group the same way", () => {
    const ask = parse(decidePreToolUse([finding("strong"), readd()], fresh(), cfg({ mode: "ask" }), "src/sock.ts").stdout)!;
    expect(ask.permissionDecisionReason!.match(/^Fix: /gm)).toHaveLength(1);
    expect(ask.permissionDecisionReason).not.toContain("past bug fixes");
    const warn = parse(decidePreToolUse([finding("strong"), readd()], fresh(), cfg({ mode: "warn-only" }), "src/sock.ts").stdout)!;
    expect(warn.additionalContext!.match(/Fix: /g)).toHaveLength(1);
  });
});
