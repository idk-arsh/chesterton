import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { EditChange } from "./types.js";
import { splitLines, toPosix } from "./normalize.js";

/** Files bigger than this are skipped: the hook must stay fast. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Myers edit distance cap. Past this we fall back to a prefix/suffix trim diff. */
const MAX_EDIT_DISTANCE = 2000;

export interface LineDiff {
  removed: { line: number; text: string }[];
  added: string[];
}

/**
 * Line diff between two line lists. Common prefix and suffix are trimmed first, then the middle
 * goes through Myers (shortest edit script, same result size as an LCS diff). When the middle is
 * too different (edit distance over the cap) everything in it counts as removed and added.
 * Removed line numbers are 1-based positions in `before`.
 */
export function diffLines(before: string[], after: string[]): LineDiff {
  let pre = 0;
  while (pre < before.length && pre < after.length && before[pre] === after[pre]) pre++;
  let suf = 0;
  while (
    suf < before.length - pre &&
    suf < after.length - pre &&
    before[before.length - 1 - suf] === after[after.length - 1 - suf]
  ) {
    suf++;
  }
  const a = before.slice(pre, before.length - suf);
  const b = after.slice(pre, after.length - suf);
  const removed: { line: number; text: string }[] = [];
  const added: string[] = [];
  if (a.length === 0 && b.length === 0) return { removed, added };

  const script = myers(a, b, MAX_EDIT_DISTANCE);
  if (!script) {
    a.forEach((text, i) => removed.push({ line: pre + i + 1, text }));
    added.push(...b);
    return { removed, added };
  }
  for (const op of script) {
    if (op.t === "del") removed.push({ line: pre + op.i + 1, text: a[op.i]! });
    else if (op.t === "ins") added.push(b[op.j]!);
  }
  return { removed, added };
}

type Op = { t: "eq" | "del" | "ins"; i: number; j: number };

/** Myers O((N+M)D) diff. Stores only the live window of V per round, so memory is O(D^2). */
function myers(a: string[], b: string[], maxD: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  v[off + 1] = 0;
  const trace: Int32Array[] = [];
  let found = -1;
  const limit = Math.min(max, maxD);
  outer: for (let d = 0; d <= limit; d++) {
    // Snapshot k in [-d-1, d+1] before this round.
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!)) x = v[off + k + 1]!;
      else x = v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break outer;
      }
    }
  }
  if (found < 0) return null;

  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const snap = trace[d]!;
    const get = (k: number) => snap[k + d + 1]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && get(k - 1) < get(k + 1))) prevK = k + 1;
    else prevK = k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ t: "eq", i: x - 1, j: y - 1 });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ t: "ins", i: x, j: y - 1 });
      else ops.push({ t: "del", i: x - 1, j: y });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

/** Git Bash style /c/... paths become C:/... on Windows. Everything else is returned as is. */
export function toolPathToNative(p: string): string {
  if (process.platform === "win32") {
    const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
    if (m) return `${m[1]}:${m[2] ?? "/"}`;
  }
  return p;
}

function realOr(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * Resolve links (junctions, symlinked dirs, /tmp on macOS) in every directory of `abs`. The final
 * component is resolved too unless it is itself a symlink, so a link file keeps its own name.
 * For a path that does not exist yet, the nearest existing parent is resolved.
 */
function realPathOf(abs: string): string {
  try {
    if (!lstatSync(abs).isSymbolicLink()) return realpathSync.native(abs);
    return join(realOr(dirname(abs)), basename(abs));
  } catch {
    // Missing: resolve the nearest parent that exists and keep the rest.
  }
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    const up = dirname(cur);
    rest.unshift(basename(cur));
    if (up === cur) return abs;
    cur = up;
    try {
      return join(realpathSync.native(cur), ...rest);
    } catch {
      // keep walking up
    }
  }
}

/**
 * On case-insensitive file systems a path can name an existing file with the wrong letter case.
 * Map each segment to the name on disk so the path matches what git tracks. Windows gets this from
 * realpathSync.native already; macOS realpath does not always fix case.
 */
function trueCase(rootReal: string, rel: string): string {
  if (process.platform !== "darwin") return rel;
  const parts = rel.split(/[\\/]/);
  let dir = rootReal;
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    let name = part;
    try {
      const names = readdirSync(dir);
      if (!names.includes(part)) {
        const lower = part.toLowerCase();
        const hit = names.find((n) => n.toLowerCase() === lower);
        if (hit) name = hit;
        else return [...out, ...parts.slice(i)].join("/");
      }
    } catch {
      return [...out, ...parts.slice(i)].join("/");
    }
    out.push(name);
    dir = join(dir, name);
  }
  return out.join("/");
}

/**
 * Resolve a tool's file_path to a repo-relative posix path, or null when it is outside the repo.
 * Accepts absolute Windows paths (either slash), Git Bash style /c/... paths on Windows,
 * and paths relative to the repo root. Links are resolved on both sides, since git reports the
 * repo root with links resolved while the tool path uses whatever path the session was opened with.
 */
export function resolveRepoPath(repoRoot: string, filePath: string): { abs: string; rel: string } | null {
  if (typeof filePath !== "string" || filePath.trim() === "") return null;
  const p = toolPathToNative(filePath.trim());
  const rootReal = realOr(resolve(repoRoot));
  const abs = realPathOf(isAbsolute(p) ? resolve(p) : resolve(repoRoot, p));
  let rel = relative(rootReal, abs);
  if (rel === "" || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) return null;
  rel = trueCase(rootReal, rel);
  const posix = toPosix(rel);
  if (posix === ".git" || posix.startsWith(".git/")) return null;
  return { abs, rel: posix };
}

/** Read a text file. undefined when missing, null when unreadable, too big or binary. */
function readText(abs: string): string | null | undefined {
  let st;
  try {
    st = statSync(abs);
  } catch {
    return undefined;
  }
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
  try {
    const text = readFileSync(abs, "utf8");
    if (text.includes("\u0000")) return null;
    return text;
  } catch {
    return null;
  }
}

interface EditSpec {
  old_string: string;
  new_string: string;
  replace_all: boolean;
}

function asEdit(x: unknown): EditSpec | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (typeof o.old_string !== "string" || typeof o.new_string !== "string") return null;
  return { old_string: o.old_string, new_string: o.new_string, replace_all: o.replace_all === true };
}

/**
 * Apply one Edit to content. Tolerant of line ending mismatches between the tool input and the
 * file. Returns null when old_string is not found.
 */
export function applyEdit(content: string, e: EditSpec): string | null {
  if (e.old_string === "") return null;
  const candidates: [string, string][] = [[e.old_string, e.new_string]];
  const fileCrlf = content.includes("\r\n");
  if (fileCrlf && !e.old_string.includes("\r\n")) {
    candidates.push([e.old_string.replace(/\r?\n/g, "\r\n"), e.new_string.replace(/\r?\n/g, "\r\n")]);
  }
  if (e.old_string.includes("\r\n")) {
    candidates.push([e.old_string.replace(/\r\n/g, "\n"), e.new_string.replace(/\r\n/g, "\n")]);
  }
  for (const [oldS, newS] of candidates) {
    const idx = content.indexOf(oldS);
    if (idx < 0) continue;
    if (e.replace_all) return content.split(oldS).join(newS);
    return content.slice(0, idx) + newS + content.slice(idx + oldS.length);
  }
  return applyEolInsensitive(content, e);
}

/**
 * Last resort for files with mixed line endings: match with CRLF folded to LF on both sides, then
 * map the match back to offsets in the original content.
 */
function applyEolInsensitive(content: string, e: EditSpec): string | null {
  const oldN = e.old_string.replace(/\r\n/g, "\n");
  if (oldN === "") return null;
  // norm[i] came from content[map[i]] (a CRLF pair maps to its "\r"); map[norm.length] is content.length.
  const map: number[] = [];
  let norm = "";
  for (let i = 0; i < content.length; i++) {
    map.push(i);
    if (content[i] === "\r" && content[i + 1] === "\n") {
      norm += "\n";
      i++;
    } else {
      norm += content[i];
    }
  }
  map.push(content.length);
  const starts: number[] = [];
  let from = 0;
  for (;;) {
    const at = norm.indexOf(oldN, from);
    if (at < 0) break;
    starts.push(at);
    if (!e.replace_all) break;
    from = at + oldN.length;
  }
  if (starts.length === 0) return null;
  let out = "";
  let last = 0;
  for (const s of starts) {
    const start = map[s]!;
    const end = map[s + oldN.length]!;
    out += content.slice(last, start) + e.new_string;
    last = end;
  }
  return out + content.slice(last);
}

/**
 * Turn an Edit / Write / MultiEdit tool call into the change it would make. Returns [] for paths
 * outside the repo, unreadable files, no-op edits, or when old_string is not found.
 * Always at most one EditChange: replace_all and MultiEdit are merged into one whole-file diff.
 */
export function changeFromToolCall(repoRoot: string, toolName: string, toolInput: unknown): EditChange[] {
  if (!toolInput || typeof toolInput !== "object") return [];
  const input = toolInput as Record<string, unknown>;
  const filePath = input.file_path;
  if (typeof filePath !== "string") return [];
  const target = resolveRepoPath(repoRoot, filePath);
  if (!target) return [];
  const current = readText(target.abs);
  if (current === null) return [];
  const exists = current !== undefined;

  let next: string | null = null;
  if (toolName === "Write") {
    if (typeof input.content !== "string") return [];
    next = input.content;
  } else if (toolName === "Edit") {
    const e = asEdit(input);
    if (!e) return [];
    if (!exists) {
      // Edit with an empty old_string creates a new file.
      if (e.old_string !== "") return [];
      next = e.new_string;
    } else {
      next = applyEdit(current, e);
    }
  } else if (toolName === "MultiEdit") {
    if (!Array.isArray(input.edits)) return [];
    let text = exists ? current : "";
    for (const raw of input.edits) {
      const e = asEdit(raw);
      if (!e) return [];
      if (!exists && text === "" && e.old_string === "") {
        text = e.new_string;
        continue;
      }
      const r = applyEdit(text, e);
      if (r === null) return [];
      text = r;
    }
    next = text;
  } else {
    return [];
  }
  if (next === null) return [];

  if (!exists) {
    const added = splitLines(next);
    if (added.length === 0) return [];
    return [{ relPath: target.rel, removed: [], added, isNewFile: true }];
  }
  const d = diffLines(splitLines(current), splitLines(next));
  if (d.removed.length === 0 && d.added.length === 0) return [];
  return [{ relPath: target.rel, removed: d.removed, added: d.added, isNewFile: false }];
}
