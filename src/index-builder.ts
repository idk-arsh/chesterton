import { randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { ChestertonConfig, ChestertonIndex, FileFixRecord, FixCommit, LineEntry } from "./types.js";
import { INDEX_VERSION } from "./types.js";
import { classifyCommit, isNoiseFile, type CommitFileChange } from "./classify.js";
import { emptyIndex, indexDir, loadIndex, saveIndex } from "./index-store.js";
import { headSha, isAncestor, runGit, runGitWithInput, shallowInfo } from "./git.js";
import { hashLine, isTrivial, normalizeLine, toPosix } from "./normalize.js";

export interface BuildOptions {
  full?: boolean;
  timeoutMs?: number;
}

export const LOCK_FILE = "index.lock";
const STALE_LOCK_MS = 5 * 60_000;
/** A lock whose owner is still alive is honored this long, however old its mtime. */
const MAX_LIVE_LOCK_MS = 30 * 60_000;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_TEXT = 200;

/** One non-merge commit from the metadata pass. */
interface CommitMeta {
  sha: string;
  parents: number;
  date: string;
  author: string;
  subject: string;
  body: string;
  files: CommitFileChange[];
}

/** cfg.history ("3y", "18m", "6w", "90d", "all", or a date) to a `--since` argument, or null for no limit. */
export function sinceArg(history: string | undefined): string | null {
  const h = (history ?? "").trim().toLowerCase();
  if (!h || h === "all") return null;
  const m = /^(\d+)\s*(y|yr|yrs|year|years|m|mo|month|months|w|week|weeks|d|day|days)$/.exec(h);
  if (m) {
    const n = m[1]!;
    const u = m[2]!;
    const unit = u.startsWith("y") ? "years" : u.startsWith("m") ? "months" : u.startsWith("w") ? "weeks" : "days";
    return `--since=${n}.${unit}.ago`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(h)) return `--since=${h}`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Metadata pass: one `git log` for every non-merge commit in range, with status + numstat.
// ---------------------------------------------------------------------------------------------

/**
 * Record and field separators for the metadata pass. A commit message can contain any control
 * character, so each run adds a random token that no message will contain.
 */
export interface MetaSeparators {
  record: string;
  field: string;
}

export function newSeparators(): MetaSeparators {
  const token = randomBytes(8).toString("hex");
  return { record: `\x1e${token}\x1e`, field: `\x1f${token}\x1f` };
}

function metaFormat(sep: MetaSeparators): string {
  const esc = (s: string) => s.replace(/%/g, "%%").replace(/\x1e/g, "%x1e").replace(/\x1f/g, "%x1f");
  const r = esc(sep.record);
  const f = esc(sep.field);
  return `--format=${r}%H${f}%P${f}%aI${f}%an${f}%s${f}%b${f}`;
}

const DEFAULT_SEPARATORS: MetaSeparators = { record: "\x1e", field: "\x1f" };

function logMeta(repoRoot: string, range: string[], cfg: ChestertonConfig, timeoutMs: number): CommitMeta[] {
  const sep = newSeparators();
  const args = [
    "log",
    "--no-merges",
    "--topo-order",
    "--no-show-signature",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "-M",
    "--raw",
    "--numstat",
    "-z",
    metaFormat(sep),
  ];
  const since = sinceArg(cfg.history);
  if (since) args.push(since);
  if (cfg.maxCommits && cfg.maxCommits > 0) args.push(`-n${Math.floor(cfg.maxCommits)}`);
  args.push(...range, "--");
  return parseMeta(runGit(args, repoRoot, timeoutMs), sep);
}

export function parseMeta(out: string, sep: MetaSeparators = DEFAULT_SEPARATORS): CommitMeta[] {
  const commits: CommitMeta[] = [];
  for (const chunk of out.split(sep.record)) {
    if (!chunk.trim()) continue;
    const parts: string[] = [];
    let pos = 0;
    for (let i = 0; i < 6; i++) {
      const next = chunk.indexOf(sep.field, pos);
      if (next < 0) break;
      parts.push(chunk.slice(pos, next));
      pos = next + sep.field.length;
    }
    if (parts.length < 6) continue;
    const [sha, parents, date, author, subject, body] = parts as [string, string, string, string, string, string];
    commits.push({
      sha: sha.trim(),
      parents: parents.trim() ? parents.trim().split(/\s+/).length : 0,
      date,
      author,
      subject,
      body: body.trim(),
      files: parseFileStats(chunk.slice(pos)),
    });
  }
  return commits;
}

/** Parse the `--raw --numstat -z` tail of one commit into per-file changes keyed by the new path. */
function parseFileStats(rest: string): CommitFileChange[] {
  const tokens = rest
    .split("\0")
    .map((t) => t.replace(/^\n+/, ""))
    .filter((t) => t !== "");
  const byPath = new Map<string, CommitFileChange>();
  const get = (path: string): CommitFileChange => {
    let f = byPath.get(path);
    if (!f) {
      f = { path, status: "M", added: 0, removed: 0 };
      byPath.set(path, f);
    }
    return f;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith(":")) {
      const status = t.slice(t.lastIndexOf(" ") + 1);
      const letter = status.charAt(0);
      if (letter === "R" || letter === "C") {
        const oldPath = toPosix(tokens[++i] ?? "");
        const newPath = toPosix(tokens[++i] ?? "");
        const f = get(newPath);
        f.status = letter;
        f.oldPath = oldPath;
      } else {
        const f = get(toPosix(tokens[++i] ?? ""));
        f.status = letter || "M";
      }
      continue;
    }
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(t);
    if (!m) continue;
    let path = m[3]!;
    if (path === "") {
      i++; // old path
      path = tokens[++i] ?? "";
    }
    const f = get(toPosix(path));
    f.added = m[1] === "-" ? 0 : Number(m[1]);
    f.removed = m[2] === "-" ? 0 : Number(m[2]);
  }
  return [...byPath.values()];
}

// ---------------------------------------------------------------------------------------------
// Patch pass: one `git log --stdin --no-walk -p -U0` for the fix commits only.
// ---------------------------------------------------------------------------------------------

const LOCKFILE_EXCLUDES = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "poetry.lock",
  "go.sum",
  "Gemfile.lock",
  "composer.lock",
].map((n) => `:(exclude,glob)**/${n}`);

function readFixPatches(repoRoot: string, shas: string[], timeoutMs: number): Map<string, FileFixRecord[]> {
  if (shas.length === 0) return new Map();
  const args = [
    "log",
    "--stdin",
    "--no-walk=unsorted",
    "--no-show-signature",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "-p",
    "-M",
    "--unified=0",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--format=%x1e%H",
    "--",
    ".",
    ...LOCKFILE_EXCLUDES,
  ];
  return parsePatches(runGitWithInput(args, repoRoot, shas.join("\n") + "\n", timeoutMs));
}

/** Undo git's C-style quoting of unusual paths ("a\tb", octal escapes for raw bytes). */
export function unquotePath(p: string): string {
  if (!(p.length >= 2 && p.startsWith('"') && p.endsWith('"'))) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\") {
      for (const b of Buffer.from(c, "utf8")) bytes.push(b);
      continue;
    }
    const n = body[i + 1] ?? "";
    if (/[0-7]/.test(n)) {
      const oct = body.slice(i + 1, i + 4);
      bytes.push(parseInt(oct, 8));
      i += 3;
    } else {
      bytes.push(simple[n] ?? n.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function headerPath(raw: string, prefix: string): string | null {
  let p = raw.replace(/\t$/, "");
  if (p === "/dev/null") return null;
  p = unquotePath(p);
  if (p.startsWith(prefix)) p = p.slice(prefix.length);
  return toPosix(p);
}

function entry(raw: string, line: number): LineEntry | null {
  const norm = normalizeLine(raw);
  if (isTrivial(norm)) return null;
  return { hash: hashLine(norm), text: raw.replace(/\r$/, "").trim().slice(0, MAX_TEXT), line };
}

/** Drop lines that a commit both added and removed in the same file (moves, reindents). */
function dropMoves(rec: FileFixRecord): void {
  const addedH = new Set(rec.added.map((e) => e.hash));
  const removedH = new Set(rec.removed.map((e) => e.hash));
  rec.added = rec.added.filter((e) => !removedH.has(e.hash));
  rec.removed = rec.removed.filter((e) => !addedH.has(e.hash));
}

export function parsePatches(out: string): Map<string, FileFixRecord[]> {
  const result = new Map<string, FileFixRecord[]>();
  for (const chunk of out.split("\x1e")) {
    if (!chunk.trim()) continue;
    const lines = chunk.split("\n");
    const sha = lines[0]!.trim();
    const records: FileFixRecord[] = [];

    let oldP: string | null = null;
    let newP: string | null = null;
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    let sawHeaders = false;
    let added: LineEntry[] = [];
    let removed: LineEntry[] = [];
    let oldLeft = 0;
    let newLeft = 0;
    let oldLine = 0;
    let newLine = 0;

    const flush = () => {
      const path = sawHeaders ? newP : renameTo;
      const prev = sawHeaders ? oldP : renameFrom;
      if (path && !isNoiseFile(path) && (added.length || removed.length)) {
        const rec: FileFixRecord = { sha, path, added, removed };
        if (prev && prev !== path) rec.oldPath = prev;
        dropMoves(rec);
        if (rec.added.length || rec.removed.length) records.push(rec);
      }
      oldP = newP = renameFrom = renameTo = null;
      sawHeaders = false;
      added = [];
      removed = [];
      oldLeft = newLeft = 0;
    };

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (oldLeft > 0 || newLeft > 0) {
        const c = line.charAt(0);
        if (c === "-" && oldLeft > 0) {
          const e = entry(line.slice(1), oldLine);
          if (e) removed.push(e);
          oldLine++;
          oldLeft--;
          continue;
        }
        if (c === "+" && newLeft > 0) {
          const e = entry(line.slice(1), newLine);
          if (e) added.push(e);
          newLine++;
          newLeft--;
          continue;
        }
        if (c === " ") {
          oldLine++;
          newLine++;
          oldLeft = Math.max(0, oldLeft - 1);
          newLeft = Math.max(0, newLeft - 1);
          continue;
        }
        if (c === "\\") continue;
        // Anything else means the hunk ended early; fall through to header handling.
        oldLeft = newLeft = 0;
      }
      if (line.startsWith("diff --git ")) {
        flush();
      } else if (line.startsWith("rename from ")) {
        renameFrom = toPosix(unquotePath(line.slice("rename from ".length)));
      } else if (line.startsWith("rename to ")) {
        renameTo = toPosix(unquotePath(line.slice("rename to ".length)));
      } else if (line.startsWith("--- ")) {
        oldP = headerPath(line.slice(4), "a/");
        sawHeaders = true;
      } else if (line.startsWith("+++ ")) {
        newP = headerPath(line.slice(4), "b/");
        sawHeaders = true;
      } else if (line.startsWith("@@ ")) {
        const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (m) {
          oldLine = Number(m[1]);
          oldLeft = m[2] === undefined ? 1 : Number(m[2]);
          newLine = Number(m[3]);
          newLeft = m[4] === undefined ? 1 : Number(m[4]);
        }
      }
    }
    flush();
    if (records.length) result.set(sha, [...(result.get(sha) ?? []), ...records]);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------------------------

export class IndexLockError extends Error {}

/** True when the lock names a live process on this machine. False when unknown. */
function ownerAlive(p: string): boolean {
  try {
    const o = JSON.parse(readFileSync(p, "utf8")) as { pid?: unknown; host?: unknown };
    if (typeof o.pid !== "number" || !Number.isInteger(o.pid) || o.pid <= 0) return false;
    if (typeof o.host === "string" && o.host !== hostname()) return false;
    if (o.pid === process.pid) return false;
    process.kill(o.pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Take the build lock. Returns the lock path, or null when another build holds it.
 * Throws IndexLockError when the lock cannot be created for any other reason (read-only dir...).
 * A lock is stale once its mtime is over 5 minutes old, unless its owner is still running (a long
 * full build refreshes the mtime as it goes, and a live owner is trusted for up to 30 minutes).
 */
function acquireLock(dir: string): string | null {
  const p = join(dir, LOCK_FILE);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(p, "wx");
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }));
      } finally {
        closeSync(fd);
      }
      return p;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw new IndexLockError(`cannot create ${p}: ${(err as Error).message}`);
      try {
        const age = Date.now() - statSync(p).mtimeMs;
        if (age > STALE_LOCK_MS && (age > MAX_LIVE_LOCK_MS || !ownerAlive(p))) {
          unlinkSync(p);
          continue;
        }
      } catch {
        continue; // vanished between open and stat: try again
      }
      return null;
    }
  }
  return null;
}

/** Keep a held lock fresh during a long build so nobody takes it over. */
function touchLock(p: string): void {
  try {
    const now = new Date();
    utimesSync(p, now, now);
  } catch {
    /* ignore */
  }
}

/** True when another process holds a lock that acquireLock would honor. */
export function isLockHeld(repoRoot: string): boolean {
  try {
    const p = join(indexDir(repoRoot), LOCK_FILE);
    const age = Date.now() - statSync(p).mtimeMs;
    return age <= STALE_LOCK_MS || (age <= MAX_LIVE_LOCK_MS && ownerAlive(p));
  } catch {
    return false;
  }
}

function releaseLock(p: string): void {
  try {
    unlinkSync(p);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------

function trackedFiles(repoRoot: string, head: string, timeoutMs: number): Set<string> {
  const out = runGit(["ls-tree", "-r", "-z", "--name-only", "--full-tree", head], repoRoot, timeoutMs);
  return new Set(out.split("\0").filter(Boolean).map(toPosix));
}

/** What a build did. */
export type BuildOutcome =
  /** Built and saved a new index. */
  | "built"
  /** The saved index was already at HEAD. */
  | "up-to-date"
  /** Another build holds the lock; the saved index (or an empty one) came back instead. */
  | "busy"
  /** The repo has no commits. */
  | "no-commits";

/**
 * Build (or incrementally update) the fix index and save it.
 * Incremental when a saved index exists and its head is an ancestor of HEAD; otherwise full.
 * Returns an empty index for a repo with no commits. When another build holds the lock,
 * returns the saved index (or an empty one) without waiting.
 * Throws when <git-dir>/chesterton cannot be created or written.
 */
export function buildIndex(repoRoot: string, cfg: ChestertonConfig, opts: BuildOptions = {}): ChestertonIndex {
  return buildIndexDetailed(repoRoot, cfg, opts).index;
}

/** buildIndex, plus what happened, so callers can tell "busy" from "nothing to index". */
export function buildIndexDetailed(
  repoRoot: string,
  cfg: ChestertonConfig,
  opts: BuildOptions = {},
): { index: ChestertonIndex; outcome: BuildOutcome } {
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const remaining = () => Math.max(1_000, deadline - Date.now());

  const dir = indexDir(repoRoot);
  const head = headSha(repoRoot);
  if (!head) return { index: emptyIndex(), outcome: "no-commits" };

  const lock = acquireLock(dir);
  if (!lock) return { index: loadIndex(repoRoot) ?? emptyIndex(), outcome: "busy" };

  try {
    const prev = opts.full ? null : loadIndex(repoRoot);
    if (prev && prev.head === head) return { index: prev, outcome: "up-to-date" };
    const base = prev && prev.head && isAncestor(repoRoot, prev.head, head, remaining()) ? prev : null;

    const range = base ? [`${base.head}..${head}`] : [head];
    const metas = logMeta(repoRoot, range, cfg, remaining());
    touchLock(lock);

    // A shallow clone's boundary commits have no parents in the visible history, so their diff
    // claims every line of every file. They can never be fix candidates.
    const shallow = shallowInfo(repoRoot);
    const commits: Record<string, FixCommit> = {};
    const fixShas: string[] = [];
    for (const m of metas) {
      if (shallow.boundary.has(m.sha) || (shallow.shallow && m.parents === 0)) continue;
      const r = classifyCommit({ sha: m.sha, subject: m.subject, body: m.body, files: m.files, parents: m.parents }, cfg);
      if (!r.isFix) continue;
      fixShas.push(m.sha);
      commits[m.sha] = {
        sha: m.sha,
        date: m.date,
        author: m.author,
        subject: m.subject,
        score: r.score,
        reasons: r.reasons,
        refs: r.refs,
        testFiles: r.testFiles,
      };
    }
    const recordsBySha = readFixPatches(repoRoot, fixShas, remaining());
    touchLock(lock);

    // Walk newest to oldest. `forward` maps a path as it existed at the commit being visited to the
    // path it has at HEAD (null when the file was deleted later). Each commit only sees renames and
    // deletes from commits newer than itself, which is exactly what its records need.
    const forward = new Map<string, string | null>();
    const resolvePath = (p: string): string | null => (forward.has(p) ? forward.get(p)! : p);
    // No prototype: a file named `constructor` or `__proto__` must be a key like any other.
    const files: Record<string, FileFixRecord[]> = Object.create(null);
    const add = (key: string, rec: FileFixRecord) => {
      (files[key] ??= []).push(rec);
    };
    for (const m of metas) {
      for (const rec of recordsBySha.get(m.sha) ?? []) {
        const key = resolvePath(rec.path);
        if (key) add(key, rec);
      }
      for (const f of m.files) {
        if (f.status === "R" && f.oldPath) forward.set(f.oldPath, resolvePath(f.path));
        else if (f.status === "D") forward.set(f.path, null);
      }
    }

    // Carry the previous index forward through renames and deletes in the new commits.
    if (base) {
      for (const [sha, c] of Object.entries(base.commits)) if (!commits[sha]) commits[sha] = c;
      for (const [oldKey, recs] of Object.entries(base.files)) {
        const key = resolvePath(oldKey);
        if (!key) continue;
        for (const rec of recs) add(key, rec);
      }
    }

    // Drop anything that is not a tracked file at HEAD (deleted files, merge-only renames).
    const tracked = trackedFiles(repoRoot, head, remaining());
    for (const key of Object.keys(files)) if (!tracked.has(key)) delete files[key];

    const idx: ChestertonIndex = { version: INDEX_VERSION, head, builtAt: new Date().toISOString(), commits, files };
    saveIndex(repoRoot, idx);
    return { index: idx, outcome: "built" };
  } finally {
    releaseLock(lock);
  }
}

/** True when idx was built at the current HEAD. */
export function isIndexFresh(repoRoot: string, idx: { head: string } | null): boolean {
  if (!idx) return false;
  const head = headSha(repoRoot);
  return head !== null && idx.head === head;
}
