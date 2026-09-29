import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

/** Session ids come from Claude Code, but keep the filename safe on every OS anyway. */
export function sanitizeSessionId(id: string): string {
  const s = String(id ?? "").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 120);
  return s || "default";
}

export function sessionPath(repoRoot: string, sessionId: string): string {
  return join(indexDir(repoRoot), "sessions", `${sanitizeSessionId(sessionId)}.json`);
}

function strings(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : [];
}

/** Load a session. Missing or corrupt state gives a fresh empty session. */
export function loadSession(repoRoot: string, sessionId: string): SessionState {
  const fresh: SessionState = { sessionId, acknowledged: [], findings: [], files: [] };
  try {
    const raw = JSON.parse(readFileSync(sessionPath(repoRoot, sessionId), "utf8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object") return fresh;
    const findings = Array.isArray(raw.findings)
      ? (raw.findings.filter((f) => f && typeof f === "object" && typeof (f as SessionFinding).key === "string") as SessionFinding[])
      : [];
    return { sessionId, acknowledged: strings(raw.acknowledged), findings, files: strings(raw.files) };
  } catch {
    return fresh;
  }
}

/** Save a session atomically (tmp file + rename). */
export function saveSession(repoRoot: string, s: SessionState): void {
  const file = sessionPath(repoRoot, s.sessionId);
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s));
  renameSync(tmp, file);
}
