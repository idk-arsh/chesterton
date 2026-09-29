import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChestertonIndex, FileFixRecord, FixCommit } from "./types.js";
import { INDEX_VERSION } from "./types.js";
import { GitError, locateRepo } from "./git.js";
import { toPosix } from "./normalize.js";

// On-disk layout, all inside <git-dir>/chesterton:
//
//   meta.json               { version, id, head, builtAt, fixCommits, files }   small, read at session start
//   manifest-<id>.json      { version, id, files: { path: shard } }             which shard holds each file
//   commits-<id>.json       { version, id, commits }                            every fix commit
//   shards/<hash>.json      { version, path, records, commits }                 one file's records plus the
//                                                                               fix commits they point at
//
// An edit check reads meta, the manifest and one shard, never the whole index. Shards are named by
// a hash of their content, so an incremental build only writes the shards that changed. meta.json
// is written last and names the generation, so a reader never mixes two builds.

/** The file a reader opens first. Its presence and version decide whether an index exists. */
export const INDEX_FILE = "meta.json";
/** The single-file index written by version 2. Removed on the next save. */
export const LEGACY_INDEX_FILE = "index.json";
const SHARD_DIR = "shards";
const ID_RE = /^[0-9a-z-]{1,64}$/;
const SHARD_RE = /^[0-9a-f]{32}$/;

/** What meta.json holds. */
export interface IndexMeta {
  version: typeof INDEX_VERSION;
  /** Generation id: names the manifest and commits files of this build. */
  id: string;
  head: string;
  builtAt: string;
  /** Number of fix commits. */
  fixCommits: number;
  /** Number of files with records. */
  files: number;
}

const dirCache = new Map<string, string>();

/**
 * Absolute `<git-dir>/chesterton`, created if missing.
 * Uses the per-worktree git dir, so each worktree (which can sit at its own HEAD) keeps its own index.
 * Throws GitError when repoRoot is not inside a git repo.
 */
export function indexDir(repoRoot: string): string {
  const cached = dirCache.get(repoRoot);
  if (cached && existsSync(cached)) return cached;
  const loc = locateRepo(repoRoot);
  if (!loc) throw new GitError(`not a git repository: ${repoRoot}`);
  const dir = join(loc.gitDir, "chesterton");
  mkdirSync(dir, { recursive: true });
  dirCache.set(repoRoot, dir);
  return dir;
}

// ---------- validation ----------

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const isStrArr = (x: unknown): boolean => Array.isArray(x) && x.every((v) => typeof v === "string");

function isValidEntries(x: unknown): boolean {
  if (!Array.isArray(x)) return false;
  for (const e of x) {
    if (!isObj(e) || typeof e.hash !== "string" || typeof e.text !== "string" || typeof e.line !== "number") return false;
  }
  return true;
}

function isValidCommit(x: unknown): x is FixCommit {
  return (
    isObj(x) &&
    typeof x.sha === "string" &&
    typeof x.date === "string" &&
    typeof x.author === "string" &&
    typeof x.subject === "string" &&
    typeof x.score === "number" &&
    isStrArr(x.reasons) &&
    isStrArr(x.refs) &&
    isStrArr(x.testFiles)
  );
}

function isValidRecord(x: unknown): x is FileFixRecord {
  return (
    isObj(x) &&
    typeof x.sha === "string" &&
    typeof x.path === "string" &&
    (x.oldPath === undefined || typeof x.oldPath === "string") &&
    isValidEntries(x.added) &&
    isValidEntries(x.removed)
  );
}

function isValidCommitMap(x: unknown): x is Record<string, FixCommit> {
  if (!isObj(x)) return false;
  for (const c of Object.values(x)) if (!isValidCommit(c)) return false;
  return true;
}

function isValidMeta(x: unknown): x is IndexMeta {
  return (
    isObj(x) &&
    x.version === INDEX_VERSION &&
    typeof x.id === "string" &&
    ID_RE.test(x.id) &&
    typeof x.head === "string" &&
    typeof x.builtAt === "string" &&
    typeof x.fixCommits === "number" &&
    typeof x.files === "number"
  );
}

interface Manifest {
  version: typeof INDEX_VERSION;
  id: string;
  files: Record<string, string>;
}

function isValidManifest(x: unknown, id: string): x is Manifest {
  if (!isObj(x) || x.version !== INDEX_VERSION || x.id !== id || !isObj(x.files)) return false;
  for (const v of Object.values(x.files)) if (typeof v !== "string" || !SHARD_RE.test(v)) return false;
  return true;
}

interface Shard {
  version: typeof INDEX_VERSION;
  path: string;
  records: FileFixRecord[];
  commits: Record<string, FixCommit>;
}

function isValidShard(x: unknown, path: string): x is Shard {
  return (
    isObj(x) &&
    x.version === INDEX_VERSION &&
    x.path === path &&
    Array.isArray(x.records) &&
    x.records.every(isValidRecord) &&
    isValidCommitMap(x.commits)
  );
}

// ---------- reading ----------

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

/** The index summary, or null when there is no index of this version. Never throws. */
export function loadMeta(repoRoot: string): IndexMeta | null {
  try {
    const meta = readJson(join(indexDir(repoRoot), INDEX_FILE));
    return isValidMeta(meta) ? meta : null;
  } catch {
    return null;
  }
}

function loadManifest(dir: string, meta: IndexMeta): Manifest | null {
  const m = readJson(join(dir, `manifest-${meta.id}.json`));
  return isValidManifest(m, meta.id) ? m : null;
}

function loadShard(dir: string, name: string, path: string): Shard | null {
  const file = join(dir, SHARD_DIR, `${name}.json`);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let s: unknown = null;
  try {
    s = JSON.parse(text);
  } catch {
    // fall through
  }
  if (isValidShard(s, path)) return s;
  // A damaged shard would otherwise survive every rebuild, since saves skip names that exist.
  try {
    unlinkSync(file);
  } catch {
    /* ignore */
  }
  return null;
}

function loadCommits(dir: string, meta: IndexMeta): Record<string, FixCommit> | null {
  const c = readJson(join(dir, `commits-${meta.id}.json`));
  if (!isObj(c) || c.version !== INDEX_VERSION || c.id !== meta.id || !isValidCommitMap(c.commits)) return null;
  return c.commits;
}

/**
 * The whole saved index, or null when it is missing, unreadable, corrupt, or from another version
 * (an older index is rebuilt from scratch). Reads every shard, so it is for the indexer and the
 * CLI, not the edit hook. Never throws.
 */
export function loadIndex(repoRoot: string): ChestertonIndex | null {
  try {
    const dir = indexDir(repoRoot);
    const meta = loadMeta(repoRoot);
    if (!meta) return null;
    const manifest = loadManifest(dir, meta);
    const commits = manifest && loadCommits(dir, meta);
    if (!manifest || !commits) return null;
    const files: Record<string, FileFixRecord[]> = {};
    for (const [path, name] of Object.entries(manifest.files)) {
      const shard = loadShard(dir, name, path);
      if (!shard) return null;
      files[path] = shard.records;
    }
    return { version: INDEX_VERSION, head: meta.head, builtAt: meta.builtAt, commits, files };
  } catch {
    return null;
  }
}

/**
 * The saved index cut down to a few files: their records, and the fix commits those records point
 * at (or every fix commit with `allCommits`). This is what the edit hook reads. Null when there is
 * no usable index. Never throws.
 */
export function loadIndexForFiles(repoRoot: string, relPaths: string[], opts: { allCommits?: boolean } = {}): ChestertonIndex | null {
  try {
    const dir = indexDir(repoRoot);
    const meta = loadMeta(repoRoot);
    if (!meta) return null;
    const manifest = loadManifest(dir, meta);
    if (!manifest) return null;
    const commits: Record<string, FixCommit> = {};
    const files: Record<string, FileFixRecord[]> = {};
    for (const p of relPaths) {
      const key = normKey(p);
      if (files[key]) continue;
      const name = Object.prototype.hasOwnProperty.call(manifest.files, key) ? manifest.files[key] : undefined;
      if (!name) continue;
      const shard = loadShard(dir, name, key);
      if (!shard) return null;
      files[key] = shard.records;
      Object.assign(commits, shard.commits);
    }
    if (opts.allCommits) {
      const all = loadCommits(dir, meta);
      if (!all) return null;
      Object.assign(commits, all);
    }
    return { version: INDEX_VERSION, head: meta.head, builtAt: meta.builtAt, commits, files };
  } catch {
    return null;
  }
}

// ---------- writing ----------

function sleepSpin(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* short spin; this path is rare */
  }
}

function tmpName(file: string): string {
  return `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
}

/** Write a file atomically: temp file next to it, then rename over the old one. */
function writeAtomic(file: string, text: string): void {
  const tmp = tmpName(file);
  writeFileSync(tmp, text);
  let lastErr: unknown;
  // Windows can refuse the rename for a moment while another process has the old file open.
  for (let i = 0; i < 10; i++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      sleepSpin(20 * (i + 1));
    }
  }
  try {
    unlinkSync(tmp);
  } catch {
    /* ignore */
  }
  throw lastErr;
}

function normKey(relPath: string): string {
  return toPosix(relPath).replace(/^(\.\/)+/, "");
}

/**
 * Save the index: shards for changed files, a new manifest and commits file, then meta.json, which
 * switches readers over. Files from older builds (and a version 2 index.json) are removed after.
 */
export function saveIndex(repoRoot: string, idx: ChestertonIndex): void {
  const dir = indexDir(repoRoot);
  const shardDir = join(dir, SHARD_DIR);
  mkdirSync(shardDir, { recursive: true });
  const id = `${Date.now().toString(36)}-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const manifest: Manifest = { version: INDEX_VERSION, id, files: {} };
  for (const [path, records] of Object.entries(idx.files)) {
    const commits: Record<string, FixCommit> = {};
    for (const r of records) {
      const c = idx.commits[r.sha];
      if (c) commits[r.sha] = c;
    }
    const shard: Shard = { version: INDEX_VERSION, path, records, commits };
    const text = JSON.stringify(shard);
    const name = createHash("sha1").update(text, "utf8").digest("hex").slice(0, 32);
    const file = join(shardDir, `${name}.json`);
    // Same content, same name: a shard that is already there is already right.
    if (!existsSync(file)) writeAtomic(file, text);
    manifest.files[path] = name;
  }
  writeAtomic(join(dir, `manifest-${id}.json`), JSON.stringify(manifest));
  writeAtomic(join(dir, `commits-${id}.json`), JSON.stringify({ version: INDEX_VERSION, id, commits: idx.commits }));
  const meta: IndexMeta = {
    version: INDEX_VERSION,
    id,
    head: idx.head,
    builtAt: idx.builtAt,
    fixCommits: Object.keys(idx.commits).length,
    files: Object.keys(idx.files).length,
  };
  writeAtomic(join(dir, INDEX_FILE), JSON.stringify(meta));
  removeStale(dir, id, new Set(Object.values(manifest.files)));
}

/** Best effort cleanup of older generations. A reader that loses a file here just fails open. */
function removeStale(dir: string, id: string, keepShards: Set<string>): void {
  const rm = (f: string) => {
    try {
      unlinkSync(f);
    } catch {
      /* ignore */
    }
  };
  try {
    for (const f of readdirSync(dir)) {
      const gen = /^(?:manifest|commits)-(.+)\.json$/.exec(f);
      if ((gen && gen[1] !== id) || f === LEGACY_INDEX_FILE) rm(join(dir, f));
    }
    const shardDir = join(dir, SHARD_DIR);
    for (const f of readdirSync(shardDir)) {
      const m = /^([0-9a-f]{32})\.json$/.exec(f);
      if (!m || !keepShards.has(m[1]!)) rm(join(shardDir, f));
    }
  } catch {
    /* ignore */
  }
}

/** Records for a repo-relative path (either slash style, optional leading "./"). */
export function recordsForFile(idx: ChestertonIndex, relPath: string): FileFixRecord[] {
  const key = normKey(relPath);
  return Object.prototype.hasOwnProperty.call(idx.files, key) ? idx.files[key]! : [];
}

/** A valid index with nothing in it. */
export function emptyIndex(head = ""): ChestertonIndex {
  return { version: INDEX_VERSION, head, builtAt: new Date().toISOString(), commits: {}, files: {} };
}
