import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, loadConfigWithWarnings, parseConfig, parseYamlSubset } from "../src/config.js";
import { makeRepo, type TestRepo } from "./helpers/repo.js";

describe("DEFAULT_CONFIG", () => {
  it("indexes all history by default, capped by maxCommits", () => {
    expect(DEFAULT_CONFIG.history).toBe("all");
    expect(DEFAULT_CONFIG.maxCommits).toBe(20_000);
  });
});

describe("parseYamlSubset", () => {
  it("reads scalars, quoted strings, inline and block lists, and comments", () => {
    const { values, warnings } = parseYamlSubset(
      [
        "# top comment",
        "mode: ask   # trailing comment",
        'history: "18m"',
        "single: 'it''s'",
        'hash: "a # b"',
        "inline: [a, \"b, c\", 'd']",
        "block:",
        "  - one",
        "  - \"two # still two\"  # comment",
        "",
        "after: x",
      ].join("\n"),
    );
    expect(warnings).toEqual([]);
    expect(values).toEqual({
      mode: "ask",
      history: "18m",
      single: "it's",
      hash: "a # b",
      inline: ["a", "b, c", "d"],
      block: ["one", "two # still two"],
      after: "x",
    });
  });

  it("handles CRLF and a BOM", () => {
    const { values } = parseYamlSubset("﻿mode: warn-only\r\nprotect:\r\n  - src/**\r\n");
    expect(values).toEqual({ mode: "warn-only", protect: ["src/**"] });
  });

  it("warns on lines it cannot read instead of throwing", () => {
    const { values, warnings } = parseYamlSubset("mode: ask\n  nested: thing\nnot yaml at all\nlist: [a, b\n");
    expect(values.mode).toBe("ask");
    expect(warnings).toHaveLength(3);
  });
});

describe("parseConfig", () => {
  it("maps every snake_case key to the camelCase config", () => {
    const { config, warnings } = parseConfig(
      [
        "mode: ask",
        "history: all",
        "max_commits: 5_000",
        "protect:",
        "  - src/payments/**",
        "  - 'lib\\auth\\*.ts'",
        'fix_patterns_extra: ["SEV\\\\d", postmortem]',
        "ignore_commits: [ABC1234, deadbeefcafe]",
        "hook_timeout_ms: 800",
      ].join("\n"),
    );
    expect(warnings).toEqual([]);
    expect(config).toEqual({
      mode: "ask",
      history: "all",
      maxCommits: 5000,
      protect: ["src/payments/**", "lib/auth/*.ts"],
      fixPatternsExtra: ["SEV\\d", "postmortem"],
      ignoreCommits: ["abc1234", "deadbeefcafe"],
      hookTimeoutMs: 800,
    });
  });

  it("falls back to defaults for bad values", () => {
    const { config, warnings } = parseConfig(
      [
        "mode: yolo",
        "history: forever",
        "max_commits: -3",
        "hook_timeout_ms: 5",
        "fix_patterns_extra: ['(unclosed', ok]",
        "ignore_commits: [not-a-sha, abcd]",
        "colour: blue",
      ].join("\n"),
    );
    expect(config.mode).toBe(DEFAULT_CONFIG.mode);
    expect(config.history).toBe(DEFAULT_CONFIG.history);
    expect(config.maxCommits).toBe(DEFAULT_CONFIG.maxCommits);
    expect(config.hookTimeoutMs).toBe(DEFAULT_CONFIG.hookTimeoutMs);
    expect(config.fixPatternsExtra).toEqual(["ok"]);
    expect(config.ignoreCommits).toEqual(["abcd"]);
    expect(warnings.length).toBe(7);
    expect(warnings.some((w) => w.includes("colour"))).toBe(true);
  });

  it("accepts history spans in days, weeks, months and years", () => {
    for (const h of ["90d", "6w", "18m", "3Y"]) {
      expect(parseConfig(`history: ${h}`).config.history).toBe(h.toLowerCase());
    }
    expect(parseConfig("history: 0y").config.history).toBe("all");
  });

  it("treats a scalar protect as a one-item list", () => {
    expect(parseConfig("protect: src/**").config.protect).toEqual(["src/**"]);
  });

  it("does not share list instances with DEFAULT_CONFIG", () => {
    const { config } = parseConfig("");
    config.protect.push("x");
    expect(DEFAULT_CONFIG.protect).toEqual([]);
  });
});

describe("loadConfig", () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it("returns defaults when the file is missing", () => {
    repo = makeRepo();
    expect(loadConfig(repo.dir)).toEqual(DEFAULT_CONFIG);
    expect(loadConfigWithWarnings(repo.dir).found).toBe(false);
  });

  it("returns defaults when the repo root does not exist", () => {
    expect(loadConfig("/definitely/not/a/real/path")).toEqual(DEFAULT_CONFIG);
  });

  it("reads .chesterton.yml from the repo root", () => {
    repo = makeRepo();
    repo.write(".chesterton.yml", "mode: warn-only\r\n# comment\r\nignore_commits:\r\n  - abc1234\r\n");
    const cfg = loadConfig(repo.dir);
    expect(cfg.mode).toBe("warn-only");
    expect(cfg.ignoreCommits).toEqual(["abc1234"]);
  });

  it("parses the shipped .chesterton.example.yml without warnings", () => {
    const text = readFileSync(join(__dirname, "..", ".chesterton.example.yml"), "utf8");
    const { config, warnings } = parseConfig(text);
    expect(warnings).toEqual([]);
    expect(config.protect).toEqual(["src/payments/**", "infra/*.tf"]);
    expect(config.fixPatternsExtra).toEqual(["SEV\\d", "postmortem"]);
    expect(config.ignoreCommits).toEqual([]);
  });

  it("survives binary garbage", () => {
    repo = makeRepo();
    repo.write(".chesterton.yml", "\u0000\u0001: [[[\n- - -\n:::\n");
    expect(loadConfig(repo.dir)).toEqual(DEFAULT_CONFIG);
  });
});
