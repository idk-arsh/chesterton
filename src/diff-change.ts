import { runGit } from "./git.js";
import type { BlameLine, EditChange } from "./types.js";
import { toPosix } from "./normalize.js";

/** git's well-known empty tree, used as the pre-image when a repo has no commits yet. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** An EditChange from a git diff, plus the file's path in the pre-image when it was renamed. */
export interface DiffFileChange extends EditChange {
  oldPath?: string;
}

export interface DiffRange {
  /** Index vs HEAD (what `git commit` would record). */
  staged?: boolean;
  /** merge-base(base, HEAD) vs the working tree. Covers the branch's commits plus uncommitted work. */
  base?: string;
}

export interface GitDiffChanges {
  /**
   * The revision the removed lines' numbers refer to. Blame must run against this revision, not
   * the working tree, because the removed lines are already gone from the working tree.
   */
  preImage: string;
  changes: DiffFileChange[];
}

/**
 * Which diff `chesterton check` looks at:
 *
 * - `{ staged: true }`: `git diff --cached`, index vs HEAD. For pre-commit hooks.
 * - `{ base: "main" }`: `git diff <merge-base main HEAD>`, merge base vs the working tree. In CI
 *   the working tree equals HEAD, so this is exactly the branch's changes (like `main...HEAD`);
 *   locally it also includes uncommitted edits, which is what you want before pushing.
 * - `{}`: `git diff HEAD`, all uncommitted changes, staged or not.
 *
 * Untracked files are not part of any of these diffs. Binary and deleted files are skipped.
 */
export function gitDiffChanges(repoRoot: string, range: DiffRange = {}, timeoutMs = 60_000): GitDiffChanges {
  const head = revParse(repoRoot, "HEAD");
  let preImage: string;
  const args = [
    "diff",
    "--unified=0",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "-M",
    "--src-prefix=a/",
    "--dst-prefix=b/",
  ];
  if (range.staged) {
    preImage = head ?? EMPTY_TREE;
    args.push("--cached", preImage);
  } else if (range.base) {
    const base = revParse(repoRoot, range.base);
    if (!base) throw new Error(`unknown revision "${range.base}"`);
    let mb = base;
    if (head) {
      try {
        mb = runGit(["merge-base", base, head], repoRoot, timeoutMs).trim() || base;
      } catch {
        mb = base; // unrelated histories: diff straight against base
      }
    }
    preImage = mb;
    args.push(preImage);
  } else {
    preImage = head ?? EMPTY_TREE;
    args.push(preImage);
  }
  args.push("--");
  const out = runGit(args, repoRoot, timeoutMs);
  return { preImage, changes: parseUnifiedDiff(out) };
}

/** Contract entry point: the changes only. See gitDiffChanges for what each range means. */
export function changesFromGitDiff(repoRoot: string, range: DiffRange): EditChange[] {
  return gitDiffChanges(repoRoot, range).changes;
}

function revParse(repoRoot: string, rev: string): string | null {
  try {
    return runGit(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], repoRoot, 10_000).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Parse `git diff --unified=0` output. Removed lines carry their PRE-image line numbers, because
 * that is what a blame of the pre-image revision will see. Added lines are raw text in order.
 * Binary files, deleted files, and pure renames or mode changes with no content change are dropped.
 */
export function parseUnifiedDiff(diff: string): DiffFileChange[] {
  const out: DiffFileChange[] = [];
  const lines = diff.split("\n");
  let cur: (DiffFileChange & { skip: boolean; hunks: number }) | null = null;
  let oldLine = 0;
  let inHunk = false;

  const flush = () => {
    if (cur && !cur.skip && cur.relPath && (cur.removed.length > 0 || cur.added.length > 0)) {
      const { skip: _s, hunks: _h, ...change } = cur;
      if (change.oldPath === undefined || change.oldPath === change.relPath) delete change.oldPath;
      out.push(change);
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("diff --git ")) {
      flush();
      cur = { relPath: "", removed: [], added: [], isNewFile: false, skip: false, hunks: 0 };
      inHunk = false;
      continue;
    }
    if (!cur) continue;

    if (inHunk) {
      const c = rawLine[0];
      if (c === "-") {
        cur.removed.push({ line: oldLine++, text: stripCr(rawLine.slice(1)) });
        continue;
      }
      if (c === "+") {
        cur.added.push(stripCr(rawLine.slice(1)));
        continue;
      }
      if (c === "\\") continue; // "\ No newline at end of file"
      if (c === " ") {
        oldLine++; // context line (only with --unified > 0)
        continue;
      }
      if (!line.startsWith("@@")) inHunk = false;
    }

    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      inHunk = true;
      cur.hunks++;
      continue;
    }
    if (line.startsWith("new file mode")) cur.isNewFile = true;
    else if (line.startsWith("deleted file mode")) cur.skip = true;
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") cur.skip = true;
    else if (line.startsWith("rename from ")) cur.oldPath = toPosix(unquotePath(line.slice(12)));
    else if (line.startsWith("rename to ")) cur.relPath = toPosix(unquotePath(line.slice(10)));
    else if (line.startsWith("--- ")) {
      const p = line.slice(4);
      if (p === "/dev/null") cur.isNewFile = true;
      else if (cur.oldPath === undefined) cur.oldPath = toPosix(stripPrefix(unquotePath(p), "a/"));
    } else if (line.startsWith("+++ ")) {
      const p = line.slice(4);
      if (p === "/dev/null") cur.skip = true;
      else cur.relPath = toPosix(stripPrefix(unquotePath(p), "b/"));
    }
  }
  flush();
  return out;
}

function stripCr(s: string): string {
  return s.endsWith("\r") ? s.slice(0, -1) : s;
}

function stripPrefix(p: string, prefix: string): string {
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/** Undo git's C-style quoting of unusual paths: "a/caf\303\251 \"x\".ts". */
export function unquotePath(p: string): string {
  const t = p.replace(/\t$/, "");
  if (!(t.length >= 2 && t.startsWith('"') && t.endsWith('"'))) return t;
  const body = t.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const n = body[++i];
    if (n === undefined) break;
    if (/[0-7]/.test(n)) {
      const oct = body.slice(i, i + 3);
      bytes.push(parseInt(oct, 8));
      i += 2;
      continue;
    }
    const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", a: "\x07", b: "\b", f: "\f", v: "\v" };
    bytes.push(...Buffer.from(map[n] ?? n, "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}

export interface BlameInfo extends BlameLine {
  author: string;
  /** ISO 8601 author date. */
  date: string;
  summary: string;
}

/**
 * `git blame --porcelain` for lines start..end of relPath, either at a revision or (rev omitted)
 * in the working tree. Returns [] when the file or revision cannot be blamed.
 */
export function blameAt(repoRoot: string, relPath: string, start: number, end: number, rev?: string, timeoutMs = 10_000): BlameInfo[] {
  if (start < 1 || end < start) return [];
  const args = ["blame", "--porcelain", "-L", `${start},${end}`];
  if (rev) args.push(rev);
  args.push("--", relPath);
  let out: string;
  try {
    out = runGit(args, repoRoot, timeoutMs);
  } catch {
    return [];
  }
  return parseBlamePorcelain(out, relPath);
}

/**
 * Unix time as ISO 8601 in the author's own time zone, the same shape `git log --format=%aI`
 * prints, so a date shown from blame matches one shown from log or the index.
 */
export function isoInZone(unixSeconds: number, tz: string): string {
  const m = /^([+-])(\d{2})(\d{2})$/.exec(tz.trim());
  const offsetMin = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  const local = new Date((unixSeconds + offsetMin * 60) * 1000).toISOString().slice(0, 19);
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const zone = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return `${local}${zone}`;
}

export function parseBlamePorcelain(out: string, relPath: string): BlameInfo[] {
  const meta = new Map<string, { author: string; date: string; summary: string; path: string }>();
  const result: BlameInfo[] = [];
  const lines = out.split("\n");
  let pending: { sha: string; origLine: number; line: number } | null = null;
  let m = { author: "", date: "", summary: "", path: relPath, time: 0, tz: "+0000" };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    const header = /^([0-9a-f]{40}) (\d+) (\d+)(?: \d+)?$/.exec(line);
    if (header) {
      pending = { sha: header[1]!, origLine: Number(header[2]), line: Number(header[3]) };
      const known = meta.get(pending.sha);
      m = known
        ? { ...known, time: 0, tz: "+0000" }
        : { author: "", date: "", summary: "", path: relPath, time: 0, tz: "+0000" };
      continue;
    }
    if (!pending) continue;
    if (line.startsWith("author ")) m.author = line.slice(7);
    else if (line.startsWith("author-time ")) m.time = Number(line.slice(12));
    else if (line.startsWith("author-tz ")) m.tz = line.slice(10);
    else if (line.startsWith("summary ")) m.summary = line.slice(8);
    else if (line.startsWith("filename ")) m.path = toPosix(unquotePath(line.slice(9)));
    else if (line.startsWith("\t")) {
      if (!meta.has(pending.sha)) {
        const date = m.time ? isoInZone(m.time, m.tz) : "";
        meta.set(pending.sha, { author: m.author, date, summary: m.summary, path: m.path });
      }
      const info = meta.get(pending.sha)!;
      result.push({
        line: pending.line,
        sha: pending.sha,
        origLine: pending.origLine,
        origPath: info.path,
        author: info.author,
        date: info.date,
        summary: info.summary,
      });
      pending = null;
    }
  }
  return result;
}
