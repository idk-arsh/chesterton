import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BlameLine } from "./types.js";
import { runGit } from "./git.js";
import { splitLines, toPosix } from "./normalize.js";
import { unquotePath } from "./index-builder.js";

const HEADER_RE = /^([0-9a-f]{40}|[0-9a-f]{64}) (\d+) (\d+)(?: (\d+))?$/;

/** Parse `git blame --porcelain` output. */
export function parsePorcelain(out: string): BlameLine[] {
  const result: BlameLine[] = [];
  const fileBySha = new Map<string, string>();
  let cur: { sha: string; orig: number; final: number } | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("\t")) {
      // Content line closes the current entry.
      if (cur) {
        result.push({ line: cur.final, sha: cur.sha, origLine: cur.orig, origPath: fileBySha.get(cur.sha) ?? "" });
      }
      cur = null;
      continue;
    }
    const m = HEADER_RE.exec(line);
    if (m && !cur) {
      cur = { sha: m[1]!, orig: Number(m[2]), final: Number(m[3]) };
      continue;
    }
    if (cur && line.startsWith("filename ")) {
      fileBySha.set(cur.sha, toPosix(unquotePath(line.slice("filename ".length).replace(/\r$/, ""))));
    }
  }
  return result;
}

/**
 * Blame lines start..end (1-based, inclusive) of the working-tree file.
 * Returns [] for untracked or missing files, bad ranges, or any git failure.
 * Lines not yet committed come back with an all-zero sha.
 */
export function blameRange(repoRoot: string, relPath: string, start: number, end: number, timeoutMs = 5_000): BlameLine[] {
  try {
    const rel = toPosix(relPath).replace(/^(\.\/)+/, "");
    const full = join(repoRoot, rel);
    if (!statSync(full).isFile()) return [];
    const lineCount = splitLines(readFileSync(full, "utf8")).length;
    const s = Math.max(1, Math.floor(start));
    const e = Math.min(lineCount, Math.floor(end));
    if (lineCount === 0 || s > e) return [];
    const out = runGit(["blame", "--porcelain", "-L", `${s},${e}`, "--", rel], repoRoot, timeoutMs);
    return parsePorcelain(out);
  } catch {
    return [];
  }
}
