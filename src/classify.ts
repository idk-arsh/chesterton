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

/** Conventional `fix(scope):` whose scope says it is housekeeping, not a behavior fix. */
const NOISE_FIX_SCOPE_RE = /^fix\((deps|devdeps|dev-deps|ci|build|refactor|docs|lint|style|typo|test|tests)\)!?:/i;
/**
 * Subjects that are dependency or housekeeping work: `build(deps):`, `deps:`, conventional types
 * `docs:`, `style:`, `lint:`, `ci:`, `test:`, `refactor:`, and version bumps named as `pkg@1.2.3`.
 */
const NOISE_PREFIX_RE =
  /^((build|chore)\(deps\)|deps(\([^)]*\))?|(docs?|style|lint|ci|tests?|refactor)(\([^)]*\))?)!?:|^(update (to )?)?@?[\w./-]+@\^?v?\d+\.\d+/i;
const CHORE_RE = /^chore(\([^)]*\))?!?:/i;
/** Keywords strong enough to keep a `chore:` commit as a fix. */
const STRONG_KEYWORD_RE = /\b(race|crash(e[sd])?|leak(s|ed)?|regression|cve-\d+|deadlock|segfault|security|vulnerab\w*)\b/i;
/**
 * Housekeeping wording anywhere in the subject. "format" alone is too common in real fixes
 * ("fix date format"), so only formatting runs count: "formatting", "reformat", a subject that
 * starts with "format"/"fmt", rustfmt, prettier.
 */
const NOISE_WORDS_RE =
  /\b(bump(s|ed)?|typos?|spelling|misspell\w*|codespell|lint(s|er|ers|ing)?|clippy|formatting|reformat\w*|rustfmt|prettier|whitespace)\b|\b(update[sd]?|upgrade[sd]?)\b.*\b(dependency|dependencies|deps|dev-?dependencies)\b|^(\S+:\s*)?(run |apply )?(format|fmt)\b/i;
/** A subject that starts (after an optional `scope:` prefix) with a feature verb. */
const FEATURE_RE =
  /^(\S+:\s*)?(add|adds|added|support|supports|implement|implements|allow|allows|introduce|introduces|feat|feature|new|enable|enables)\b/i;
/** Same, for refactor verbs. A strong keyword anywhere in the message (a leak, a crash) rescues these. */
const REFACTOR_RE = /^(\S+:\s*)?(refactor\w*|rename[sd]?|clean ?up|cleanups?|tidy|reorgani[sz]e\w*)\b/i;
/** "Fixes #12", "closes gh-3": issue closers, not a description of the change. */
const CLOSER_RE = /\b(fix(?:e[sd])?|close[sd]?|resolve[sd]?)\b[:\s]+(#\d+|gh-\d+|https?:\/\/\S+)/gi;
const REVERT_SUBJECT_RE = /^revert\b/i;
const DOUBLE_REVERT_RE = /^revert\s*"\s*revert\b/i;
const REVERTS_LINE_RE = /^this reverts commit [0-9a-f]{7,40}\.?\s*$/gim;

/** Size above which a commit is treated as a refactor or feature drop, never a fix. */
export const MAX_FIX_FILES = 40;
export const MAX_FIX_LINES = 1500;

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

/**
 * Files Chesterton never indexes or checks: docs, changelogs, CI config, lockfiles. Lines in them
 * are prose, version pins or pipeline settings, and flagging them is noise. Used by both the
 * index builder and the edit check. `docs/`, `doc/`, `.github/` and `.circleci/` only count at
 * the repo root, since nested `doc/` folders often hold code (ripgrep's `crates/core/flags/doc`).
 */
export function isNoiseFile(path: string): boolean {
  const p = toPosix(path).replace(/^\.\//, "");
  const lower = p.toLowerCase();
  const b = basename(lower);
  if (isLockfile(p)) return true;
  if (/\.(md|mdx|markdown|rst|txt|adoc)$/.test(b) && b !== "cmakelists.txt") return true;
  // History.md, CHANGELOG, LICENSE-MIT... but not lib/history.js.
  if (/^(history|changelog|changes|news|readme|authors|contributors|license|licence|copying)(-[\w.-]+)?(\.(md|markdown|rst|txt|adoc|html))?$/.test(b)) return true;
  if (/^(docs?|\.github|\.circleci)\//.test(lower)) return true;
  return /^(\.gitlab-ci\.yml|\.travis\.yml|\.?appveyor\.yml|azure-pipelines\.yml|\.pre-commit-config\.yaml)$/.test(lower);
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

/** Why a subject reads as housekeeping or a feature rather than a fix, or null. */
function demotion(subject: string, message: string, extra: RegExp[]): string | null {
  const s = subject.trim();
  if (NOISE_FIX_SCOPE_RE.test(s)) return `conventional scope '${s.slice(0, s.indexOf(")") + 1)}' is housekeeping`;
  if (NOISE_PREFIX_RE.test(s)) return "dependency or housekeeping commit";
  if (CHORE_RE.test(s) && !STRONG_KEYWORD_RE.test(message)) return "chore commit";
  const noise = NOISE_WORDS_RE.exec(s);
  if (noise) return `subject says '${noise[0].trim().toLowerCase().slice(0, 40)}'`;
  const feature = FEATURE_RE.test(s);
  const refactor = !feature && REFACTOR_RE.test(s) && !STRONG_KEYWORD_RE.test(message);
  if (feature || refactor) {
    // "Fixes #12" in the subject is an issue closer, not a description of the change.
    const plain = s.replace(CLOSER_RE, " ");
    if (!new RegExp(KEYWORD_RE.source, "i").test(plain) && !extra.some((re) => re.test(plain))) {
      return feature ? "subject describes a feature" : "subject describes a refactor";
    }
  }
  return null;
}

/**
 * Score a commit against the fix heuristics in docs/ARCHITECTURE.md ("Detection rules").
 *
 * A commit is a fix only when all of these hold:
 * - it has a fix signal: fix wording, a conventional `fix:` type, or a cfg.fixPatternsExtra match.
 *   Tests, refs and size add to the score and the reasons but never make a fix on their own.
 * - its subject does not read as housekeeping or a feature (see `demotion`).
 * - it is not huge: at most MAX_FIX_FILES files and MAX_FIX_LINES changed lines, not counting
 *   docs, CI config and lockfiles.
 * - score >= FIX_THRESHOLD, and it is not listed in cfg.ignoreCommits.
 *
 * Revert commits: the word "revert" is not a fix signal by itself, and the quoted subject of the
 * reverted commit is ignored (its "fix" describes the other commit). A revert counts only when
 * the rest of its message has fix wording or an issue reference. `Revert "Revert ..."` puts a
 * change back and is never a fix.
 */
export function classifyCommit(input: ClassifyInput, cfg: ChestertonConfig): ClassifyResult {
  const reasons: string[] = [];
  let score = 0;
  const subject = input.subject ?? "";
  const body = input.body ?? "";
  const message = body ? `${subject}\n${body}` : subject;

  const isRevert = REVERT_SUBJECT_RE.test(subject.trim());
  const isDoubleRevert = DOUBLE_REVERT_RE.test(subject.trim());
  const signalText = isRevert ? `${subject.replace(/"[\s\S]*"/, " ")}\n${body.replace(REVERTS_LINE_RE, " ")}` : message;

  // Fix wording in the message (+3 once, whichever rule hits).
  const fixReasons: string[] = [];
  if (CONVENTIONAL_FIX_RE.test(subject.trim())) fixReasons.push("conventional commit type 'fix:'");
  const words: string[] = [];
  for (const m of signalText.matchAll(KEYWORD_RE)) {
    const w = m[1]!.toLowerCase();
    if (isRevert && w === "revert") continue;
    if (!words.includes(w)) words.push(w);
  }
  if (words.length > 0) fixReasons.push(`message says ${words.slice(0, 3).map((w) => `'${w}'`).join(", ")}`);
  const extra: RegExp[] = [];
  for (const src of cfg.fixPatternsExtra ?? []) {
    let re: RegExp;
    try {
      re = new RegExp(src, "i");
    } catch {
      continue;
    }
    extra.push(re);
    const m = message.match(re);
    if (m) fixReasons.push(`message matches custom pattern /${src}/ ('${m[0]}')`);
  }
  const refs = extractRefs(message);
  if (isRevert && fixReasons.length === 0 && extractRefs(signalText).length > 0) fixReasons.push("reverts a change tied to an issue");
  const hasSignal = fixReasons.length > 0;
  if (hasSignal) {
    score += 3;
    reasons.push(...fixReasons);
  }

  // Issue / PR references (+1).
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

  // Size. Docs, changelogs, CI config and lockfiles do not count toward it.
  const counted = files.filter((f) => !isNoiseFile(f.path));
  const changed = counted.reduce((n, f) => n + (f.added || 0) + (f.removed || 0), 0);
  if (counted.length > 0 && counted.length <= 5 && changed <= 60) {
    score += 1;
    reasons.push(`small change (${counted.length} file${counted.length === 1 ? "" : "s"}, ${changed} line${changed === 1 ? "" : "s"})`);
  }
  const tooBig = counted.length > MAX_FIX_FILES || changed > MAX_FIX_LINES;
  if (tooBig) {
    score -= 3;
    reasons.push(`large change (${counted.length} files, ${changed} lines)`);
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
    } else if (files.every((f) => isLockfile(f.path) || isDepFile(f.path) || isFormatFile(f.path) || isNoiseFile(f.path))) {
      score -= 5;
      reasons.push("only touches lockfiles, dependency, CI or formatting files");
    }
  }

  let isFix = hasSignal && !tooBig && score >= FIX_THRESHOLD;
  if (!hasSignal) reasons.push("no fix wording in the message");
  if (isDoubleRevert) {
    isFix = false;
    reasons.push("not a fix: puts back a reverted change");
  } else if (hasSignal) {
    const why = demotion(subject, message, extra);
    if (why) {
      isFix = false;
      reasons.push(`not a fix: ${why}`);
    }
  }
  if (matchesIgnore(input.sha, cfg.ignoreCommits ?? [])) {
    isFix = false;
    reasons.push("listed in ignoreCommits");
  }

  return { isFix, score, reasons, refs, testFiles };
}
