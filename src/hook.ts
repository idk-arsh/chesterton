// Hook entry point, bundled to dist/hook.js. Reads the hook JSON on stdin and prints a response.
// Fails open: any error, timeout, or missing piece means exit 0 with no output.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BlameLine, ChestertonConfig, ChestertonIndex, EditChange, Finding, FixCommit, LineEntry } from "./types.js";
import { INDEX_VERSION } from "./types.js";
import { hashLine, isTrivial, normalizeLine, splitLines } from "./normalize.js";
import { headSha, repoRoot as findRepoRoot, runGit, shallowInfo } from "./git.js";
import { DEFAULT_CONFIG, loadConfig } from "./config.js";
import { indexDir, loadIndexForFiles, loadMeta } from "./index-store.js";
import { blameRange, parsePorcelain } from "./blame.js";
import { classifyCommit, type CommitFileChange } from "./classify.js";
import { changeFromToolCall, diffLines, toolPathToNative } from "./edit-diff.js";
import { analyzeChange, type BlameFn } from "./analyze.js";
import { decidePreToolUse } from "./decide.js";
import { loadSession, saveSession, type SessionState } from "./session.js";

class HookTimeout extends Error {}

class Deadline {
  constructor(private readonly at: number) {}
  remaining(): number {
    return this.at - Date.now();
  }
  /** Budget for one git call; throws once the time is gone. */
  budget(): number {
    const r = this.remaining();
    if (r <= 0) throw new HookTimeout("hook budget spent");
    return Math.max(50, r);
  }
  check(): void {
    if (this.remaining() <= 0) throw new HookTimeout("hook budget spent");
  }
}

export interface HookDeps {
  /** Starts the background indexer. Defaults to spawning `node <dir>/cli.js index --quiet`. */
  spawnIndexer?: (repoRoot: string) => void;
  /** Where cli.js lives. Defaults to the directory of this script. */
  cliPath?: string;
  /** Override the budget start (ms since epoch). */
  startedAt?: number;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
const MAX_SESSION_FILES = 500;
const MAX_FALLBACK_COMMITS = 6;
const MAX_STOP_FILES = 25;

function scriptDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

function defaultSpawnIndexer(cliPath: string): (root: string) => void {
  return (root) => {
    if (!existsSync(cliPath)) return;
    const child = spawn(process.execPath, [cliPath, "index", "--quiet"], {
      cwd: root,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
  };
}

function logError(root: string | null, err: unknown): void {
  if (!root || err instanceof HookTimeout) return;
  try {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    appendFileSync(join(indexDir(root), "chesterton.log"), `${new Date().toISOString()} hook: ${msg}\n`);
  } catch {
    // Nothing left to do.
  }
}

/**
 * Handle one hook invocation. Returns the JSON to print, or null to print nothing.
 * Never throws.
 */
export function handleHookInput(raw: string, deps: HookDeps = {}): string | null {
  const startedAt = deps.startedAt ?? Date.now();
  let root: string | null = null;
  try {
    const input = JSON.parse(raw) as Record<string, unknown>;
    if (!input || typeof input !== "object") return null;
    const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
    root = findRepoRoot(cwd);
    const event = input.hook_event_name;
    // An edited file can live in a different repo than the session (a submodule, a nested repo):
    // check it against the repo that actually owns it.
    if (event === "PreToolUse") root = rootForToolInput(input.tool_input, cwd, root);
    if (!root) return null;
    const cfg = loadConfig(root);
    const sessionId = typeof input.session_id === "string" && input.session_id ? input.session_id : "default";

    if (event === "PreToolUse") {
      const deadline = new Deadline(startedAt + cfg.hookTimeoutMs);
      return preToolUse(root, cfg, sessionId, input, deadline);
    }
    if (event === "SessionStart") {
      return sessionStart(root, deps);
    }
    if (event === "Stop") {
      if (input.stop_hook_active === true) return null;
      const deadline = new Deadline(startedAt + Math.max(cfg.hookTimeoutMs * 3, 3000));
      const res = stop(root, cfg, sessionId, deadline);
      if (!res || deadline.remaining() <= 0) return null;
      // Only record the ledger as surfaced once we know it is going out.
      res.commit();
      return res.text;
    }
    return null;
  } catch (err) {
    logError(root, err);
    return null;
  }
}

/** Top level of the repo that owns the edited file, falling back to the session's repo. */
function rootForToolInput(toolInput: unknown, cwd: string, cwdRoot: string | null): string | null {
  try {
    if (!toolInput || typeof toolInput !== "object") return cwdRoot;
    const fp = (toolInput as Record<string, unknown>).file_path;
    if (typeof fp !== "string" || fp.trim() === "") return cwdRoot;
    const p = toolPathToNative(fp.trim());
    const abs = isAbsolute(p) ? resolve(p) : resolve(cwdRoot ?? cwd, p);
    // Walk up to the nearest directory holding a .git entry (a dir for a repo, a file for a
    // submodule or worktree). Plain stats, so the common case costs no extra git call.
    let dir = dirname(abs);
    for (;;) {
      if (existsSync(join(dir, ".git"))) break;
      const up = dirname(dir);
      if (up === dir) return cwdRoot;
      dir = up;
    }
    if (cwdRoot && samePath(dir, cwdRoot)) return cwdRoot;
    return findRepoRoot(dir) ?? cwdRoot;
  } catch {
    return cwdRoot;
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    let r = resolve(p);
    try {
      r = realpathSync.native(r);
    } catch {
      // keep resolved path
    }
    return process.platform === "win32" || process.platform === "darwin" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

// ---------- SessionStart ----------

function sessionStart(root: string, deps: HookDeps): string | null {
  // Without a HEAD (git missing, or no commits yet) there is nothing to index or check.
  const head = headSha(root);
  if (!head) return null;
  const meta = loadMeta(root);
  if (!meta || meta.head !== head) {
    const spawnIt = deps.spawnIndexer ?? defaultSpawnIndexer(deps.cliPath ?? join(scriptDir(), "cli.js"));
    try {
      spawnIt(root);
    } catch (err) {
      logError(root, err);
    }
  }
  if (!meta) return null;
  const n = meta.fixCommits;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `Chesterton: ${n} fix commit${n === 1 ? "" : "s"} indexed. Edits that undo a past bug fix will be flagged.`,
    },
  });
}

// ---------- PreToolUse ----------

function preToolUse(
  root: string,
  cfg: ChestertonConfig,
  sessionId: string,
  input: Record<string, unknown>,
  deadline: Deadline,
): string | null {
  const tool = typeof input.tool_name === "string" ? input.tool_name : "";
  if (!EDIT_TOOLS.has(tool)) return null;
  const changes = changeFromToolCall(root, tool, input.tool_input);
  if (changes.length === 0) return null;
  deadline.check();

  const idx = loadIndexForFiles(root, changes.map((c) => c.relPath));
  deadline.check();
  const session = loadSession(root, sessionId);
  const before = JSON.stringify(session);

  let out: string | null = null;
  for (const change of changes) {
    if (!session.files.includes(change.relPath)) {
      session.files.push(change.relPath);
      if (session.files.length > MAX_SESSION_FILES) session.files.splice(0, session.files.length - MAX_SESSION_FILES);
    }
    const findings = idx
      ? analyzeChange(root, change, idx, cfg, { timeoutMs: deadline.budget() })
      : fallbackFindings(root, change, cfg, deadline);
    deadline.check();
    const res = decidePreToolUse(findings, session, cfg, change.relPath);
    if (res.stdout && !out) out = res.stdout;
  }
  // Past the budget: print nothing and do not record acknowledgements Claude never saw.
  deadline.check();
  if (JSON.stringify(session) !== before) {
    try {
      saveSession(root, session);
    } catch (err) {
      logError(root, err);
      // The acknowledgement is lost, so a deny would repeat on every retry and Claude would be
      // stuck. Fail open: allow, and pass the same explanation along as context.
      out = denyToContext(out);
    }
  }
  return out;
}

function denyToContext(out: string | null): string | null {
  if (!out) return out;
  try {
    const o = JSON.parse(out) as { hookSpecificOutput?: Record<string, unknown> };
    const h = o.hookSpecificOutput;
    if (!h || h.permissionDecision !== "deny") return out;
    const reason = typeof h.permissionDecisionReason === "string" ? h.permissionDecisionReason : "";
    const extra = typeof h.additionalContext === "string" ? `\n\n${h.additionalContext}` : "";
    const note =
      "Chesterton could not save its session state, so this edit was allowed instead of stopped. Read the note below before going on.";
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: `${note}\n\n${reason}${extra}` },
    });
  } catch {
    return null;
  }
}

/** Blame wrapper that remembers results per range, so a second analysis pass costs nothing. */
function memoBlame(deadline: Deadline, inner: BlameFn = blameRange): { fn: BlameFn; shas: Set<string> } {
  const cache = new Map<string, BlameLine[]>();
  const shas = new Set<string>();
  const fn: BlameFn = (r, p, s, e) => {
    const key = `${p}:${s}-${e}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const lines = inner(r, p, s, e, deadline.budget());
    cache.set(key, lines);
    for (const l of lines) if (!/^0+$/.test(l.sha)) shas.add(l.sha);
    return lines;
  };
  return { fn, shas };
}

/** Post-image lines a commit added to one file, from `git show -U0`. */
export function addedLinesInCommit(root: string, sha: string, path: string, timeoutMs: number): LineEntry[] {
  const diff = runGit(["show", "--format=", "-U0", "--no-color", "--no-ext-diff", sha, "--", path], root, timeoutMs);
  const out: LineEntry[] = [];
  let line = 0;
  for (const l of diff.split(/\r?\n/)) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (m) {
      line = Number(m[1]);
      continue;
    }
    if (l.startsWith("+++") || l.startsWith("---")) continue;
    if (l.startsWith("+")) {
      const norm = normalizeLine(l.slice(1));
      if (!isTrivial(norm)) out.push({ hash: hashLine(norm), text: l.slice(1).trim().slice(0, 200), line });
      line++;
    }
  }
  return out;
}

/**
 * No index yet: blame the removed lines, classify the blamed commits on the fly, and run the normal
 * analysis against that tiny index. Only removes-fix can be found this way.
 */
function fallbackFindings(root: string, change: EditChange, cfg: ChestertonConfig, deadline: Deadline): Finding[] {
  if (change.isNewFile || change.removed.length === 0) return [];
  const blame = memoBlame(deadline);
  const empty: ChestertonIndex = { version: INDEX_VERSION, head: "", builtAt: "", commits: {}, files: {} };
  const removalOnly: EditChange = { ...change, added: [] };
  // First pass only collects blame.
  analyzeChange(root, removalOnly, empty, cfg, { blame: blame.fn, alwaysBlame: true });

  const idx: ChestertonIndex = { version: INDEX_VERSION, head: "", builtAt: "", commits: {}, files: { [change.relPath]: [] } };
  let n = 0;
  let shallow: { shallow: boolean; boundary: Set<string> } | null = null;
  for (const sha of blame.shas) {
    if (n++ >= MAX_FALLBACK_COMMITS) break;
    if (cfg.ignoreCommits.some((p) => p && sha.startsWith(p))) continue;
    const meta = runGit(["show", "-s", "--format=%H%x00%aI%x00%an%x00%P%x00%s%x00%b", sha], root, deadline.budget());
    const [full = sha, date = "", author = "", parents = "", subject = "", body = ""] = meta.replace(/\n$/, "").split("\u0000");
    const parentCount = parents.trim() ? parents.trim().split(/\s+/).length : 0;
    // A shallow clone's boundary commit looks like it added every line; never treat it as a fix.
    shallow ??= shallowInfo(root);
    if (shallow.boundary.has(full) || (shallow.shallow && parentCount === 0)) continue;
    const files = parseNumstat(runGit(["show", "--numstat", "--format=", "--no-color", sha], root, deadline.budget()));
    const res = classifyCommit({ sha: full, subject, body, files, parents: parentCount }, cfg);
    if (!res.isFix) continue;
    const fix: FixCommit = { sha: full, date, author, subject, score: res.score, reasons: res.reasons, refs: res.refs, testFiles: res.testFiles };
    idx.commits[full] = fix;
    const added = addedLinesInCommit(root, full, change.relPath, deadline.budget());
    idx.files[change.relPath]!.push({ sha: full, path: change.relPath, added, removed: [] });
  }
  if (Object.keys(idx.commits).length === 0) return [];
  deadline.check();
  return analyzeChange(root, removalOnly, idx, cfg, { blame: blame.fn, alwaysBlame: true });
}

function parseNumstat(text: string): CommitFileChange[] {
  const out: CommitFileChange[] = [];
  for (const l of text.split(/\r?\n/)) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l);
    if (!m) continue;
    out.push({ path: m[3]!, status: "M", added: m[1] === "-" ? 0 : Number(m[1]), removed: m[2] === "-" ? 0 : Number(m[2]) });
  }
  return out;
}

// ---------- Stop ----------

/** Blame a line range of the file as it is at HEAD (the working tree may already have the edits). */
export function blameAtHead(root: string, relPath: string, start: number, end: number, timeoutMs?: number): BlameLine[] {
  const text = runGit(["blame", "--porcelain", "-L", `${start},${end}`, "HEAD", "--", relPath], root, timeoutMs ?? 10_000);
  return parsePorcelain(text).map((b) => ({ ...b, origPath: b.origPath || relPath }));
}

function shortVerb(f: Finding): string {
  return f.kind === "removes-fix" ? "removes code added by fix" : "adds back code removed by fix";
}

function stop(
  root: string,
  cfg: ChestertonConfig,
  sessionId: string,
  deadline: Deadline,
): { text: string; commit: () => void } | null {
  const session: SessionState = loadSession(root, sessionId);
  if (session.files.length === 0) return null;
  const files = session.files.slice(-MAX_STOP_FILES);
  const idx = loadIndexForFiles(root, files);
  if (!idx) return null;
  const seen = new Set([...session.acknowledged, ...session.findings.map((f) => f.key)]);
  const ledger: Finding[] = [];
  const blame: BlameFn = (r, p, s, e) => blameAtHead(r, p, s, e, deadline.budget());

  for (const rel of files) {
    deadline.check();
    let headText: string | null = null;
    try {
      headText = runGit(["show", `HEAD:${rel}`], root, deadline.budget());
    } catch {
      headText = null;
    }
    let workText = "";
    try {
      workText = readFileSync(join(root, rel), "utf8");
    } catch {
      workText = "";
    }
    const d = diffLines(splitLines(headText ?? ""), splitLines(workText));
    if (d.removed.length === 0 && d.added.length === 0) continue;
    const change: EditChange = { relPath: rel, removed: d.removed, added: d.added, isNewFile: headText === null };
    const findings = analyzeChange(root, change, idx, cfg, { blame, currentContent: headText, timeoutMs: deadline.budget() });
    for (const f of findings) {
      const key = `${rel}@${f.fix.sha}`;
      if (f.strength !== "strong" || seen.has(key)) continue;
      seen.add(key);
      ledger.push(f);
    }
  }
  if (ledger.length === 0) return null;
  const commit = () => {
    for (const f of ledger) {
      session.findings.push({
        at: new Date().toISOString(),
        key: `${f.file}@${f.fix.sha}`,
        kind: f.kind,
        strength: f.strength,
        file: f.file,
        sha: f.fix.sha,
        decision: "stop-ledger",
      });
    }
    try {
      saveSession(root, session);
    } catch (err) {
      logError(root, err);
    }
  };
  const items = ledger.map((f) => `- ${f.file}: ${shortVerb(f)} ${f.fix.sha.slice(0, 7)} "${f.fix.subject}" (git show ${f.fix.sha.slice(0, 7)})`);
  const text =
    `Chesterton: before you finish, ${ledger.length === 1 ? "one change" : `${ledger.length} changes`} from this session touch past bug fixes that were not flagged at edit time:\n` +
    `${items.join("\n")}\n` +
    `Check each fix still holds, and tell the user if you removed or reverted one on purpose.`;
  return { text: JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: text } }), commit };
}

// ---------- process entry ----------

function readStdin(): Promise<string> {
  return new Promise((res) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => res(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => res(""));
  });
}

/** Run as a process: read stdin, print the response, exit 0 no matter what. */
export async function main(): Promise<void> {
  const startedAt = Date.now();
  // Covers a stuck stdin; the sync work below enforces its own deadline.
  const timer = setTimeout(() => process.exit(0), Math.max(DEFAULT_CONFIG.hookTimeoutMs, 1000) + 2000);
  timer.unref();
  try {
    const raw = await readStdin();
    const out = handleHookInput(raw, { startedAt });
    if (out) {
      process.stdout.write(out + "\n", () => process.exit(0));
      return;
    }
  } catch {
    // Fail open.
  }
  process.exit(0);
}

function isMain(): boolean {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    const self = fileURLToPath(import.meta.url);
    const norm = (p: string) => {
      let r = resolve(p);
      try {
        r = realpathSync(r);
      } catch {
        // keep resolved path
      }
      return process.platform === "win32" ? r.toLowerCase() : r;
    };
    return norm(argv1) === norm(self);
  } catch {
    return false;
  }
}

if (isMain()) void main();
