#!/usr/bin/env node

// src/cli.ts
import { readFileSync as readFileSync8, realpathSync, statSync as statSync3 } from "node:fs";
import { isAbsolute as isAbsolute3, relative, resolve as resolve3 } from "node:path";
import { fileURLToPath } from "node:url";

// src/git.ts
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
var GitError = class extends Error {
};
function runGit(args, cwd, timeoutMs = 1e4) {
  const res = spawnSync("git", ["-c", "core.quotepath=off", ...args], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true
  });
  if (res.error) throw new GitError(`git ${args[0]} failed: ${res.error.message}`);
  if (res.status !== 0) throw new GitError(`git ${args[0]} exited ${res.status}: ${res.stderr.trim()}`);
  return res.stdout;
}
function repoRoot(cwd) {
  try {
    return runGit(["rev-parse", "--show-toplevel"], cwd, 5e3).trim();
  } catch {
    return null;
  }
}
function runGitWithInput(args, cwd, input, timeoutMs = 1e4) {
  const res = spawnSync("git", ["-c", "core.quotepath=off", ...args], {
    cwd,
    input,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 1024,
    windowsHide: true
  });
  if (res.error) throw new GitError(`git ${args[0]} failed: ${res.error.message}`);
  if (res.status !== 0) throw new GitError(`git ${args[0]} exited ${res.status}: ${res.stderr.trim()}`);
  return res.stdout;
}
function headSha(cwd, timeoutMs = 5e3) {
  try {
    const out = runGit(["rev-parse", "--verify", "-q", "HEAD^{commit}"], cwd, timeoutMs).trim();
    return out || null;
  } catch {
    return null;
  }
}
function shallowInfo(cwd, timeoutMs = 5e3) {
  const boundary = /* @__PURE__ */ new Set();
  try {
    let p = runGit(["rev-parse", "--git-path", "shallow"], cwd, timeoutMs).trim();
    if (!isAbsolute(p)) p = resolve(cwd, p);
    if (!existsSync(p)) return { shallow: false, boundary };
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const sha = line.trim();
      if (sha) boundary.add(sha);
    }
    return { shallow: boundary.size > 0, boundary };
  } catch {
    return { shallow: false, boundary };
  }
}
function isAncestor(cwd, ancestor, descendant, timeoutMs = 1e4) {
  try {
    runGit(["merge-base", "--is-ancestor", ancestor, descendant], cwd, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

// src/normalize.ts
import { createHash } from "node:crypto";
function normalizeLine(raw) {
  return raw.replace(/\r$/, "").trim().replace(/\s+/g, " ");
}
var TRIVIAL = /* @__PURE__ */ new Set([
  "",
  "{",
  "}",
  "(",
  ")",
  "[",
  "]",
  "};",
  "});",
  "})",
  ");",
  "],",
  "},",
  "end",
  "else",
  "else {",
  "} else {",
  "} else",
  "try {",
  "} catch {",
  "finally {",
  "} finally {",
  "return",
  "return;",
  "break;",
  "continue;",
  "pass",
  "fi",
  "done",
  "esac",
  "then",
  "do",
  "begin",
  "*/",
  "/*",
  "*",
  "//",
  "#",
  '"""',
  "'''",
  "<div>",
  "</div>",
  "default:",
  "</>",
  "<>"
]);
function isTrivial(normalized) {
  if (TRIVIAL.has(normalized)) return true;
  if (normalized.length < 4) return true;
  if (/^[\s{}()[\];,.:]*$/.test(normalized)) return true;
  if (/^(import|from|use|require|#include|using|package)\b/.test(normalized)) return true;
  if (/^(var|let|const)\s+[\w$\s{},:]+=\s*require\(\s*["'`][^"'`]+["'`]\s*\)(\s*\(\s*["'`][^"'`]*["'`]\s*\)|\.[\w$]+)*\s*[;,]?$/.test(normalized)) return true;
  if (isVersionPin(normalized)) return true;
  if (/^(["'`])(?:(?!\1)[^\\]|\\.)*\1,$/.test(normalized)) return true;
  return false;
}
function isVersionPin(n) {
  const ver = String.raw`[~^<>=!]*\s*v?\d+(?:\.[\w*+-]+)*`;
  if (new RegExp(String.raw`^["'][@\w./-]+["']\s*:\s*["']${ver}["'],?$`).test(n)) return true;
  if (new RegExp(String.raw`^[\w.-]+\s*=\s*["']${ver}["'],?$`).test(n) && /\d\.\d/.test(n)) return true;
  if (/^[A-Za-z][\w.-]*(\[[\w,.-]+\])?\s*(==|>=|<=|~=|!=|>|<)\s*\d+\.[\w.*]*(\s*,\s*(==|>=|<=|~=|!=|>|<)\s*\d[\w.*]*)*(\s*;.*)?$/.test(n)) return true;
  if (/^(-\s*)?uses:\s*["']?[\w./-]+@[\w.-]+["']?(\s*#.*)?$/.test(n)) return true;
  if (/^(-\s*)?rev:\s*["']?v?\d[\w.-]*["']?$/.test(n)) return true;
  return false;
}
function hashLine(normalized) {
  return createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}
function splitLines(text) {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
function toPosix(p) {
  return p.replace(/\\/g, "/");
}

// src/config.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { join } from "node:path";
var DEFAULT_CONFIG = {
  mode: "speedbump",
  history: "all",
  maxCommits: 2e4,
  protect: [],
  fixPatternsExtra: [],
  ignoreCommits: [],
  hookTimeoutMs: 1500
};
var CONFIG_FILE = ".chesterton.yml";
var MAX_HOOK_TIMEOUT_MS = 4e3;
var MIN_HOOK_TIMEOUT_MS = 100;
var MODES = ["speedbump", "ask", "warn-only"];
function parseYamlSubset(text) {
  const values = {};
  const warnings = [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let listKey = null;
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const line = stripComment(raw.replace(/\r$/, "")).replace(/\s+$/, "");
    if (line.trim() === "") return;
    if (line.trim() === "---" || line.trim() === "...") return;
    const item = /^\s*-\s*(.*)$/.exec(line);
    if (item && listKey !== null) {
      const list = values[listKey];
      const v = unquote(item[1] ?? "");
      if (Array.isArray(list)) list.push(v);
      else values[listKey] = [v];
      return;
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:(?:\s+(.*)|\s*)$/.exec(line);
    if (!kv || /^\s/.test(line)) {
      warnings.push(`line ${lineNo}: could not read "${raw.trim()}"`);
      listKey = null;
      return;
    }
    const key = kv[1];
    const rest = (kv[2] ?? "").trim();
    if (rest === "") {
      values[key] = [];
      listKey = key;
      return;
    }
    listKey = null;
    if (rest.startsWith("[")) {
      if (!rest.endsWith("]")) {
        warnings.push(`line ${lineNo}: unclosed list for "${key}"`);
        return;
      }
      values[key] = splitInlineList(rest.slice(1, -1));
      return;
    }
    values[key] = unquote(rest);
  });
  return { values, warnings };
}
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote === '"') {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}
function unquote(s) {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\(["\\nt])/g, (_m, c) => c === "n" ? "\n" : c === "t" ? "	" : c);
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  return t;
}
function splitInlineList(inner) {
  const out = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      cur += c;
      if (c === "\\" && quote === '"' && i + 1 < inner.length) {
        cur += inner[++i];
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map(unquote).filter((v) => v !== "");
}
function asList(v) {
  if (v === void 0) return null;
  if (Array.isArray(v)) return v;
  return v === "" ? [] : [v];
}
function asInt(v) {
  if (typeof v !== "string") return null;
  const t = v.replace(/_/g, "");
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}
function parseConfig(text) {
  const { values, warnings } = parseYamlSubset(text);
  const cfg = {
    ...DEFAULT_CONFIG,
    protect: [],
    fixPatternsExtra: [],
    ignoreCommits: []
  };
  const bad = (key, why) => warnings.push(`${key}: ${why}, using default`);
  for (const [key, value] of Object.entries(values)) {
    switch (key) {
      case "mode": {
        const m = typeof value === "string" ? value.toLowerCase() : "";
        if (MODES.includes(m)) cfg.mode = m;
        else bad(key, `expected one of ${MODES.join(", ")}`);
        break;
      }
      case "history": {
        const h = typeof value === "string" ? value.toLowerCase() : "";
        if (/^(all|[1-9]\d*[dwmy])$/.test(h)) cfg.history = h;
        else bad(key, 'expected "all" or a span like 3y, 18m, 6w, 90d');
        break;
      }
      case "max_commits": {
        const n = asInt(value);
        if (n !== null && n >= 1) cfg.maxCommits = n;
        else bad(key, "expected a positive whole number");
        break;
      }
      case "hook_timeout_ms": {
        const n = asInt(value);
        if (n !== null && n >= MIN_HOOK_TIMEOUT_MS && n <= MAX_HOOK_TIMEOUT_MS) cfg.hookTimeoutMs = n;
        else if (n !== null && n > MAX_HOOK_TIMEOUT_MS) {
          cfg.hookTimeoutMs = MAX_HOOK_TIMEOUT_MS;
          warnings.push(`hook_timeout_ms: ${n} is more than the hook timeout allows, capped at ${MAX_HOOK_TIMEOUT_MS}`);
        } else bad(key, `expected a whole number between ${MIN_HOOK_TIMEOUT_MS} and ${MAX_HOOK_TIMEOUT_MS}`);
        break;
      }
      case "protect": {
        const list = asList(value);
        if (list) cfg.protect = list.map((p) => p.replace(/\\/g, "/")).filter((p) => p !== "");
        else bad(key, "expected a list of globs");
        break;
      }
      case "fix_patterns_extra": {
        const list = asList(value) ?? [];
        for (const src of list) {
          try {
            new RegExp(src, "i");
            cfg.fixPatternsExtra.push(src);
          } catch {
            warnings.push(`fix_patterns_extra: "${src}" is not a valid regex, skipped`);
          }
        }
        break;
      }
      case "ignore_commits": {
        const list = asList(value) ?? [];
        for (const sha of list) {
          const s = sha.toLowerCase();
          if (/^[0-9a-f]{4,40}$/.test(s)) cfg.ignoreCommits.push(s);
          else warnings.push(`ignore_commits: "${sha}" is not a commit sha, skipped`);
        }
        break;
      }
      default:
        warnings.push(`unknown key "${key}", ignored`);
    }
  }
  return { config: cfg, warnings };
}
function loadConfigWithWarnings(repoRoot2) {
  let text;
  try {
    text = readFileSync2(join(repoRoot2, CONFIG_FILE), "utf8");
  } catch {
    return { config: { ...DEFAULT_CONFIG, protect: [], fixPatternsExtra: [], ignoreCommits: [] }, warnings: [], found: false };
  }
  try {
    return { ...parseConfig(text), found: true };
  } catch (e) {
    return {
      config: { ...DEFAULT_CONFIG, protect: [], fixPatternsExtra: [], ignoreCommits: [] },
      warnings: [`could not parse ${CONFIG_FILE}: ${e.message}`],
      found: true
    };
  }
}
function loadConfig(repoRoot2) {
  return loadConfigWithWarnings(repoRoot2).config;
}

// src/index-builder.ts
import { randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync as readFileSync4, statSync, unlinkSync as unlinkSync2, utimesSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join as join3 } from "node:path";

// src/types.ts
var FIX_THRESHOLD = 3;
var INDEX_VERSION = 2;

// src/classify.ts
var KEYWORD_RE = /\b(fix(?:e[sd])?|bug|hotfix|regression|revert|race|deadlock|crash|leak|workaround|incident|cve-\d+|oncall|segfault|null ?pointer|npe|off.by.one)\b/gi;
var CONVENTIONAL_FIX_RE = /^fix(\(.+\))?!?:/i;
var NOISE_FIX_SCOPE_RE = /^fix\((deps|devdeps|dev-deps|ci|build|refactor|docs|lint|style|typo|test|tests)\)!?:/i;
var NOISE_PREFIX_RE = /^((build|chore)\(deps\)|deps(\([^)]*\))?|(docs?|style|lint|ci|tests?|refactor)(\([^)]*\))?)!?:|^(update (to )?)?@?[\w./-]+@\^?v?\d+\.\d+/i;
var CHORE_RE = /^chore(\([^)]*\))?!?:/i;
var STRONG_KEYWORD_RE = /\b(race|crash(e[sd])?|leak(s|ed)?|regression|cve-\d+|deadlock|segfault|security|vulnerab\w*)\b/i;
var NOISE_WORDS_RE = /\b(bump(s|ed)?|typos?|spelling|misspell\w*|codespell|lint(s|er|ers|ing)?|clippy|formatting|reformat\w*|rustfmt|prettier|whitespace)\b|\b(update[sd]?|upgrade[sd]?)\b.*\b(dependency|dependencies|deps|dev-?dependencies)\b|^(\S+:\s*)?(run |apply )?(format|fmt)\b/i;
var FEATURE_RE = /^(\S+:\s*)?(add|adds|added|support|supports|implement|implements|allow|allows|introduce|introduces|feat|feature|new|enable|enables)\b/i;
var REFACTOR_RE = /^(\S+:\s*)?(refactor\w*|rename[sd]?|clean ?up|cleanups?|tidy|reorgani[sz]e\w*)\b/i;
var CLOSER_RE = /\b(fix(?:e[sd])?|close[sd]?|resolve[sd]?)\b[:\s]+(#\d+|gh-\d+|https?:\/\/\S+)/gi;
var REVERT_SUBJECT_RE = /^revert\b/i;
var DOUBLE_REVERT_RE = /^revert\s*"\s*revert\b/i;
var REVERTS_LINE_RE = /^this reverts commit [0-9a-f]{7,40}\.?\s*$/gim;
var MAX_FIX_FILES = 40;
var MAX_FIX_LINES = 1500;
var NOT_TICKETS = /* @__PURE__ */ new Set(["UTF", "SHA", "ISO", "RFC", "TLS", "SSL", "HTTP", "MD", "AES", "RSA", "IPV", "X", "CP", "WIN"]);
var LOCKFILES = /* @__PURE__ */ new Set([
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
  "packages.lock.json"
]);
var DEP_FILES = /* @__PURE__ */ new Set([
  "go.mod",
  "requirements.txt",
  "requirements-dev.txt",
  "pipfile",
  "gemfile",
  ".nvmrc",
  ".node-version",
  ".tool-versions"
]);
var FORMAT_FILES = /* @__PURE__ */ new Set([
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
  ".rustfmt.toml"
]);
function basename(p) {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}
function isLockfile(path) {
  return LOCKFILES.has(basename(toPosix(path)).toLowerCase());
}
function isDepFile(path) {
  const b = basename(toPosix(path)).toLowerCase();
  return DEP_FILES.has(b) || /^requirements.*\.txt$/.test(b);
}
function isFormatFile(path) {
  return FORMAT_FILES.has(basename(toPosix(path)).toLowerCase());
}
function isNoiseFile(path) {
  const p = toPosix(path).replace(/^\.\//, "");
  const lower = p.toLowerCase();
  const b = basename(lower);
  if (isLockfile(p)) return true;
  if (/\.(md|mdx|markdown|rst|txt|adoc)$/.test(b) && b !== "cmakelists.txt") return true;
  if (/^(history|changelog|changes|news|readme|authors|contributors|license|licence|copying)(-[\w.-]+)?(\.(md|markdown|rst|txt|adoc|html))?$/.test(b)) return true;
  if (/^(docs?|\.github|\.circleci)\//.test(lower)) return true;
  return /^(\.gitlab-ci\.yml|\.travis\.yml|\.?appveyor\.yml|azure-pipelines\.yml|\.pre-commit-config\.yaml)$/.test(lower);
}
function isDocFile(path) {
  const p = toPosix(path).toLowerCase();
  const b = basename(p);
  if (/(^|\/)(docs?|documentation)\//.test(p)) return true;
  if (/\.(md|mdx|markdown|rst|adoc|txt)$/.test(b) && !/^requirements.*\.txt$/.test(b) && b !== "cmakelists.txt") return true;
  return /^(license|licence|copying|authors|contributors|changelog|changes|notice|readme)(\..*)?$/.test(b);
}
function isTestFile(path) {
  const p = toPosix(path);
  const b = basename(p);
  if (/(^|\/)(test|tests|__tests__|spec)\//.test(p)) return true;
  if (/_test\.[^/.]+$/.test(b)) return true;
  if (/\.(test|spec)\.[^/]+$/.test(b)) return true;
  if (/^test_.*\.py$/.test(b)) return true;
  return false;
}
function extractRefs(message) {
  const refs = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (r) => {
    if (!seen.has(r)) {
      seen.add(r);
      refs.push(r);
    }
  };
  const urlRe = /https?:\/\/[^\s)>\]]*(?:github\.com\/[^\s)>\]]+\/(?:issues|pull)\/\d+|gitlab\.[^\s)>\]]+\/(?:issues|merge_requests)\/\d+|atlassian\.net\/browse\/[A-Z][A-Z0-9]+-\d+|jira[^\s)>\]]*\/browse\/[A-Z][A-Z0-9]+-\d+)/g;
  const urls = message.match(urlRe) ?? [];
  let rest = message;
  for (const u of urls) {
    push(u);
    rest = rest.split(u).join(" ");
  }
  for (const m of rest.matchAll(/(?:^|[^\w&/])(#\d+)\b/g)) push(m[1]);
  for (const m of rest.matchAll(/\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/g)) {
    if (NOT_TICKETS.has(m[1])) continue;
    push(`${m[1]}-${m[2]}`);
  }
  return refs;
}
function matchesIgnore(sha, ignore) {
  const s = sha.toLowerCase();
  return ignore.some((p) => {
    const q = p.trim().toLowerCase();
    return q.length >= 4 && s.startsWith(q);
  });
}
function demotion(subject, message, extra) {
  const s = subject.trim();
  if (NOISE_FIX_SCOPE_RE.test(s)) return `conventional scope '${s.slice(0, s.indexOf(")") + 1)}' is housekeeping`;
  if (NOISE_PREFIX_RE.test(s)) return "dependency or housekeeping commit";
  if (CHORE_RE.test(s) && !STRONG_KEYWORD_RE.test(message)) return "chore commit";
  const noise = NOISE_WORDS_RE.exec(s);
  if (noise) return `subject says '${noise[0].trim().toLowerCase().slice(0, 40)}'`;
  const feature = FEATURE_RE.test(s);
  const refactor = !feature && REFACTOR_RE.test(s) && !STRONG_KEYWORD_RE.test(message);
  if (feature || refactor) {
    const plain = s.replace(CLOSER_RE, " ");
    if (!new RegExp(KEYWORD_RE.source, "i").test(plain) && !extra.some((re) => re.test(plain))) {
      return feature ? "subject describes a feature" : "subject describes a refactor";
    }
  }
  return null;
}
function classifyCommit(input, cfg) {
  const reasons = [];
  let score = 0;
  const subject = input.subject ?? "";
  const body = input.body ?? "";
  const message = body ? `${subject}
${body}` : subject;
  const isRevert = REVERT_SUBJECT_RE.test(subject.trim());
  const isDoubleRevert = DOUBLE_REVERT_RE.test(subject.trim());
  const signalText = isRevert ? `${subject.replace(/"[\s\S]*"/, " ")}
${body.replace(REVERTS_LINE_RE, " ")}` : message;
  const fixReasons = [];
  if (CONVENTIONAL_FIX_RE.test(subject.trim())) fixReasons.push("conventional commit type 'fix:'");
  const words = [];
  for (const m of signalText.matchAll(KEYWORD_RE)) {
    const w = m[1].toLowerCase();
    if (isRevert && w === "revert") continue;
    if (!words.includes(w)) words.push(w);
  }
  if (words.length > 0) fixReasons.push(`message says ${words.slice(0, 3).map((w) => `'${w}'`).join(", ")}`);
  const extra = [];
  for (const src of cfg.fixPatternsExtra ?? []) {
    let re;
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
  if (refs.length > 0) {
    score += 1;
    reasons.push(`references ${refs.slice(0, 3).join(", ")}`);
  }
  const files = input.files ?? [];
  const testFiles = [];
  const testReasons = [];
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

// src/index-store.ts
import { existsSync as existsSync2, mkdirSync, readFileSync as readFileSync3, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute as isAbsolute2, join as join2, resolve as resolve2 } from "node:path";
var INDEX_FILE = "index.json";
var dirCache = /* @__PURE__ */ new Map();
function indexDir(repoRoot2) {
  const cached = dirCache.get(repoRoot2);
  if (cached && existsSync2(cached)) return cached;
  let gitDir;
  try {
    gitDir = runGit(["rev-parse", "--absolute-git-dir"], repoRoot2, 5e3).trim();
  } catch {
    gitDir = runGit(["rev-parse", "--git-dir"], repoRoot2, 5e3).trim();
  }
  if (!isAbsolute2(gitDir)) gitDir = resolve2(repoRoot2, gitDir);
  const dir = join2(gitDir, "chesterton");
  mkdirSync(dir, { recursive: true });
  dirCache.set(repoRoot2, dir);
  return dir;
}
var isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
var isStrArr = (x) => Array.isArray(x) && x.every((v) => typeof v === "string");
function isValidEntries(x) {
  if (!Array.isArray(x)) return false;
  for (const e of x) {
    if (!isObj(e) || typeof e.hash !== "string" || typeof e.text !== "string" || typeof e.line !== "number") return false;
  }
  return true;
}
function isValidCommit(x) {
  return isObj(x) && typeof x.sha === "string" && typeof x.date === "string" && typeof x.author === "string" && typeof x.subject === "string" && typeof x.score === "number" && isStrArr(x.reasons) && isStrArr(x.refs) && isStrArr(x.testFiles);
}
function isValidRecord(x) {
  return isObj(x) && typeof x.sha === "string" && typeof x.path === "string" && (x.oldPath === void 0 || typeof x.oldPath === "string") && isValidEntries(x.added) && isValidEntries(x.removed);
}
function isValidIndex(x) {
  if (!isObj(x)) return false;
  if (x.version !== INDEX_VERSION || typeof x.head !== "string" || typeof x.builtAt !== "string") return false;
  if (!isObj(x.commits) || !isObj(x.files)) return false;
  for (const c of Object.values(x.commits)) if (!isValidCommit(c)) return false;
  for (const recs of Object.values(x.files)) {
    if (!Array.isArray(recs) || !recs.every(isValidRecord)) return false;
  }
  return true;
}
function loadIndex(repoRoot2) {
  try {
    const file = join2(indexDir(repoRoot2), INDEX_FILE);
    if (!existsSync2(file)) return null;
    const parsed = JSON.parse(readFileSync3(file, "utf8"));
    return isValidIndex(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function saveIndex(repoRoot2, idx) {
  const dir = indexDir(repoRoot2);
  const file = join2(dir, INDEX_FILE);
  const tmp = join2(dir, `${INDEX_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmp, JSON.stringify(idx));
  let lastErr;
  for (let i = 0; i < 10; i++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      const until = Date.now() + 20 * (i + 1);
      while (Date.now() < until) {
      }
    }
  }
  try {
    unlinkSync(tmp);
  } catch {
  }
  throw lastErr;
}
function recordsForFile(idx, relPath) {
  const key = toPosix(relPath).replace(/^(\.\/)+/, "");
  return idx.files[key] ?? [];
}
function emptyIndex(head = "") {
  return { version: INDEX_VERSION, head, builtAt: (/* @__PURE__ */ new Date()).toISOString(), commits: {}, files: {} };
}

// src/index-builder.ts
var LOCK_FILE = "index.lock";
var STALE_LOCK_MS = 5 * 6e4;
var MAX_LIVE_LOCK_MS = 30 * 6e4;
var DEFAULT_TIMEOUT_MS = 5 * 6e4;
var MAX_TEXT = 200;
function sinceArg(history) {
  const h = (history ?? "").trim().toLowerCase();
  if (!h || h === "all") return null;
  const m = /^(\d+)\s*(y|yr|yrs|year|years|m|mo|month|months|w|week|weeks|d|day|days)$/.exec(h);
  if (m) {
    const n = m[1];
    const u = m[2];
    const unit = u.startsWith("y") ? "years" : u.startsWith("m") ? "months" : u.startsWith("w") ? "weeks" : "days";
    return `--since=${n}.${unit}.ago`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(h)) return `--since=${h}`;
  return null;
}
function newSeparators() {
  const token = randomBytes(8).toString("hex");
  return { record: `${token}`, field: `${token}` };
}
function metaFormat(sep) {
  const esc = (s) => s.replace(/%/g, "%%").replace(/\x1e/g, "%x1e").replace(/\x1f/g, "%x1f");
  const r = esc(sep.record);
  const f = esc(sep.field);
  return `--format=${r}%H${f}%P${f}%aI${f}%an${f}%s${f}%b${f}`;
}
var DEFAULT_SEPARATORS = { record: "", field: "" };
function logMeta(repoRoot2, range, cfg, timeoutMs) {
  const sep = newSeparators();
  const args = [
    "log",
    "--no-merges",
    "--topo-order",
    "--no-show-signature",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "-M",
    "--raw",
    "--numstat",
    "-z",
    metaFormat(sep)
  ];
  const since = sinceArg(cfg.history);
  if (since) args.push(since);
  if (cfg.maxCommits && cfg.maxCommits > 0) args.push(`-n${Math.floor(cfg.maxCommits)}`);
  args.push(...range, "--");
  return parseMeta(runGit(args, repoRoot2, timeoutMs), sep);
}
function parseMeta(out, sep = DEFAULT_SEPARATORS) {
  const commits = [];
  for (const chunk of out.split(sep.record)) {
    if (!chunk.trim()) continue;
    const parts = [];
    let pos = 0;
    for (let i = 0; i < 6; i++) {
      const next = chunk.indexOf(sep.field, pos);
      if (next < 0) break;
      parts.push(chunk.slice(pos, next));
      pos = next + sep.field.length;
    }
    if (parts.length < 6) continue;
    const [sha, parents, date, author, subject, body] = parts;
    commits.push({
      sha: sha.trim(),
      parents: parents.trim() ? parents.trim().split(/\s+/).length : 0,
      date,
      author,
      subject,
      body: body.trim(),
      files: parseFileStats(chunk.slice(pos))
    });
  }
  return commits;
}
function parseFileStats(rest) {
  const tokens = rest.split("\0").map((t) => t.replace(/^\n+/, "")).filter((t) => t !== "");
  const byPath = /* @__PURE__ */ new Map();
  const get = (path) => {
    let f = byPath.get(path);
    if (!f) {
      f = { path, status: "M", added: 0, removed: 0 };
      byPath.set(path, f);
    }
    return f;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith(":")) {
      const status = t.slice(t.lastIndexOf(" ") + 1);
      const letter = status.charAt(0);
      if (letter === "R" || letter === "C") {
        const oldPath = toPosix(tokens[++i] ?? "");
        const newPath = toPosix(tokens[++i] ?? "");
        const f2 = get(newPath);
        f2.status = letter;
        f2.oldPath = oldPath;
      } else {
        const f2 = get(toPosix(tokens[++i] ?? ""));
        f2.status = letter || "M";
      }
      continue;
    }
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(t);
    if (!m) continue;
    let path = m[3];
    if (path === "") {
      i++;
      path = tokens[++i] ?? "";
    }
    const f = get(toPosix(path));
    f.added = m[1] === "-" ? 0 : Number(m[1]);
    f.removed = m[2] === "-" ? 0 : Number(m[2]);
  }
  return [...byPath.values()];
}
var LOCKFILE_EXCLUDES = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "poetry.lock",
  "go.sum",
  "Gemfile.lock",
  "composer.lock"
].map((n) => `:(exclude,glob)**/${n}`);
function readFixPatches(repoRoot2, shas, timeoutMs) {
  if (shas.length === 0) return /* @__PURE__ */ new Map();
  const args = [
    "log",
    "--stdin",
    "--no-walk=unsorted",
    "--no-show-signature",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "-p",
    "-M",
    "--unified=0",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--format=%x1e%H",
    "--",
    ".",
    ...LOCKFILE_EXCLUDES
  ];
  return parsePatches(runGitWithInput(args, repoRoot2, shas.join("\n") + "\n", timeoutMs));
}
function unquotePath(p) {
  if (!(p.length >= 2 && p.startsWith('"') && p.endsWith('"'))) return p;
  const body = p.slice(1, -1);
  const bytes = [];
  const simple = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") {
      for (const b of Buffer.from(c, "utf8")) bytes.push(b);
      continue;
    }
    const n = body[i + 1] ?? "";
    if (/[0-7]/.test(n)) {
      const oct = body.slice(i + 1, i + 4);
      bytes.push(parseInt(oct, 8));
      i += 3;
    } else {
      bytes.push(simple[n] ?? n.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}
function headerPath(raw, prefix) {
  let p = raw.replace(/\t$/, "");
  if (p === "/dev/null") return null;
  p = unquotePath(p);
  if (p.startsWith(prefix)) p = p.slice(prefix.length);
  return toPosix(p);
}
function entry(raw, line) {
  const norm = normalizeLine(raw);
  if (isTrivial(norm)) return null;
  return { hash: hashLine(norm), text: raw.replace(/\r$/, "").trim().slice(0, MAX_TEXT), line };
}
function dropMoves(rec) {
  const addedH = new Set(rec.added.map((e) => e.hash));
  const removedH = new Set(rec.removed.map((e) => e.hash));
  rec.added = rec.added.filter((e) => !removedH.has(e.hash));
  rec.removed = rec.removed.filter((e) => !addedH.has(e.hash));
}
function parsePatches(out) {
  const result = /* @__PURE__ */ new Map();
  for (const chunk of out.split("")) {
    if (!chunk.trim()) continue;
    const lines = chunk.split("\n");
    const sha = lines[0].trim();
    const records = [];
    let oldP = null;
    let newP = null;
    let renameFrom = null;
    let renameTo = null;
    let sawHeaders = false;
    let added = [];
    let removed = [];
    let oldLeft = 0;
    let newLeft = 0;
    let oldLine = 0;
    let newLine = 0;
    const flush = () => {
      const path = sawHeaders ? newP : renameTo;
      const prev = sawHeaders ? oldP : renameFrom;
      if (path && !isNoiseFile(path) && (added.length || removed.length)) {
        const rec = { sha, path, added, removed };
        if (prev && prev !== path) rec.oldPath = prev;
        dropMoves(rec);
        if (rec.added.length || rec.removed.length) records.push(rec);
      }
      oldP = newP = renameFrom = renameTo = null;
      sawHeaders = false;
      added = [];
      removed = [];
      oldLeft = newLeft = 0;
    };
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (oldLeft > 0 || newLeft > 0) {
        const c = line.charAt(0);
        if (c === "-" && oldLeft > 0) {
          const e = entry(line.slice(1), oldLine);
          if (e) removed.push(e);
          oldLine++;
          oldLeft--;
          continue;
        }
        if (c === "+" && newLeft > 0) {
          const e = entry(line.slice(1), newLine);
          if (e) added.push(e);
          newLine++;
          newLeft--;
          continue;
        }
        if (c === " ") {
          oldLine++;
          newLine++;
          oldLeft = Math.max(0, oldLeft - 1);
          newLeft = Math.max(0, newLeft - 1);
          continue;
        }
        if (c === "\\") continue;
        oldLeft = newLeft = 0;
      }
      if (line.startsWith("diff --git ")) {
        flush();
      } else if (line.startsWith("rename from ")) {
        renameFrom = toPosix(unquotePath(line.slice("rename from ".length)));
      } else if (line.startsWith("rename to ")) {
        renameTo = toPosix(unquotePath(line.slice("rename to ".length)));
      } else if (line.startsWith("--- ")) {
        oldP = headerPath(line.slice(4), "a/");
        sawHeaders = true;
      } else if (line.startsWith("+++ ")) {
        newP = headerPath(line.slice(4), "b/");
        sawHeaders = true;
      } else if (line.startsWith("@@ ")) {
        const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (m) {
          oldLine = Number(m[1]);
          oldLeft = m[2] === void 0 ? 1 : Number(m[2]);
          newLine = Number(m[3]);
          newLeft = m[4] === void 0 ? 1 : Number(m[4]);
        }
      }
    }
    flush();
    if (records.length) result.set(sha, [...result.get(sha) ?? [], ...records]);
  }
  return result;
}
var IndexLockError = class extends Error {
};
function ownerAlive(p) {
  try {
    const o = JSON.parse(readFileSync4(p, "utf8"));
    if (typeof o.pid !== "number" || !Number.isInteger(o.pid) || o.pid <= 0) return false;
    if (typeof o.host === "string" && o.host !== hostname()) return false;
    if (o.pid === process.pid) return false;
    process.kill(o.pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}
function acquireLock(dir) {
  const p = join3(dir, LOCK_FILE);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(p, "wx");
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), at: (/* @__PURE__ */ new Date()).toISOString() }));
      } finally {
        closeSync(fd);
      }
      return p;
    } catch (err) {
      const code = err.code;
      if (code !== "EEXIST") throw new IndexLockError(`cannot create ${p}: ${err.message}`);
      try {
        const age = Date.now() - statSync(p).mtimeMs;
        if (age > STALE_LOCK_MS && (age > MAX_LIVE_LOCK_MS || !ownerAlive(p))) {
          unlinkSync2(p);
          continue;
        }
      } catch {
        continue;
      }
      return null;
    }
  }
  return null;
}
function touchLock(p) {
  try {
    const now = /* @__PURE__ */ new Date();
    utimesSync(p, now, now);
  } catch {
  }
}
function isLockHeld(repoRoot2) {
  try {
    const p = join3(indexDir(repoRoot2), LOCK_FILE);
    const age = Date.now() - statSync(p).mtimeMs;
    return age <= STALE_LOCK_MS || age <= MAX_LIVE_LOCK_MS && ownerAlive(p);
  } catch {
    return false;
  }
}
function releaseLock(p) {
  try {
    unlinkSync2(p);
  } catch {
  }
}
function trackedFiles(repoRoot2, head, timeoutMs) {
  const out = runGit(["ls-tree", "-r", "-z", "--name-only", "--full-tree", head], repoRoot2, timeoutMs);
  return new Set(out.split("\0").filter(Boolean).map(toPosix));
}
function buildIndexDetailed(repoRoot2, cfg, opts = {}) {
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const remaining = () => Math.max(1e3, deadline - Date.now());
  const dir = indexDir(repoRoot2);
  const head = headSha(repoRoot2);
  if (!head) return { index: emptyIndex(), outcome: "no-commits" };
  const lock = acquireLock(dir);
  if (!lock) return { index: loadIndex(repoRoot2) ?? emptyIndex(), outcome: "busy" };
  try {
    const prev = opts.full ? null : loadIndex(repoRoot2);
    if (prev && prev.head === head) return { index: prev, outcome: "up-to-date" };
    const base = prev && prev.head && isAncestor(repoRoot2, prev.head, head, remaining()) ? prev : null;
    const range = base ? [`${base.head}..${head}`] : [head];
    const metas = logMeta(repoRoot2, range, cfg, remaining());
    touchLock(lock);
    const shallow = shallowInfo(repoRoot2);
    const commits = {};
    const fixShas = [];
    for (const m of metas) {
      if (shallow.boundary.has(m.sha) || shallow.shallow && m.parents === 0) continue;
      const r = classifyCommit({ sha: m.sha, subject: m.subject, body: m.body, files: m.files, parents: m.parents }, cfg);
      if (!r.isFix) continue;
      fixShas.push(m.sha);
      commits[m.sha] = {
        sha: m.sha,
        date: m.date,
        author: m.author,
        subject: m.subject,
        score: r.score,
        reasons: r.reasons,
        refs: r.refs,
        testFiles: r.testFiles
      };
    }
    const recordsBySha = readFixPatches(repoRoot2, fixShas, remaining());
    touchLock(lock);
    const forward = /* @__PURE__ */ new Map();
    const resolvePath = (p) => forward.has(p) ? forward.get(p) : p;
    const files = {};
    const add = (key, rec) => {
      (files[key] ??= []).push(rec);
    };
    for (const m of metas) {
      for (const rec of recordsBySha.get(m.sha) ?? []) {
        const key = resolvePath(rec.path);
        if (key) add(key, rec);
      }
      for (const f of m.files) {
        if (f.status === "R" && f.oldPath) forward.set(f.oldPath, resolvePath(f.path));
        else if (f.status === "D") forward.set(f.path, null);
      }
    }
    if (base) {
      for (const [sha, c] of Object.entries(base.commits)) if (!commits[sha]) commits[sha] = c;
      for (const [oldKey, recs] of Object.entries(base.files)) {
        const key = resolvePath(oldKey);
        if (!key) continue;
        for (const rec of recs) add(key, rec);
      }
    }
    const tracked = trackedFiles(repoRoot2, head, remaining());
    for (const key of Object.keys(files)) if (!tracked.has(key)) delete files[key];
    const idx = { version: INDEX_VERSION, head, builtAt: (/* @__PURE__ */ new Date()).toISOString(), commits, files };
    saveIndex(repoRoot2, idx);
    return { index: idx, outcome: "built" };
  } finally {
    releaseLock(lock);
  }
}
function isIndexFresh(repoRoot2, idx) {
  if (!idx) return false;
  const head = headSha(repoRoot2);
  return head !== null && idx.head === head;
}

// src/analyze.ts
import { readFileSync as readFileSync6 } from "node:fs";
import { join as join5 } from "node:path";

// src/blame.ts
import { readFileSync as readFileSync5, statSync as statSync2 } from "node:fs";
import { join as join4 } from "node:path";
var HEADER_RE = /^([0-9a-f]{40}|[0-9a-f]{64}) (\d+) (\d+)(?: (\d+))?$/;
function parsePorcelain(out) {
  const result = [];
  const fileBySha = /* @__PURE__ */ new Map();
  let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("	")) {
      if (cur) {
        result.push({ line: cur.final, sha: cur.sha, origLine: cur.orig, origPath: fileBySha.get(cur.sha) ?? "" });
      }
      cur = null;
      continue;
    }
    const m = HEADER_RE.exec(line);
    if (m && !cur) {
      cur = { sha: m[1], orig: Number(m[2]), final: Number(m[3]) };
      continue;
    }
    if (cur && line.startsWith("filename ")) {
      fileBySha.set(cur.sha, toPosix(unquotePath(line.slice("filename ".length).replace(/\r$/, ""))));
    }
  }
  return result;
}
function blameRange(repoRoot2, relPath, start, end, timeoutMs = 5e3) {
  try {
    const rel = toPosix(relPath).replace(/^(\.\/)+/, "");
    const full = join4(repoRoot2, rel);
    if (!statSync2(full).isFile()) return [];
    const lineCount = splitLines(readFileSync5(full, "utf8")).length;
    const s = Math.max(1, Math.floor(start));
    const e = Math.min(lineCount, Math.floor(end));
    if (lineCount === 0 || s > e) return [];
    const out = runGit(["blame", "--porcelain", "-L", `${s},${e}`, "--", rel], repoRoot2, timeoutMs);
    return parsePorcelain(out);
  } catch {
    return [];
  }
}

// src/analyze.ts
var NEAR = 3;
var MAX_LINES = 8;
var WEAK_SINGLE_MIN = 25;
var ZERO_SHA = /^0+$/;
function isIgnored(sha, cfg) {
  return cfg.ignoreCommits.some((p) => p.length > 0 && sha.startsWith(p));
}
function isPureMove(r) {
  if (r.added.length === 0 || r.added.length !== r.removed.length) return false;
  const a = r.added.map((e) => e.hash).sort();
  const b = r.removed.map((e) => e.hash).sort();
  return a.every((h, i) => h === b[i]);
}
function readCurrent(repoRoot2, relPath) {
  try {
    return readFileSync6(join5(repoRoot2, relPath), "utf8");
  } catch {
    return null;
  }
}
function isWhitespaceReflow(change) {
  if (change.isNewFile || change.removed.length === 0 || change.added.length === 0) return false;
  const squash = (lines) => lines.join("").replace(/\s+/g, "");
  const before = squash(change.removed.map((r) => r.text));
  return before.length > 0 && before === squash(change.added);
}
function mergeRanges(ranges) {
  const sorted = [...ranges].sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}
function analyzeChange(repoRoot2, change, idx, cfg, deps = {}) {
  if (isNoiseFile(change.relPath)) return [];
  if (isWhitespaceReflow(change)) return [];
  const records = recordsForFile(idx, change.relPath).filter(
    (r) => idx.commits[r.sha] && !isIgnored(r.sha, cfg) && !isPureMove(r)
  );
  const hits = [];
  const current = deps.currentContent !== void 0 ? deps.currentContent : change.isNewFile ? null : readCurrent(repoRoot2, change.relPath);
  const currentLines = current === null ? [] : splitLines(current);
  if (!change.isNewFile) {
    const removed = change.removed.map((r) => ({ ...r, norm: normalizeLine(r.text) })).filter((r) => !isTrivial(r.norm));
    if (removed.length > 0) {
      const found = removesFix(repoRoot2, change, removed, records, idx, cfg, deps, currentLines.length);
      if (isTestFile(change.relPath)) for (const h of found) h.strength = "weak";
      hits.push(...found);
    }
  }
  if (records.length > 0 && change.added.length > 0) hits.push(...readdsRemoved(change, records, currentLines));
  const byKey = /* @__PURE__ */ new Map();
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
  const findings = [];
  for (const h of byKey.values()) {
    const fix = idx.commits[h.sha];
    if (!fix) continue;
    const lines = [...new Set(h.lines)].slice(0, MAX_LINES);
    findings.push({ kind: h.kind, strength: h.strength, file: change.relPath, fix, lines });
  }
  findings.sort((x, y) => x.strength === y.strength ? 0 : x.strength === "strong" ? -1 : 1);
  return findings;
}
function removesFix(repoRoot2, change, removed, records, idx, cfg, deps, fileLineCount) {
  const blame = deps.blame ?? blameRange;
  const maxLine = Math.max(fileLineCount, ...removed.map((r) => r.line));
  const windows = mergeRanges(
    removed.map((r) => [Math.max(1, r.line - NEAR), Math.min(maxLine, r.line + NEAR)])
  );
  const blamed = /* @__PURE__ */ new Map();
  for (const [s, e] of windows) {
    let lines = [];
    try {
      lines = blame(repoRoot2, change.relPath, s, e, deps.timeoutMs);
    } catch {
      const inside = removed.filter((r) => r.line >= s && r.line <= e).map((r) => r.line);
      if (inside.length === 0) continue;
      try {
        lines = blame(repoRoot2, change.relPath, Math.min(...inside), Math.max(...inside), deps.timeoutMs);
      } catch {
        lines = [];
      }
    }
    for (const bl of lines) blamed.set(bl.line, bl);
  }
  const recordsBySha = /* @__PURE__ */ new Map();
  for (const r of records) {
    const list = recordsBySha.get(r.sha) ?? [];
    list.push(r);
    recordsBySha.set(r.sha, list);
  }
  const isFixSha = (sha) => !ZERO_SHA.test(sha) && !!idx.commits[sha] && !isIgnored(sha, cfg);
  const hits = [];
  for (const r of removed) {
    const bl = blamed.get(r.line);
    const hash = hashLine(r.norm);
    if (bl && isFixSha(bl.sha)) {
      const recs = recordsBySha.get(bl.sha) ?? [];
      const strong = recs.some((rec) => rec.added.some((e) => e.hash === hash));
      hits.push({ kind: "removes-fix", strength: strong ? "strong" : "weak", sha: bl.sha, lines: [r.text.trim()] });
      if (strong) continue;
    }
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
function readdsRemoved(change, records, currentLines) {
  const present = /* @__PURE__ */ new Set();
  for (const l of currentLines) {
    const n = normalizeLine(l);
    if (!isTrivial(n)) present.add(hashLine(n));
  }
  const added = change.added.map((text) => ({ text: text.trim(), norm: normalizeLine(text) })).filter((a) => !isTrivial(a.norm)).map((a) => ({ ...a, hash: hashLine(a.norm) }));
  if (added.length === 0) return [];
  const hits = [];
  for (const rec of records) {
    if (rec.removed.length === 0) continue;
    const rem = rec.removed.map((e) => e.hash);
    const positions = /* @__PURE__ */ new Map();
    rem.forEach((h, j) => {
      const list = positions.get(h) ?? [];
      list.push(j);
      positions.set(h, list);
    });
    const inStrongRun = /* @__PURE__ */ new Set();
    const strongLines = [];
    for (let i = 0; i < added.length; i++) {
      const starts = positions.get(added[i].hash);
      if (!starts) continue;
      let best = 0;
      for (const j of starts) {
        let k = 0;
        while (i + k < added.length && j + k < rem.length && added[i + k].hash === rem[j + k]) k++;
        if (k > best) best = k;
      }
      if (best >= 2) {
        const run = added.slice(i, i + best);
        if (!run.every((a) => present.has(a.hash))) {
          for (let k = 0; k < best; k++) inStrongRun.add(i + k);
          strongLines.push(...run.map((a) => a.text));
        }
        i += best - 1;
      }
    }
    if (strongLines.length > 0) hits.push({ kind: "re-adds-removed", strength: "strong", sha: rec.sha, lines: strongLines });
    const weakLines = added.filter((a, i) => !inStrongRun.has(i) && a.norm.length >= WEAK_SINGLE_MIN && positions.has(a.hash) && !present.has(a.hash)).map((a) => a.text);
    if (weakLines.length > 0) hits.push({ kind: "re-adds-removed", strength: "weak", sha: rec.sha, lines: weakLines });
  }
  return hits;
}

// src/diff-change.ts
var EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
function gitDiffChanges(repoRoot2, range = {}, timeoutMs = 6e4) {
  const head = revParse(repoRoot2, "HEAD");
  let preImage;
  const args = [
    "diff",
    "--unified=0",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "-M",
    "--src-prefix=a/",
    "--dst-prefix=b/"
  ];
  if (range.staged) {
    preImage = head ?? EMPTY_TREE;
    args.push("--cached", preImage);
  } else if (range.base) {
    const base = revParse(repoRoot2, range.base);
    if (!base) throw new Error(`unknown revision "${range.base}"`);
    let mb = base;
    if (head) {
      try {
        mb = runGit(["merge-base", base, head], repoRoot2, timeoutMs).trim() || base;
      } catch {
        mb = base;
      }
    }
    preImage = mb;
    args.push(preImage);
  } else {
    preImage = head ?? EMPTY_TREE;
    args.push(preImage);
  }
  args.push("--");
  const out = runGit(args, repoRoot2, timeoutMs);
  return { preImage, changes: parseUnifiedDiff(out) };
}
function revParse(repoRoot2, rev) {
  try {
    return runGit(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], repoRoot2, 1e4).trim() || null;
  } catch {
    return null;
  }
}
function parseUnifiedDiff(diff) {
  const out = [];
  const lines = diff.split("\n");
  let cur = null;
  let oldLine = 0;
  let inHunk = false;
  const flush = () => {
    if (cur && !cur.skip && cur.relPath && (cur.removed.length > 0 || cur.added.length > 0)) {
      const { skip: _s, hunks: _h, ...change } = cur;
      if (change.oldPath === void 0 || change.oldPath === change.relPath) delete change.oldPath;
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
      if (c === "\\") continue;
      if (c === " ") {
        oldLine++;
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
    else if (line.startsWith("rename from ")) cur.oldPath = toPosix(unquotePath2(line.slice(12)));
    else if (line.startsWith("rename to ")) cur.relPath = toPosix(unquotePath2(line.slice(10)));
    else if (line.startsWith("--- ")) {
      const p = line.slice(4);
      if (p === "/dev/null") cur.isNewFile = true;
      else if (cur.oldPath === void 0) cur.oldPath = toPosix(stripPrefix(unquotePath2(p), "a/"));
    } else if (line.startsWith("+++ ")) {
      const p = line.slice(4);
      if (p === "/dev/null") cur.skip = true;
      else cur.relPath = toPosix(stripPrefix(unquotePath2(p), "b/"));
    }
  }
  flush();
  return out;
}
function stripCr(s) {
  return s.endsWith("\r") ? s.slice(0, -1) : s;
}
function stripPrefix(p, prefix) {
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}
function unquotePath2(p) {
  const t = p.replace(/\t$/, "");
  if (!(t.length >= 2 && t.startsWith('"') && t.endsWith('"'))) return t;
  const body = t.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const n = body[++i];
    if (n === void 0) break;
    if (/[0-7]/.test(n)) {
      const oct = body.slice(i, i + 3);
      bytes.push(parseInt(oct, 8));
      i += 2;
      continue;
    }
    const map = { n: "\n", t: "	", r: "\r", '"': '"', "\\": "\\", a: "\x07", b: "\b", f: "\f", v: "\v" };
    bytes.push(...Buffer.from(map[n] ?? n, "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}
function blameAt(repoRoot2, relPath, start, end, rev, timeoutMs = 1e4) {
  if (start < 1 || end < start) return [];
  const args = ["blame", "--porcelain", "-L", `${start},${end}`];
  if (rev) args.push(rev);
  args.push("--", relPath);
  let out;
  try {
    out = runGit(args, repoRoot2, timeoutMs);
  } catch {
    return [];
  }
  return parseBlamePorcelain(out, relPath);
}
function parseBlamePorcelain(out, relPath) {
  const meta = /* @__PURE__ */ new Map();
  const result = [];
  const lines = out.split("\n");
  let pending = null;
  let m = { author: "", date: "", summary: "", path: relPath, time: 0, tz: "+0000" };
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    const header = /^([0-9a-f]{40}) (\d+) (\d+)(?: \d+)?$/.exec(line);
    if (header) {
      pending = { sha: header[1], origLine: Number(header[2]), line: Number(header[3]) };
      const known = meta.get(pending.sha);
      m = known ? { ...known, time: 0, tz: "+0000" } : { author: "", date: "", summary: "", path: relPath, time: 0, tz: "+0000" };
      continue;
    }
    if (!pending) continue;
    if (line.startsWith("author ")) m.author = line.slice(7);
    else if (line.startsWith("author-time ")) m.time = Number(line.slice(12));
    else if (line.startsWith("author-tz ")) m.tz = line.slice(10);
    else if (line.startsWith("summary ")) m.summary = line.slice(8);
    else if (line.startsWith("filename ")) m.path = toPosix(unquotePath2(line.slice(9)));
    else if (line.startsWith("	")) {
      if (!meta.has(pending.sha)) {
        const date = m.time ? new Date(m.time * 1e3).toISOString() : "";
        meta.set(pending.sha, { author: m.author, date, summary: m.summary, path: m.path });
      }
      const info = meta.get(pending.sha);
      result.push({
        line: pending.line,
        sha: pending.sha,
        origLine: pending.origLine,
        origPath: info.path,
        author: info.author,
        date: info.date,
        summary: info.summary
      });
      pending = null;
    }
  }
  return result;
}

// src/why.ts
import { readFileSync as readFileSync7 } from "node:fs";
import { join as join6 } from "node:path";

// src/decide.ts
var MAX_LISTED = 3;
function capList(items, max = MAX_LISTED) {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}

// src/why.ts
var ZERO_SHA2 = /^0+$/;
var HISTORY_LIMIT = 10;
function explainLine(repoRoot2, relPath, line, idx) {
  const path = toPosix(relPath).replace(/^\.\//, "");
  const out = [];
  let fileLines;
  try {
    fileLines = splitLines(readFileSync7(join6(repoRoot2, path), "utf8"));
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
  const fixes = [];
  const noteFix = (c) => {
    if (!fixes.some((f) => f.sha === c.sha)) fixes.push(c);
  };
  const blame = blameAt(repoRoot2, path, line, line)[0];
  if (!blame) {
    out.push("Not tracked by git yet, so there is no history for this line.");
    return out.join("\n");
  }
  if (ZERO_SHA2.test(blame.sha)) {
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
  const history = lineHistory(repoRoot2, path, line);
  if (history.length > 0) {
    out.push(`Commits that shaped this line (newest first, up to ${HISTORY_LIMIT}):`);
    for (const c of history) {
      const fix = idx?.commits[c.sha];
      if (fix) noteFix(fix);
      out.push(`  ${short(c.sha)}  ${day(c.date)}  ${c.subject}${fix ? "   [fix]" : ""}`);
    }
    out.push("");
  }
  const norm = normalizeLine(text);
  if (idx && !isTrivial(norm)) {
    const h = hashLine(norm);
    const adders = (idx.files[path] ?? []).filter((r) => r.added.some((a) => a.hash === h)).map((r) => idx.commits[r.sha]).filter((c) => c !== void 0 && !fixes.some((f) => f.sha === c.sha));
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
    out.push(`Before removing or rewriting this line, read the fix: git show ${short(fixes[0].sha)}`);
  }
  return out.join("\n").replace(/\n+$/, "");
}
function describeFix(f, pad) {
  const lines = [`${pad}Looks like a bug fix (score ${f.score}): ${f.reasons.join("; ") || "classifier score"}`];
  if (f.refs.length) lines.push(`${pad}Refs: ${f.refs.join(", ")}`);
  if (f.testFiles.length) lines.push(`${pad}Tests: ${capList(f.testFiles)}`);
  return lines;
}
function lineHistory(repoRoot2, path, line) {
  let out;
  try {
    out = runGit(
      ["log", `-L${line},${line}:${path}`, "--format=%x1e%H%x1f%aI%x1f%an%x1f%s", "-s", "-n", String(HISTORY_LIMIT), "--no-color"],
      repoRoot2,
      15e3
    );
  } catch {
    return [];
  }
  const entries = [];
  for (const rec of out.split("")) {
    const first = rec.split("\n")[0] ?? "";
    const [sha, date, author, subject] = first.split("");
    if (sha && /^[0-9a-f]{40}$/.test(sha)) entries.push({ sha, date: date ?? "", author: author ?? "", subject: subject ?? "" });
  }
  return entries;
}
function short(sha) {
  return sha.slice(0, 7);
}
function day(iso) {
  return iso ? iso.slice(0, 10) : "unknown date";
}

// src/cli.ts
var VERSION = "0.1.0";
var DEFAULT_LOCK_WAIT_MS = 6e4;
var LOCK_POLL_MS = 250;
var HELP = `chesterton ${VERSION}
Stops Claude from quietly undoing past bug fixes.

Usage:
  chesterton index [--full] [--quiet]     Build or update the fix index for this repo
  chesterton why <file>:<line>            Explain why a line is there, from git history
  chesterton check [--staged | --base <rev>]
                                          Check a diff against past fixes. Exits 1 on strong hits.
                                          Default: uncommitted changes vs HEAD.
                                          --staged: what the next commit would record.
                                          --base <rev>: everything since the merge base with <rev>.
  chesterton status                       Show whether the index exists and is up to date
  chesterton --version
  chesterton help

Exit codes: 0 ok, 1 strong findings from check, a failed index, or a why line that does not exist,
2 usage or setup error (check also exits 2 when another index build is still running after 60 s;
set CHESTERTON_LOCK_WAIT_MS to change the wait).`;
var UsageError = class extends Error {
};
function parseArgs(argv, valueFlags) {
  const [command = "help", ...rest] = argv;
  const flags = /* @__PURE__ */ new Map();
  const positionals = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--") {
      positionals.push(...rest.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (valueFlags.has(name)) {
        const v = eq > 0 ? a.slice(eq + 1) : rest[++i];
        if (v === void 0 || v === "") throw new UsageError(`--${name} needs a value`);
        flags.set(name, v);
      } else {
        if (eq > 0) throw new UsageError(`--${name} does not take a value`);
        flags.set(name, true);
      }
      continue;
    }
    positionals.push(a);
  }
  return { command, flags, positionals };
}
function allowOnly(p, allowed, maxPositionals) {
  for (const f of p.flags.keys()) {
    if (!allowed.includes(f)) throw new UsageError(`unknown option --${f} for "${p.command}"`);
  }
  if (p.positionals.length > maxPositionals) {
    throw new UsageError(`unexpected argument "${p.positionals[maxPositionals]}" for "${p.command}"`);
  }
}
function main(argv, io = defaultIO()) {
  try {
    const first = argv[0];
    if (first === "--version" || first === "-v" || first === "version") {
      io.out(VERSION);
      return 0;
    }
    if (first === void 0 || first === "help" || first === "--help" || first === "-h") {
      io.out(HELP);
      return 0;
    }
    const parsed = parseArgs(argv, /* @__PURE__ */ new Set(["base"]));
    switch (parsed.command) {
      case "index":
        allowOnly(parsed, ["full", "quiet"], 0);
        return cmdIndex(io, parsed.flags.has("full"), parsed.flags.has("quiet"));
      case "why":
        allowOnly(parsed, [], 2);
        return cmdWhy(io, parsed.positionals);
      case "check": {
        allowOnly(parsed, ["staged", "base"], 0);
        const base = parsed.flags.get("base");
        if (parsed.flags.has("staged") && base) throw new UsageError("use either --staged or --base, not both");
        return cmdCheck(io, { staged: parsed.flags.has("staged"), base: typeof base === "string" ? base : void 0 });
      }
      case "status":
        allowOnly(parsed, [], 0);
        return cmdStatus(io);
      default:
        throw new UsageError(`unknown command "${parsed.command}"`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`chesterton: ${e.message}
Run "chesterton help" for usage.`);
      return 2;
    }
    io.err(`chesterton: ${e.message ?? String(e)}`);
    return 2;
  }
}
function needRepo(io) {
  const root = repoRoot(io.cwd);
  if (!root) io.err("chesterton: not inside a git repository.");
  return root;
}
function cmdIndex(io, full, quiet) {
  const root = repoRoot(io.cwd);
  if (!root) {
    if (!quiet) io.err("chesterton: not inside a git repository.");
    return 2;
  }
  const started = Date.now();
  try {
    const cfg = loadConfig(root);
    const { index: idx, outcome } = buildIndexDetailed(root, cfg, { full });
    if (!quiet) {
      const secs = ((Date.now() - started) / 1e3).toFixed(1);
      if (outcome === "busy") io.out("Another index build is running. It will save the index when it finishes.");
      else if (outcome === "no-commits") io.out("No commits yet, nothing to index.");
      else
        io.out(
          `Indexed ${plural(Object.keys(idx.commits).length, "fix commit")} across ${plural(Object.keys(idx.files).length, "file")} at ${idx.head.slice(0, 7)} in ${secs}s.`
        );
    }
    return 0;
  } catch (e) {
    if (!quiet) io.err(`chesterton: index failed: ${e.message}`);
    return 1;
  }
}
function parseFileLine(args) {
  if (args.length === 0) throw new UsageError("why needs <file>:<line>, for example: chesterton why src/net/socket.ts:42");
  let file;
  let lineText;
  if (args.length === 2) {
    file = args[0];
    lineText = args[1];
  } else {
    const a = args[0];
    const m = /^(.*?):(\d+)(?::\d+)?$/.exec(a);
    if (!m) throw new UsageError(`expected <file>:<line>, got "${a}"`);
    file = m[1];
    lineText = m[2];
  }
  const line = Number(lineText);
  if (!file || !/^\d+$/.test(lineText) || line < 1) throw new UsageError(`"${lineText}" is not a line number`);
  return { file, line };
}
function toRepoPath(root, cwd, file) {
  const abs = isAbsolute3(file) ? file : resolve3(cwd, file);
  let rootReal = root;
  let absReal = abs;
  try {
    rootReal = realpathSync(root);
  } catch {
  }
  try {
    absReal = realpathSync(abs);
  } catch {
  }
  const rel = relative(rootReal, absReal);
  if (rel.startsWith("..") || isAbsolute3(rel)) return null;
  return toPosix(rel);
}
function cmdWhy(io, args) {
  const { file, line } = parseFileLine(args);
  const root = needRepo(io);
  if (!root) return 2;
  const rel = toRepoPath(root, io.cwd, file);
  if (rel === null) {
    io.err(`chesterton: ${file} is outside this repository (${root}).`);
    return 2;
  }
  const problem = whyProblem(root, rel, line);
  if (problem) {
    io.err(`chesterton: ${problem}`);
    return 1;
  }
  io.out(explainLine(root, rel, line, loadIndex(root)));
  return 0;
}
function whyProblem(root, rel, line) {
  const full = resolve3(root, rel);
  let st;
  try {
    st = statSync3(full);
  } catch {
    return `${rel}: file not found in the working tree.`;
  }
  if (st.isDirectory()) return `${rel} is a directory, not a file.`;
  let count;
  try {
    count = splitLines(readFileSync8(full, "utf8")).length;
  } catch (e) {
    return `${rel}: cannot read the file (${e.message}).`;
  }
  if (line > count) return `${rel}:${line}: no such line (the file has ${plural(count, "line")}).`;
  return null;
}
function sleepMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {
    }
  }
}
function lockWaitMs(io) {
  if (typeof io.lockWaitMs === "number" && io.lockWaitMs >= 0) return io.lockWaitMs;
  const env = Number(process.env.CHESTERTON_LOCK_WAIT_MS);
  return Number.isFinite(env) && env >= 0 ? env : DEFAULT_LOCK_WAIT_MS;
}
function freshIndexForCheck(io, root, cfg) {
  let idx = loadIndex(root);
  if (isIndexFresh(root, idx)) return idx;
  io.err(idx ? "chesterton: index is out of date, updating it first." : "chesterton: no index yet, building it first.");
  const waitMs = lockWaitMs(io);
  const until = Date.now() + waitMs;
  let said = false;
  for (; ; ) {
    let res;
    try {
      res = buildIndexDetailed(root, cfg);
    } catch (e) {
      io.err(`chesterton: index failed: ${e.message}`);
      return null;
    }
    if (res.outcome !== "busy") return res.index;
    idx = loadIndex(root);
    if (isIndexFresh(root, idx)) return idx;
    if (Date.now() >= until) break;
    if (!said) {
      io.err("chesterton: another index build is running, waiting for it to finish.");
      said = true;
    }
    do
      sleepMs(Math.max(0, Math.min(LOCK_POLL_MS, until - Date.now())));
    while (Date.now() < until && isLockHeld(root));
  }
  io.err(
    `chesterton: another index build is still running after ${Math.round(waitMs / 1e3)}s, so the diff was not checked. Run check again when it finishes, or set CHESTERTON_LOCK_WAIT_MS to wait longer.`
  );
  return null;
}
function cmdCheck(io, range) {
  const root = needRepo(io);
  if (!root) return 2;
  const cfg = loadConfig(root);
  let diff;
  try {
    diff = gitDiffChanges(root, { staged: range.staged, base: range.base });
  } catch (e) {
    io.err(`chesterton: could not read the diff: ${e.message}`);
    return 2;
  }
  if (diff.changes.length === 0) {
    io.out("Nothing to check.");
    return 0;
  }
  const idx = freshIndexForCheck(io, root, cfg);
  if (!idx) return 2;
  const head = headSha2(root);
  const findings = [];
  for (const change of diff.changes) {
    const prePath = change.oldPath ?? change.relPath;
    const indexPath = diff.preImage === head ? prePath : change.relPath;
    const pre = change.isNewFile ? null : showFile(root, diff.preImage, prePath);
    findings.push(
      ...analyzeChange(
        root,
        { relPath: indexPath, removed: change.removed, added: change.added, isNewFile: change.isNewFile },
        idx,
        cfg,
        {
          // Removed lines are numbered in the pre-image and are gone from the working tree,
          // so blame the pre-image revision instead of the working tree.
          blame: (r, _p, s, e, t) => blameAt(r, prePath, s, e, diff.preImage, t),
          currentContent: pre
        }
      ).map((f) => ({ ...f, file: change.relPath }))
    );
  }
  const strong = findings.filter((f) => f.strength === "strong");
  const weak = findings.filter((f) => f.strength === "weak");
  if (findings.length === 0) {
    io.out(`Checked ${plural(diff.changes.length, "file")}. No past fixes touched.`);
    return 0;
  }
  for (const f of [...strong, ...weak]) io.out(formatFinding(f));
  io.out(
    `${plural(strong.length, "strong finding")}, ${plural(weak.length, "weak finding")} in ${plural(diff.changes.length, "changed file")}.`
  );
  return strong.length > 0 ? 1 : 0;
}
function formatFinding(f) {
  const what = f.kind === "removes-fix" ? "removes lines added by a bug fix" : "puts back lines a bug fix removed";
  const c = f.fix;
  const out = [
    `${f.strength.toUpperCase()}  ${f.file}: ${what}`,
    `  ${c.sha.slice(0, 7)}  ${c.date.slice(0, 10)}  ${c.author}  ${c.subject}`
  ];
  if (c.reasons.length) out.push(`  Why it looks like a fix: ${c.reasons.join("; ")}`);
  if (c.refs.length) out.push(`  Refs: ${c.refs.join(", ")}`);
  if (c.testFiles.length) out.push(`  Tests: ${capList(c.testFiles)}`);
  if (f.lines.length) {
    out.push("  Lines:");
    for (const l of f.lines) out.push(`    ${l}`);
  }
  out.push(`  Read it with: git show ${c.sha.slice(0, 7)}`);
  out.push("");
  return out.join("\n");
}
function cmdStatus(io) {
  const root = needRepo(io);
  if (!root) return 2;
  const head = headSha2(root);
  const { config, warnings, found } = loadConfigWithWarnings(root);
  const idx = loadIndex(root);
  const lines = [`Repo:        ${root}`, `HEAD:        ${head ? head.slice(0, 7) : "(no commits)"}`];
  let dir = "";
  try {
    dir = indexDir(root);
  } catch {
  }
  if (!idx) {
    lines.push(`Index:       not built yet${dir ? ` (${toPosix(dir)})` : ""}. Run "chesterton index".`);
  } else {
    const fresh = head !== null && idx.head === head;
    lines.push(`Index:       ${toPosix(dir)}`);
    lines.push(`Built at:    ${idx.builtAt} (HEAD ${idx.head.slice(0, 7) || "none"})`);
    lines.push(`Up to date:  ${fresh ? "yes" : 'no, HEAD has moved. Run "chesterton index".'}`);
    lines.push(`Fix commits: ${Object.keys(idx.commits).length}`);
    lines.push(`Files:       ${Object.keys(idx.files).length}`);
  }
  lines.push(`Config:      ${found ? ".chesterton.yml" : "defaults (no .chesterton.yml)"}, mode ${config.mode}, history ${config.history}`);
  for (const w of warnings) lines.push(`  warning: ${w}`);
  io.out(lines.join("\n"));
  return 0;
}
function headSha2(root) {
  try {
    return runGit(["rev-parse", "--verify", "--quiet", "HEAD"], root, 5e3).trim() || null;
  } catch {
    return null;
  }
}
function showFile(root, rev, path) {
  try {
    return runGit(["show", `${rev}:${path}`], root, 1e4);
  } catch {
    return null;
  }
}
function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
function defaultIO() {
  return {
    out: (t) => process.stdout.write(t.endsWith("\n") ? t : `${t}
`),
    err: (t) => process.stderr.write(t.endsWith("\n") ? t : `${t}
`),
    cwd: process.cwd()
  };
}
function isEntryPoint() {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isEntryPoint()) {
  process.exitCode = main(process.argv.slice(2));
}
export {
  VERSION,
  formatFinding,
  main,
  parseFileLine
};
