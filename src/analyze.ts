import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BlameLine, ChestertonConfig, ChestertonIndex, EditChange, FileFixRecord, Finding, FindingKind } from "./types.js";
import { hashLine, isTrivial, normalizeLine, splitLines } from "./normalize.js";
import { blameRange } from "./blame.js";
import { recordsForFile } from "./index-store.js";

/** How many lines around a removed line count as "next to" a line the fix added. */
const NEAR = 3;
/** Most lines shown per finding. */
const MAX_LINES = 8;
/** Minimum length for a single re-added line to count as a weak match. */
const WEAK_SINGLE_MIN = 25;

export type BlameFn = (repoRoot: string, relPath: string, start: number, end: number, timeoutMs?: number) => BlameLine[];

export interface AnalyzeDeps {
  /** Blame function, defaults to blameRange (working tree). The Stop sweep passes a HEAD blame. */
  blame?: BlameFn;
  /** Budget handed to each blame call. */
  timeoutMs?: number;
  /** Current file content. Read from disk when omitted. */
  currentContent?: string | null;
}

const ZERO_SHA = /^0+$/;

function isIgnored(sha: string, cfg: ChestertonConfig): boolean {
  return cfg.ignoreCommits.some((p) => p.length > 0 && sha.startsWith(p));
}

/** A fix whose removed lines equal its added lines only moved code around. */
function isPureMove(r: FileFixRecord): boolean {
  if (r.added.length === 0 || r.added.length !== r.removed.length) return false;
  const a = r.added.map((e) => e.hash).sort();
  const b = r.removed.map((e) => e.hash).sort();
  return a.every((h, i) => h === b[i]);
}

interface Hit {
  kind: FindingKind;
  strength: "strong" | "weak";
  sha: string;
  lines: string[];
}

function readCurrent(repoRoot: string, relPath: string): string | null {
  try {
    return readFileSync(join(repoRoot, relPath), "utf8");
  } catch {
    return null;
  }
}

/** Merge [start, end] windows that touch or overlap. */
function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/**
 * Check one proposed change against the fix index. See "Detection rules" in docs/ARCHITECTURE.md.
 * The 5th parameter is for tests and for the Stop sweep; the hook normally leaves it out.
 */
export function analyzeChange(
  repoRoot: string,
  change: EditChange,
  idx: ChestertonIndex,
  cfg: ChestertonConfig,
  deps: AnalyzeDeps = {},
): Finding[] {
  const records = recordsForFile(idx, change.relPath).filter(
    (r) => idx.commits[r.sha] && !isIgnored(r.sha, cfg) && !isPureMove(r),
  );
  const hits: Hit[] = [];
  const current = deps.currentContent !== undefined ? deps.currentContent : change.isNewFile ? null : readCurrent(repoRoot, change.relPath);
  const currentLines = current === null ? [] : splitLines(current);

  // removes-fix
  if (!change.isNewFile) {
    const removed = change.removed
      .map((r) => ({ ...r, norm: normalizeLine(r.text) }))
      .filter((r) => !isTrivial(r.norm));
    if (removed.length > 0) hits.push(...removesFix(repoRoot, change, removed, records, idx, cfg, deps, currentLines.length));
  }

  // re-adds-removed
  if (records.length > 0 && change.added.length > 0) hits.push(...readdsRemoved(change, records, currentLines));

  // Dedupe per (kind, sha), keep the strongest, merge lines.
  const byKey = new Map<string, Hit>();
  for (const h of hits) {
    const key = `${h.kind}@${h.sha}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...h, lines: [...h.lines] });
      continue;
    }
    if (h.strength === "strong" && prev.strength === "weak") {
      prev.strength = "strong";
      prev.lines = [...h.lines, ...prev.lines];
    } else {
      prev.lines.push(...h.lines);
    }
  }
  const findings: Finding[] = [];
  for (const h of byKey.values()) {
    const fix = idx.commits[h.sha];
    if (!fix) continue;
    const lines = [...new Set(h.lines)].slice(0, MAX_LINES);
    findings.push({ kind: h.kind, strength: h.strength, file: change.relPath, fix, lines });
  }
  findings.sort((x, y) => (x.strength === y.strength ? 0 : x.strength === "strong" ? -1 : 1));
  return findings;
}

function removesFix(
  repoRoot: string,
  change: EditChange,
  removed: { line: number; text: string; norm: string }[],
  records: FileFixRecord[],
  idx: ChestertonIndex,
  cfg: ChestertonConfig,
  deps: AnalyzeDeps,
  fileLineCount: number,
): Hit[] {
  const blame = deps.blame ?? blameRange;
  const maxLine = Math.max(fileLineCount, ...removed.map((r) => r.line));
  const windows = mergeRanges(
    removed.map((r) => [Math.max(1, r.line - NEAR), Math.min(maxLine, r.line + NEAR)] as [number, number]),
  );
  const blamed = new Map<number, BlameLine>();
  for (const [s, e] of windows) {
    let lines: BlameLine[] = [];
    try {
      lines = blame(repoRoot, change.relPath, s, e, deps.timeoutMs);
    } catch {
      // Window past the end of the file or similar: retry with only the removed lines in it.
      const inside = removed.filter((r) => r.line >= s && r.line <= e).map((r) => r.line);
      if (inside.length === 0) continue;
      try {
        lines = blame(repoRoot, change.relPath, Math.min(...inside), Math.max(...inside), deps.timeoutMs);
      } catch {
        lines = [];
      }
    }
    for (const bl of lines) blamed.set(bl.line, bl);
  }

  const recordsBySha = new Map<string, FileFixRecord[]>();
  for (const r of records) {
    const list = recordsBySha.get(r.sha) ?? [];
    list.push(r);
    recordsBySha.set(r.sha, list);
  }
  const isFixSha = (sha: string) => !ZERO_SHA.test(sha) && !!idx.commits[sha] && !isIgnored(sha, cfg);

  const hits: Hit[] = [];
  for (const r of removed) {
    const bl = blamed.get(r.line);
    const hash = hashLine(r.norm);
    if (bl && isFixSha(bl.sha)) {
      const recs = recordsBySha.get(bl.sha) ?? [];
      const strong = recs.some((rec) => rec.added.some((e) => e.hash === hash));
      hits.push({ kind: "removes-fix", strength: strong ? "strong" : "weak", sha: bl.sha, lines: [r.text.trim()] });
      if (strong) continue;
    }
    // Weak: within NEAR lines of a line some fix added (and that line is still attributed to it).
    for (let n = r.line - NEAR; n <= r.line + NEAR; n++) {
      if (n === r.line) continue;
      const nb = blamed.get(n);
      if (!nb || !isFixSha(nb.sha)) continue;
      if (bl && nb.sha === bl.sha) continue;
      const recs = recordsBySha.get(nb.sha) ?? [];
      if (recs.some((rec) => rec.added.some((e) => e.line === nb.origLine))) {
        hits.push({ kind: "removes-fix", strength: "weak", sha: nb.sha, lines: [r.text.trim()] });
        break;
      }
    }
  }
  return hits;
}

function readdsRemoved(change: EditChange, records: FileFixRecord[], currentLines: string[]): Hit[] {
  const present = new Set<string>();
  for (const l of currentLines) {
    const n = normalizeLine(l);
    if (!isTrivial(n)) present.add(hashLine(n));
  }
  const added = change.added
    .map((text) => ({ text: text.trim(), norm: normalizeLine(text) }))
    .filter((a) => !isTrivial(a.norm))
    .map((a) => ({ ...a, hash: hashLine(a.norm) }));
  if (added.length === 0) return [];

  const hits: Hit[] = [];
  for (const rec of records) {
    if (rec.removed.length === 0) continue;
    const rem = rec.removed.map((e) => e.hash);
    const positions = new Map<string, number[]>();
    rem.forEach((h, j) => {
      const list = positions.get(h) ?? [];
      list.push(j);
      positions.set(h, list);
    });
    const inStrongRun = new Set<number>();
    const strongLines: string[] = [];
    for (let i = 0; i < added.length; i++) {
      const starts = positions.get(added[i]!.hash);
      if (!starts) continue;
      let best = 0;
      for (const j of starts) {
        let k = 0;
        while (i + k < added.length && j + k < rem.length && added[i + k]!.hash === rem[j + k]) k++;
        if (k > best) best = k;
      }
      if (best >= 2) {
        const run = added.slice(i, i + best);
        // Code that is already in the file is being moved, not brought back.
        if (!run.every((a) => present.has(a.hash))) {
          for (let k = 0; k < best; k++) inStrongRun.add(i + k);
          strongLines.push(...run.map((a) => a.text));
        }
        i += best - 1;
      }
    }
    if (strongLines.length > 0) hits.push({ kind: "re-adds-removed", strength: "strong", sha: rec.sha, lines: strongLines });

    const weakLines = added
      .filter((a, i) => !inStrongRun.has(i) && a.norm.length >= WEAK_SINGLE_MIN && positions.has(a.hash) && !present.has(a.hash))
      .map((a) => a.text);
    if (weakLines.length > 0) hits.push({ kind: "re-adds-removed", strength: "weak", sha: rec.sha, lines: weakLines });
  }
  return hits;
}
