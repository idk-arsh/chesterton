import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot as findRepoRoot, runGit } from "./git.js";
import { toPosix } from "./normalize.js";
import { loadConfig, loadConfigWithWarnings } from "./config.js";
import { buildIndexDetailed, isIndexFresh, isLockHeld } from "./index-builder.js";
import { splitLines } from "./normalize.js";
import { indexDir, loadIndex, loadIndexForFiles, loadMeta } from "./index-store.js";
import { analyzeChange } from "./analyze.js";
import { blameAt, gitDiffChanges } from "./diff-change.js";
import { explainLine } from "./why.js";
import { resolveRepoPath, toolPathToNative } from "./edit-diff.js";
import { capList } from "./decide.js";
import type { ChestertonIndex, Finding } from "./types.js";
import { armWatchdog } from "./watchdog.js";

export const VERSION = "0.1.0";

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  cwd: string;
  /** How long `check` waits for another index build to finish. Defaults to CHESTERTON_LOCK_WAIT_MS or 60 s. */
  lockWaitMs?: number;
  /** Hard limit on the whole process, armed by `index`. The real CLI kills itself; tests leave it out. */
  watchdog?: (ms: number) => void;
}

const DEFAULT_LOCK_WAIT_MS = 60_000;
/**
 * `index` gives up for good after this long. Its git calls share a 5 minute budget, so only a
 * stuck process gets here, for example one caught in a runaway regex from the repo's config.
 */
export const INDEX_WATCHDOG_MS = 10 * 60_000;
const LOCK_POLL_MS = 250;

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

Exit codes: 0 ok, 1 strong findings from check, a failed index, or a why line that does not exist,
2 usage or setup error (check also exits 2 when another index build is still running after 60 s;
set CHESTERTON_LOCK_WAIT_MS to change the wait).`;

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
  io.watchdog?.(INDEX_WATCHDOG_MS);
  try {
    const cfg = loadConfig(root);
    const { index: idx, outcome } = buildIndexDetailed(root, cfg, { full });
    if (!quiet) {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (outcome === "busy") io.out("Another index build is running. It will save the index when it finishes.");
      else if (outcome === "no-commits") io.out("No commits yet, nothing to index.");
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
    // "file:line" or "file line" in one argument (the slash command quotes it); the path may hold spaces.
    const m = /^(.*?)(?::|\s+)(\d+)(?::\d+)?$/.exec(a);
    if (!m) throw new UsageError(`expected <file>:<line>, got "${a}"`);
    file = m[1]!;
    lineText = m[2]!;
  }
  const line = Number(lineText);
  if (!file || !/^\d+$/.test(lineText) || line < 1) throw new UsageError(`"${lineText}" is not a line number`);
  return { file, line };
}

/**
 * The repo-relative path of a `why` argument, or null when it is outside the repo. Shares the hook's
 * resolution (native realpath on both sides), since the root comes back with links resolved and 8.3
 * short names expanded while the argument uses whatever path the shell is in.
 */
function toRepoPath(root: string, cwd: string, file: string): string | null {
  const p = toolPathToNative(file);
  return resolveRepoPath(root, isAbsolute(p) ? p : resolve(cwd, p))?.rel ?? null;
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
  // A missing file, a directory, or a line past the end is an error, not an answer.
  const problem = whyProblem(root, rel, line);
  if (problem) {
    io.err(`chesterton: ${problem}`);
    return 1;
  }
  io.out(explainLine(root, rel, line, loadIndexForFiles(root, [rel], { allCommits: true })));
  return 0;
}

function whyProblem(root: string, rel: string, line: number): string | null {
  const full = resolve(root, rel);
  let st;
  try {
    st = statSync(full);
  } catch {
    return `${rel}: file not found in the working tree.`;
  }
  if (st.isDirectory()) return `${rel} is a directory, not a file.`;
  let count: number;
  try {
    count = splitLines(readFileSync(full, "utf8")).length;
  } catch (e) {
    return `${rel}: cannot read the file (${(e as Error).message}).`;
  }
  if (line > count) return `${rel}:${line}: no such line (the file has ${plural(count, "line")}).`;
  return null;
}

function sleepMs(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* spin */
    }
  }
}

function lockWaitMs(io: CliIO): number {
  if (typeof io.lockWaitMs === "number" && io.lockWaitMs >= 0) return io.lockWaitMs;
  const env = Number(process.env.CHESTERTON_LOCK_WAIT_MS);
  return Number.isFinite(env) && env >= 0 ? env : DEFAULT_LOCK_WAIT_MS;
}

/**
 * An index at HEAD for `check`. When another build holds the lock, waits for it (polling) instead
 * of checking against an empty or stale index, which would pass a change that removes a fix.
 * Returns null, after printing why, when no fresh index can be had.
 */
function freshIndexForCheck(io: CliIO, root: string, cfg: ReturnType<typeof loadConfig>): ChestertonIndex | null {
  let idx: ChestertonIndex | null = loadIndex(root);
  if (isIndexFresh(root, idx)) return idx;
  io.err(idx ? "chesterton: index is out of date, updating it first." : "chesterton: no index yet, building it first.");
  const waitMs = lockWaitMs(io);
  const until = Date.now() + waitMs;
  let said = false;
  for (;;) {
    let res;
    try {
      res = buildIndexDetailed(root, cfg);
    } catch (e) {
      io.err(`chesterton: index failed: ${(e as Error).message}`);
      return null;
    }
    if (res.outcome !== "busy") return res.index;
    // Someone else is building. Their result may already be what we need.
    idx = loadIndex(root);
    if (isIndexFresh(root, idx)) return idx;
    if (Date.now() >= until) break;
    if (!said) {
      io.err("chesterton: another index build is running, waiting for it to finish.");
      said = true;
    }
    do sleepMs(Math.max(0, Math.min(LOCK_POLL_MS, until - Date.now())));
    while (Date.now() < until && isLockHeld(root));
  }
  io.err(
    `chesterton: another index build is still running after ${Math.round(waitMs / 1000)}s, so the diff was not checked. ` +
      `Run check again when it finishes, or set CHESTERTON_LOCK_WAIT_MS to wait longer.`,
  );
  return null;
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

  const idx = freshIndexForCheck(io, root, cfg);
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
  const idx = loadMeta(root);
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
    lines.push(`Fix commits: ${idx.fixCommits}`);
    lines.push(`Files:       ${idx.files}`);
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
    watchdog: armWatchdog,
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
