import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runGit } from "./git.js";
import { hashLine, isTrivial, normalizeLine, splitLines, toPosix } from "./normalize.js";
import { blameAt } from "./diff-change.js";
import type { ChestertonIndex, FixCommit } from "./types.js";

const ZERO_SHA = /^0+$/;
const HISTORY_LIMIT = 10;

interface LogEntry {
  sha: string;
  date: string;
  author: string;
  subject: string;
}

/**
 * Explain why a line is there: who last touched it, the commits that shaped it, and which of those
 * are indexed fix commits (with reasons, refs and tests). Plain text for a human or for Claude.
 * Works with idx === null; it then lists history without fix markers.
 */
export function explainLine(repoRoot: string, relPath: string, line: number, idx: ChestertonIndex | null): string {
  const path = toPosix(relPath).replace(/^\.\//, "");
  const out: string[] = [];

  let fileLines: string[];
  try {
    fileLines = splitLines(readFileSync(join(repoRoot, path), "utf8"));
  } catch {
    return `${path}: file not found in the working tree.`;
  }
  if (!Number.isInteger(line) || line < 1 || line > fileLines.length) {
    return `${path}:${line}: no such line (the file has ${fileLines.length} line${fileLines.length === 1 ? "" : "s"}).`;
  }
  const text = fileLines[line - 1] ?? "";
  out.push(`${path}:${line}`);
  out.push(`  ${text.trim() || "(blank line)"}`);
  out.push("");

  const fixes: FixCommit[] = [];
  const noteFix = (c: FixCommit) => {
    if (!fixes.some((f) => f.sha === c.sha)) fixes.push(c);
  };

  // Who last touched it.
  const blame = blameAt(repoRoot, path, line, line)[0];
  if (!blame) {
    out.push("Not tracked by git yet, so there is no history for this line.");
    return out.join("\n");
  }
  if (ZERO_SHA.test(blame.sha)) {
    out.push("Last touched by: uncommitted changes in the working tree.");
  } else {
    const fix = idx?.commits[blame.sha];
    out.push(`Last touched by ${short(blame.sha)} on ${day(blame.date)} by ${blame.author}`);
    out.push(`  ${blame.summary}`);
    if (blame.origPath !== path) out.push(`  (the file was ${blame.origPath} at that commit)`);
    if (fix) {
      noteFix(fix);
      out.push("  This is a bug fix commit (details below).");
    }
  }
  out.push("");

  // The commits that shaped it.
  const history = lineHistory(repoRoot, path, line);
  if (history.length > 0) {
    out.push(`Commits that shaped this line (newest first, up to ${HISTORY_LIMIT}):`);
    for (const c of history) {
      const fix = idx?.commits[c.sha];
      if (fix) noteFix(fix);
      out.push(`  ${short(c.sha)}  ${day(c.date)}  ${c.subject}${fix ? "   [fix]" : ""}`);
    }
    out.push("");
  }

  // Fix commits that added this exact text to this file, even if the line has moved since.
  const norm = normalizeLine(text);
  if (idx && !isTrivial(norm)) {
    const h = hashLine(norm);
    const adders = (idx.files[path] ?? [])
      .filter((r) => r.added.some((a) => a.hash === h))
      .map((r) => idx.commits[r.sha])
      .filter((c): c is FixCommit => c !== undefined && !fixes.some((f) => f.sha === c.sha));
    if (adders.length > 0) {
      out.push("Fix commits that added this exact line:");
      for (const c of adders) {
        noteFix(c);
        out.push(`  ${short(c.sha)}  ${day(c.date)}  ${c.subject}`);
      }
      out.push("");
    }
  }

  if (!idx) {
    out.push("No Chesterton index yet, so fix commits are not marked. Run `chesterton index` to build it.");
  } else if (fixes.length === 0) {
    out.push("None of these commits look like bug fixes.");
  } else {
    out.push(fixes.length === 1 ? "Fix commit behind this line:" : "Fix commits behind this line:");
    for (const f of fixes) {
      out.push(`  ${short(f.sha)}  ${day(f.date)}  ${f.author}  ${f.subject}`);
      out.push(...describeFix(f, "    "));
    }
    out.push("");
    out.push(`Before removing or rewriting this line, read the fix: git show ${short(fixes[0]!.sha)}`);
  }
  return out.join("\n").replace(/\n+$/, "");
}

function describeFix(f: FixCommit, pad: string): string[] {
  const lines = [`${pad}Looks like a bug fix (score ${f.score}): ${f.reasons.join("; ") || "classifier score"}`];
  if (f.refs.length) lines.push(`${pad}Refs: ${f.refs.join(", ")}`);
  if (f.testFiles.length) lines.push(`${pad}Tests: ${f.testFiles.join(", ")}`);
  return lines;
}

function lineHistory(repoRoot: string, path: string, line: number): LogEntry[] {
  let out: string;
  try {
    out = runGit(
      ["log", `-L${line},${line}:${path}`, "--format=%x1e%H%x1f%aI%x1f%an%x1f%s", "-s", "-n", String(HISTORY_LIMIT), "--no-color"],
      repoRoot,
      15_000,
    );
  } catch {
    return [];
  }
  const entries: LogEntry[] = [];
  for (const rec of out.split("\x1e")) {
    const first = rec.split("\n")[0] ?? "";
    const [sha, date, author, subject] = first.split("\x1f");
    if (sha && /^[0-9a-f]{40}$/.test(sha)) entries.push({ sha, date: date ?? "", author: author ?? "", subject: subject ?? "" });
  }
  return entries;
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function day(iso: string): string {
  return iso ? iso.slice(0, 10) : "unknown date";
}
