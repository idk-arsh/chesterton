import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { indexDir } from "./index-store.js";

export interface SessionFinding {
  at: string;
  key: string;
  kind: string;
  strength: string;
  file: string;
  sha: string;
  decision: string;
}

export interface SessionState {
  sessionId: string;
  /** Keys `${relPath}@${sha}` Claude has already been stopped on this session. */
  acknowledged: string[];
  findings: SessionFinding[];
  /** Repo-relative files edited this session, so the Stop sweep knows what to look at. */
  files: string[];
}

const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/;
const HASHED_TAIL = /\.h[0-9a-f]{12}$/;

/**
 * Session ids come from Claude Code, but keep the filename safe on every OS anyway.
 * Injective: an id that is already a safe filename is used as is; anything else becomes a
 * sanitized prefix plus a short hash of the raw id, so "a/b" and "a_b" never share a file.
 */
export function sanitizeSessionId(id: string): string {
  const raw = String(id ?? "");
  if (raw === "") return "default";
  if (SAFE_ID.test(raw) && !HASHED_TAIL.test(raw)) return raw;
  const prefix = raw.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 100);
  const hash = createHash("sha1").update(raw, "utf8").digest("hex").slice(0, 12);
  return `${prefix}.h${hash}`;
}

export function sessionPath(repoRoot: string, sessionId: string): string {
  return join(indexDir(repoRoot), "sessions", `${sanitizeSessionId(sessionId)}.json`);
}

/**
 * Where a session goes when <git-dir>/chesterton cannot be written (read-only, or not a directory).
 * Keyed by the repo root so two repos never mix.
 */
export function fallbackSessionPath(repoRoot: string, sessionId: string): string {
  const key = createHash("sha1").update(resolve(repoRoot), "utf8").digest("hex").slice(0, 16);
  return join(tmpdir(), "chesterton-sessions", key, `${sanitizeSessionId(sessionId)}.json`);
}

function strings(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : [];
}

function readSessionFile(file: string): Omit<SessionState, "sessionId"> | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object") return null;
    const findings = Array.isArray(raw.findings)
      ? (raw.findings.filter((f) => f && typeof f === "object" && typeof (f as SessionFinding).key === "string") as SessionFinding[])
      : [];
    return { acknowledged: strings(raw.acknowledged), findings, files: strings(raw.files) };
  } catch {
    return null;
  }
}

/**
 * Load a session. Missing or corrupt state gives a fresh empty session. State saved to the
 * fallback location (when the git dir was not writable) is merged in.
 */
export function loadSession(repoRoot: string, sessionId: string): SessionState {
  const s: SessionState = { sessionId, acknowledged: [], findings: [], files: [] };
  const parts: (Omit<SessionState, "sessionId"> | null)[] = [];
  try {
    parts.push(readSessionFile(sessionPath(repoRoot, sessionId)));
  } catch {
    // indexDir failed: only the fallback can hold anything.
  }
  parts.push(readSessionFile(fallbackSessionPath(repoRoot, sessionId)));
  for (const p of parts) {
    if (!p) continue;
    for (const a of p.acknowledged) if (!s.acknowledged.includes(a)) s.acknowledged.push(a);
    for (const f of p.files) if (!s.files.includes(f)) s.files.push(f);
    for (const f of p.findings) {
      if (!s.findings.some((g) => g.at === f.at && g.key === f.key && g.decision === f.decision)) s.findings.push(f);
    }
  }
  return s;
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Save a session atomically (tmp file + rename). When <git-dir>/chesterton cannot be written, falls
 * back to a per-repo folder in the OS temp dir. Throws only when neither place can be written.
 */
export function saveSession(repoRoot: string, s: SessionState): void {
  const text = JSON.stringify(s);
  try {
    writeAtomic(sessionPath(repoRoot, s.sessionId), text);
    return;
  } catch {
    // fall through to the fallback location
  }
  writeAtomic(fallbackSessionPath(repoRoot, s.sessionId), text);
}

// ---------- dirty file baseline ----------

/**
 * Files that were already changed when a session started, with a hash of their content then.
 * The Stop sweep also checks files that became dirty later (changed through the shell, say) and
 * uses this to leave alone what was dirty before the session touched anything. Kept in its own
 * file so the edit hook never has to read it.
 */
export interface DirtyBaseline {
  at: string;
  /** False when there were too many dirty files to record; the sweep then skips shell changes. */
  complete: boolean;
  /** Repo-relative path to content hash at session start; null when the hash was not taken. */
  files: Record<string, string | null>;
}

export function baselinePath(repoRoot: string, sessionId: string): string {
  return join(indexDir(repoRoot), "baselines", `${sanitizeSessionId(sessionId)}.json`);
}

/** The session's baseline, or null when none was saved or it cannot be read. Never throws. */
export function loadBaseline(repoRoot: string, sessionId: string): DirtyBaseline | null {
  try {
    const raw = JSON.parse(readFileSync(baselinePath(repoRoot, sessionId), "utf8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || typeof raw.at !== "string" || typeof raw.complete !== "boolean") return null;
    if (!raw.files || typeof raw.files !== "object" || Array.isArray(raw.files)) return null;
    const files: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(raw.files as Record<string, unknown>)) {
      if (typeof v === "string" || v === null) files[k] = v;
    }
    return { at: raw.at, complete: raw.complete, files };
  } catch {
    return null;
  }
}

/** Save the baseline atomically. Throws when it cannot be written. */
export function saveBaseline(repoRoot: string, sessionId: string, b: DirtyBaseline): void {
  writeAtomic(baselinePath(repoRoot, sessionId), JSON.stringify(b));
}
