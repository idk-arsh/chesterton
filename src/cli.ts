import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot as findRepoRoot, runGit } from "./git.js";
import { toPosix } from "./normalize.js";
import { loadConfig, loadConfigWithWarnings } from "./config.js";
import { buildIndex, isIndexFresh } from "./index-builder.js";
import { indexDir, loadIndex } from "./index-store.js";
import { analyzeChange } from "./analyze.js";
import { blameAt, gitDiffChanges } from "./diff-change.js";
import { explainLine } from "./why.js";
import { capList } from "./decide.js";
import type { ChestertonIndex, Finding } from "./types.js";

export const VERSION = "0.1.0";

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  cwd: string;
}

const HELP = `chesterton ${VERSION}
Stops Claude from quietly undoing past bug fixes.

Usage:
  chesterton index [--full] [--quiet]     Build or update the fix index for this repo
  chesterton why <file>:<line>            Explain why a line is there, from git history
  chesterton check [--staged | --base <rev>]
                                          Check a diff against past fixes. Exits 1 on strong hits.
                                          Default: uncommitted changes vs HEAD.
                                          --staged: what the next commit would record.
                                          --base <rev>: everything since the merge base with <rev>.
  chesterton status                       Show whether the index exists and is up to date
  chesterton --version
  chesterton help

Exit codes: 0 ok, 1 strong findings from check (or index failed), 2 usage or setup error.`;

class UsageError extends Error {}

interface Parsed {
  command: string;
  flags: Map<string, string | true>;
  positionals: string[];
}

function parseArgs(argv: string[], valueFlags: Set<string>): Parsed {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--") {
      positionals.push(...rest.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (valueFlags.has(name)) {
        const v = eq > 0 ? a.slice(eq + 1) : rest[++i];
        if (v === undefined || v === "") throw new UsageError(`--${name} needs a value`);
        flags.set(name, v);
      } else {
        if (eq > 0) throw new UsageError(`--${name} does not take a value`);
        flags.set(name, true);
      }
      continue;
    }
    positionals.push(a);
  }
  return { command, flags, positionals };
}

function allowOnly(p: Parsed, allowed: string[], maxPositionals: number) {
  for (const f of p.flags.keys()) {
    if (!allowed.includes(f)) throw new UsageError(`unknown option --${f} for "${p.command}"`);
  }
  if (p.positionals.length > maxPositionals) {
    throw new UsageError(`unexpected argument "${p.positionals[maxPositionals]}" for "${p.command}"`);
  }
}

/** Run the CLI. Returns the exit code. Never throws. */
export function main(argv: string[], io: CliIO = defaultIO()): number {
  try {
    const first = argv[0];
    if (first === "--version" || first === "-v" || first === "version") {
      io.out(VERSION);
      return 0;
    }
    if (first === undefined || first === "help" || first === "--help" || first === "-h") {
      io.out(HELP);
      return 0;
    }
    const parsed = parseArgs(argv, new Set(["base"]));
    switch (parsed.command) {
      case "index":
        allowOnly(parsed, ["full", "quiet"], 0);
        return cmdIndex(io, parsed.flags.has("full"), parsed.flags.has("quiet"));
      case "why":
        allowOnly(parsed, [], 2);
        return cmdWhy(io, parsed.positionals);
      case "check": {
        allowOnly(parsed, ["staged", "base"], 0);
        const base = parsed.flags.get("base");
        if (parsed.flags.has("staged") && base) throw new UsageError("use either --staged or --base, not both");
        return cmdCheck(io, { staged: parsed.flags.has("staged"), base: typeof base === "string" ? base : undefined });
      }
      case "status":
        allowOnly(parsed, [], 0);
        return cmdStatus(io);
      default:
        throw new UsageError(`unknown command "${parsed.command}"`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`chesterton: ${e.message}\nRun "chesterton help" for usage.`);
      return 2;
    }
    io.err(`chesterton: ${(e as Error).message ?? String(e)}`);
    return 2;
  }
}

function needRepo(io: CliIO): string | null {
  const root = findRepoRoot(io.cwd);
  if (!root) io.err("chesterton: not inside a git repository.");
  return root;
}

function cmdIndex(io: CliIO, full: boolean, quiet: boolean): number {
  const root = findRepoRoot(io.cwd);
  if (!root) {
    if (!quiet) io.err("chesterton: not inside a git repository.");
    return 2;
  }
  const started = Date.now();
  try {
    const cfg = loadConfig(root);
    const idx = buildIndex(root, cfg, { full });
    if (!quiet) {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (!idx.head) io.out("No commits yet, nothing to index.");
      else
        io.out(
          `Indexed ${plural(Object.keys(idx.commits).length, "fix commit")} across ${plural(Object.keys(idx.files).length, "file")} at ${idx.head.slice(0, 7)} in ${secs}s.`,
        );
    }
    return 0;
  } catch (e) {
    if (!quiet) io.err(`chesterton: index failed: ${(e as Error).message}`);
    return 1;
  }
}

/** Split "src/a.ts:42" (or "C:\\x\\a.ts:42", or "src/a.ts 42") into path and line. */
export function parseFileLine(args: string[]): { file: string; line: number } {
  if (args.length === 0) throw new UsageError("why needs <file>:<line>, for example: chesterton why src/net/socket.ts:42");
  let file: string;
  let lineText: string;
  if (args.length === 2) {
    file = args[0]!;
    lineText = args[1]!;
  } else {
    const a = args[0]!;
    const m = /^(.*?):(\d+)(?::\d+)?$/.exec(a);
    if (!m) throw new UsageError(`expected <file>:<line>, got "${a}"`);
    file = m[1]!;
    lineText = m[2]!;
  }
  const line = Number(lineText);
  if (!file || !/^\d+$/.test(lineText) || line < 1) throw new UsageError(`"${lineText}" is not a line number`);
  return { file, line };
}

function toRepoPath(root: string, cwd: string, file: string): string | null {
  const abs = isAbsolute(file) ? file : resolve(cwd, file);
  let rootReal = root;
  let absReal = abs;
  try {
    rootReal = realpathSync(root);
  } catch {
    /* keep as is */
  }
  try {
    absReal = realpathSync(abs);
  } catch {
    /* file may not exist; explainLine reports that */
  }
  const rel = relative(rootReal, absReal);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return toPosix(rel);
}

function cmdWhy(io: CliIO, args: string[]): number {
  const { file, line } = parseFileLine(args);
  const root = needRepo(io);
  if (!root) return 2;
  const rel = toRepoPath(root, io.cwd, file);
  if (rel === null) {
    io.err(`chesterton: ${file} is outside this repository (${root}).`);
    return 2;
  }
  io.out(explainLine(root, rel, line, loadIndex(root)));
  return 0;
}

function cmdCheck(io: CliIO, range: { staged: boolean; base?: string }): number {
  const root = needRepo(io);
  if (!root) return 2;
  const cfg = loadConfig(root);

  let diff;
  try {
    diff = gitDiffChanges(root, { staged: range.staged, base: range.base });
  } catch (e) {
    io.err(`chesterton: could not read the diff: ${(e as Error).message}`);
    return 2;
  }
  if (diff.changes.length === 0) {
    io.out("Nothing to check.");
    return 0;
  }

  let idx: ChestertonIndex | null = loadIndex(root);
  if (!isIndexFresh(root, idx)) {
    io.err(idx ? "chesterton: index is out of date, updating it first." : "chesterton: no index yet, building it first.");
    try {
      idx = buildIndex(root, cfg);
    } catch (e) {
      io.err(`chesterton: index failed: ${(e as Error).message}`);
      return 2;
    }
  }
  if (!idx) return 2;

  const head = headSha(root);
  const findings: Finding[] = [];
  for (const change of diff.changes) {
    // Records are keyed by the file's path at HEAD. When the pre-image is HEAD, a rename in the
    // diff has not been committed yet, so look the file up by its old path.
    const prePath = change.oldPath ?? change.relPath;
    const indexPath = diff.preImage === head ? prePath : change.relPath;
    const pre = change.isNewFile ? null : showFile(root, diff.preImage, prePath);
    findings.push(
      ...analyzeChange(
        root,
        { relPath: indexPath, removed: change.removed, added: change.added, isNewFile: change.isNewFile },
        idx,
        cfg,
        {
          // Removed lines are numbered in the pre-image and are gone from the working tree,
          // so blame the pre-image revision instead of the working tree.
          blame: (r, _p, s, e, t) => blameAt(r, prePath, s, e, diff.preImage, t),
          currentContent: pre,
        },
      ).map((f) => ({ ...f, file: change.relPath })),
    );
  }

  const strong = findings.filter((f) => f.strength === "strong");
  const weak = findings.filter((f) => f.strength === "weak");
  if (findings.length === 0) {
    io.out(`Checked ${plural(diff.changes.length, "file")}. No past fixes touched.`);
    return 0;
  }
  for (const f of [...strong, ...weak]) io.out(formatFinding(f));
  io.out(
    `${plural(strong.length, "strong finding")}, ${plural(weak.length, "weak finding")} in ${plural(diff.changes.length, "changed file")}.`,
  );
  return strong.length > 0 ? 1 : 0;
}

export function formatFinding(f: Finding): string {
  const what =
    f.kind === "removes-fix" ? "removes lines added by a bug fix" : "puts back lines a bug fix removed";
  const c = f.fix;
  const out = [
    `${f.strength.toUpperCase()}  ${f.file}: ${what}`,
    `  ${c.sha.slice(0, 7)}  ${c.date.slice(0, 10)}  ${c.author}  ${c.subject}`,
  ];
  if (c.reasons.length) out.push(`  Why it looks like a fix: ${c.reasons.join("; ")}`);
  if (c.refs.length) out.push(`  Refs: ${c.refs.join(", ")}`);
  if (c.testFiles.length) out.push(`  Tests: ${capList(c.testFiles)}`);
  if (f.lines.length) {
    out.push("  Lines:");
    for (const l of f.lines) out.push(`    ${l}`);
  }
  out.push(`  Read it with: git show ${c.sha.slice(0, 7)}`);
  out.push("");
  return out.join("\n");
}

function cmdStatus(io: CliIO): number {
  const root = needRepo(io);
  if (!root) return 2;
  const head = headSha(root);
  const { config, warnings, found } = loadConfigWithWarnings(root);
  const idx = loadIndex(root);
  const lines = [`Repo:        ${root}`, `HEAD:        ${head ? head.slice(0, 7) : "(no commits)"}`];
  let dir = "";
  try {
    dir = indexDir(root);
  } catch {
    /* ignore */
  }
  if (!idx) {
    lines.push(`Index:       not built yet${dir ? ` (${toPosix(dir)})` : ""}. Run "chesterton index".`);
  } else {
    const fresh = head !== null && idx.head === head;
    lines.push(`Index:       ${toPosix(dir)}`);
    lines.push(`Built at:    ${idx.builtAt} (HEAD ${idx.head.slice(0, 7) || "none"})`);
    lines.push(`Up to date:  ${fresh ? "yes" : "no, HEAD has moved. Run \"chesterton index\"."}`);
    lines.push(`Fix commits: ${Object.keys(idx.commits).length}`);
    lines.push(`Files:       ${Object.keys(idx.files).length}`);
  }
  lines.push(`Config:      ${found ? ".chesterton.yml" : "defaults (no .chesterton.yml)"}, mode ${config.mode}, history ${config.history}`);
  for (const w of warnings) lines.push(`  warning: ${w}`);
  io.out(lines.join("\n"));
  return 0;
}

function headSha(root: string): string | null {
  try {
    return runGit(["rev-parse", "--verify", "--quiet", "HEAD"], root, 5_000).trim() || null;
  } catch {
    return null;
  }
}

function showFile(root: string, rev: string, path: string): string | null {
  try {
    return runGit(["show", `${rev}:${path}`], root, 10_000);
  } catch {
    return null;
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function defaultIO(): CliIO {
  return {
    out: (t) => process.stdout.write(t.endsWith("\n") ? t : `${t}\n`),
    err: (t) => process.stderr.write(t.endsWith("\n") ? t : `${t}\n`),
    cwd: process.cwd(),
  };
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = main(process.argv.slice(2));
}
