import type { ChestertonConfig } from "./types.js";
import { FIX_THRESHOLD } from "./types.js";
import { toPosix } from "./normalize.js";

export interface CommitFileChange {
  path: string;
  oldPath?: string;
  status: string;
  added: number;
  removed: number;
}

export interface ClassifyInput {
  sha: string;
  subject: string;
  body: string;
  files: CommitFileChange[];
  parents: number;
}

export interface ClassifyResult {
  isFix: boolean;
  score: number;
  reasons: string[];
  refs: string[];
  testFiles: string[];
}

const KEYWORD_RE =
  /\b(fix(?:e[sd])?|bug|hotfix|regression|revert|race|deadlock|crash|leak|workaround|incident|cve-\d+|oncall|segfault|null ?pointer|npe|off.by.one)\b/gi;
const CONVENTIONAL_FIX_RE = /^fix(\(.+\))?!?:/i;

/** Uppercase prefixes that look like ticket keys but are usually not ("UTF-8", "SHA-256"). */
const NOT_TICKETS = new Set(["UTF", "SHA", "ISO", "RFC", "TLS", "SSL", "HTTP", "MD", "AES", "RSA", "IPV", "X", "CP", "WIN"]);

export const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "cargo.lock",
  "poetry.lock",
  "go.sum",
  "gemfile.lock",
  "composer.lock",
  "pipfile.lock",
  "uv.lock",
  "bun.lockb",
  "bun.lock",
  "flake.lock",
  "packages.lock.json",
]);

/** Dependency manifests that, when they are the only thing touched, usually mean a version bump. */
const DEP_FILES = new Set([
  "go.mod",
  "requirements.txt",
  "requirements-dev.txt",
  "pipfile",
  "gemfile",
  ".nvmrc",
  ".node-version",
  ".tool-versions",
]);

/** Formatter / lint config files. */
const FORMAT_FILES = new Set([
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.js",
  ".prettierignore",
  ".editorconfig",
  ".eslintrc",
  ".eslintrc.json",
  ".eslintrc.js",
  ".eslintignore",
  ".gitattributes",
  ".gitignore",
  ".clang-format",
  "rustfmt.toml",
  ".rustfmt.toml",
]);

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

export function isLockfile(path: string): boolean {
  return LOCKFILES.has(basename(toPosix(path)).toLowerCase());
}

function isDepFile(path: string): boolean {
  const b = basename(toPosix(path)).toLowerCase();
  return DEP_FILES.has(b) || /^requirements.*\.txt$/.test(b);
}

function isFormatFile(path: string): boolean {
  return FORMAT_FILES.has(basename(toPosix(path)).toLowerCase());
}

function isDocFile(path: string): boolean {
  const p = toPosix(path).toLowerCase();
  const b = basename(p);
  if (/(^|\/)(docs?|documentation)\//.test(p)) return true;
  if (/\.(md|mdx|markdown|rst|adoc|txt)$/.test(b) && !/^requirements.*\.txt$/.test(b) && b !== "cmakelists.txt") return true;
  return /^(license|licence|copying|authors|contributors|changelog|changes|notice|readme)(\..*)?$/.test(b);
}

export function isTestFile(path: string): boolean {
  const p = toPosix(path);
  const b = basename(p);
  if (/(^|\/)(test|tests|__tests__|spec)\//.test(p)) return true;
  if (/_test\.[^/.]+$/.test(b)) return true;
  if (/\.(test|spec)\.[^/]+$/.test(b)) return true;
  if (/^test_.*\.py$/.test(b)) return true;
  return false;
}

/** Issue / PR references in a commit message, de-duplicated, in order of appearance. */
export function extractRefs(message: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const push = (r: string) => {
    if (!seen.has(r)) {
      seen.add(r);
      refs.push(r);
    }
  };
  const urlRe =
    /https?:\/\/[^\s)>\]]*(?:github\.com\/[^\s)>\]]+\/(?:issues|pull)\/\d+|gitlab\.[^\s)>\]]+\/(?:issues|merge_requests)\/\d+|atlassian\.net\/browse\/[A-Z][A-Z0-9]+-\d+|jira[^\s)>\]]*\/browse\/[A-Z][A-Z0-9]+-\d+)/g;
  const urls = message.match(urlRe) ?? [];
  let rest = message;
  for (const u of urls) {
    push(u);
    rest = rest.split(u).join(" ");
  }
  for (const m of rest.matchAll(/(?:^|[^\w&/])(#\d+)\b/g)) push(m[1]!);
  for (const m of rest.matchAll(/\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/g)) {
    if (NOT_TICKETS.has(m[1]!)) continue;
    push(`${m[1]}-${m[2]}`);
  }
  return refs;
}

function matchesIgnore(sha: string, ignore: string[]): boolean {
  const s = sha.toLowerCase();
  return ignore.some((p) => {
    const q = p.trim().toLowerCase();
    return q.length >= 4 && s.startsWith(q);
  });
}

/**
 * Score a commit against the fix heuristics in docs/ARCHITECTURE.md ("Detection rules").
 * isFix is score >= FIX_THRESHOLD, and never true for commits listed in cfg.ignoreCommits.
 */
export function classifyCommit(input: ClassifyInput, cfg: ChestertonConfig): ClassifyResult {
  const reasons: string[] = [];
  let score = 0;
  const subject = input.subject ?? "";
  const body = input.body ?? "";
  const message = body ? `${subject}\n${body}` : subject;

  // Fix wording in the message (+3 once, whichever rule hits).
  const fixReasons: string[] = [];
  if (CONVENTIONAL_FIX_RE.test(subject.trim())) fixReasons.push("conventional commit type 'fix:'");
  const words: string[] = [];
  for (const m of message.matchAll(KEYWORD_RE)) {
    const w = m[1]!.toLowerCase();
    if (!words.includes(w)) words.push(w);
  }
  if (words.length > 0) fixReasons.push(`message says ${words.slice(0, 3).map((w) => `'${w}'`).join(", ")}`);
  for (const src of cfg.fixPatternsExtra ?? []) {
    let re: RegExp;
    try {
      re = new RegExp(src, "i");
    } catch {
      continue;
    }
    const m = message.match(re);
    if (m) fixReasons.push(`message matches custom pattern /${src}/ ('${m[0]}')`);
  }
  if (fixReasons.length > 0) {
    score += 3;
    reasons.push(...fixReasons);
  }

  // Issue / PR references (+1).
  const refs = extractRefs(message);
  if (refs.length > 0) {
    score += 1;
    reasons.push(`references ${refs.slice(0, 3).join(", ")}`);
  }

  const files = input.files ?? [];

  // Test files added or modified (+2).
  const testFiles: string[] = [];
  const testReasons: string[] = [];
  for (const f of files) {
    const st = (f.status || "M").charAt(0).toUpperCase();
    if (st === "D") continue;
    if (!isTestFile(f.path)) continue;
    testFiles.push(f.path);
    testReasons.push(`${st === "A" ? "adds" : "modifies"} test ${f.path}`);
  }
  if (testFiles.length > 0) {
    score += 2;
    reasons.push(...testReasons.slice(0, 3));
    if (testReasons.length > 3) reasons.push(`and ${testReasons.length - 3} more test files`);
  }

  // Size.
  const changed = files.reduce((n, f) => n + (f.added || 0) + (f.removed || 0), 0);
  if (files.length > 0 && files.length <= 5 && changed <= 60) {
    score += 1;
    reasons.push(`small change (${files.length} file${files.length === 1 ? "" : "s"}, ${changed} line${changed === 1 ? "" : "s"})`);
  }
  if (files.length > 40) {
    score -= 3;
    reasons.push(`large change (${files.length} files)`);
  }

  // Penalties.
  if (input.parents > 1) {
    score -= 5;
    reasons.push("merge commit");
  }
  if (files.length > 0) {
    if (files.every((f) => isDocFile(f.path))) {
      score -= 5;
      reasons.push("only touches docs");
    } else if (files.every((f) => isLockfile(f.path) || isDepFile(f.path) || isFormatFile(f.path) || isDocFile(f.path))) {
      score -= 5;
      reasons.push("only touches lockfiles, dependency or formatting files");
    }
  }

  let isFix = score >= FIX_THRESHOLD;
  if (matchesIgnore(input.sha, cfg.ignoreCommits ?? [])) {
    isFix = false;
    reasons.push("listed in ignoreCommits");
  }

  return { isFix, score, reasons, refs, testFiles };
}
