// src/hook.ts
import { spawn } from "node:child_process";
import { createHash as createHash3 } from "node:crypto";
import { appendFileSync, existsSync as existsSync3, readFileSync as readFileSync8, realpathSync as realpathSync3, statSync as statSync4 } from "node:fs";
import { dirname as dirname3, isAbsolute as isAbsolute3, join as join8, resolve as resolve4 } from "node:path";
import { fileURLToPath } from "node:url";

// src/types.ts
var FIX_THRESHOLD = 3;
var INDEX_VERSION = 3;

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

// src/git.ts
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
var GitError = class extends Error {
};
var resolved = null;
function gitExecutable() {
  if (process.platform !== "win32") return "git";
  const path = process.env.PATH ?? "";
  if (resolved && resolved.path === path) return resolved.git;
  let git = null;
  for (const raw of path.split(";")) {
    const dir = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || !isAbsolute(dir)) continue;
    const hit = [".exe", ".com"].map((ext) => join(dir, `git${ext}`)).find(isFile);
    if (hit) {
      git = hit;
      break;
    }
  }
  resolved = { path, git };
  return git;
}
function gitOrThrow() {
  const git = gitExecutable();
  if (!git) throw new GitError("git was not found on PATH");
  return git;
}
function runGit(args, cwd, timeoutMs = 1e4) {
  const res = spawnSync(gitOrThrow(), ["-c", "core.quotepath=off", ...args], {
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
var GIT_DISCOVERY_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM"];
var NeedGit = class extends Error {
};
function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
function readGitFile(dotGit) {
  const text = readFileSync(dotGit, "utf8");
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!m) throw new NeedGit("not a gitdir file");
  const target = m[1];
  return isAbsolute(target) ? resolve(target) : resolve(dirname(dotGit), target);
}
function hasUnusualConfig(gitDir) {
  const files = [join(gitDir, "config")];
  try {
    const common = readFileSync(join(gitDir, "commondir"), "utf8").trim();
    if (common) files.push(join(isAbsolute(common) ? common : resolve(gitDir, common), "config"));
  } catch {
  }
  for (const f of files) {
    let text;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    if (/^\s*worktree\s*=/im.test(text) || /^\s*bare\s*=\s*true\s*$/im.test(text)) return true;
  }
  return false;
}
function gitStylePath(p) {
  let r = p;
  try {
    r = realpathSync.native(p);
  } catch {
  }
  return process.platform === "win32" ? r.replace(/\\/g, "/") : r;
}
function findRepoInJs(cwd) {
  for (const v of GIT_DISCOVERY_ENV) if (process.env[v]) throw new NeedGit(`${v} is set`);
  let dir = resolve(cwd);
  for (; ; ) {
    const dotGit = join(dir, ".git");
    let gitDir = null;
    if (isDir(dotGit)) {
      if (!existsSync(join(dotGit, "HEAD"))) throw new NeedGit("no HEAD in .git");
      gitDir = dotGit;
    } else if (isFile(dotGit)) {
      gitDir = readGitFile(dotGit);
      if (!existsSync(join(gitDir, "HEAD"))) throw new NeedGit("gitdir file points nowhere");
    }
    if (gitDir) {
      if (hasUnusualConfig(gitDir)) throw new NeedGit("unusual config");
      return { root: gitStylePath(dir), gitDir };
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}
function findRepoWithGit(cwd) {
  try {
    const out = runGit(["rev-parse", "--show-toplevel", "--absolute-git-dir"], cwd, 5e3).split(/\r?\n/);
    const root = out[0]?.trim();
    const gitDir = out[1]?.trim();
    if (!root || !gitDir) return null;
    return { root, gitDir: isAbsolute(gitDir) ? gitDir : resolve(root, gitDir) };
  } catch {
    return null;
  }
}
function locateRepo(cwd) {
  try {
    return findRepoInJs(cwd);
  } catch {
    return findRepoWithGit(cwd);
  }
}
function repoRoot(cwd) {
  return locateRepo(cwd)?.root ?? null;
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
function dirtyFiles(cwd, timeoutMs = 5e3) {
  const out = runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], cwd, timeoutMs);
  const parts = out.split("\0");
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (/[RC]/.test(xy)) i++;
    if (xy === "!!" || path.endsWith("/")) continue;
    files.push(path);
  }
  return files;
}

// src/config.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
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
function hasNestedRepeat(src) {
  const stack = [false];
  const repeatAt = (i) => {
    const c = src[i];
    if (c === "*" || c === "+") return true;
    const m = c === "{" ? /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i)) : null;
    if (!m) return false;
    const max = m[2] === void 0 ? Number(m[1]) : m[3] === "" ? Infinity : Number(m[3]);
    return max > 1;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
    } else if (c === "[") {
      for (i++; i < src.length && src[i] !== "]"; i++) if (src[i] === "\\") i++;
    } else if (c === "(") {
      stack.push(false);
    } else if (c === ")") {
      const inner = stack.length > 1 ? stack.pop() : false;
      const repeated = repeatAt(i + 1);
      if (inner && repeated) return true;
      stack[stack.length - 1] = stack[stack.length - 1] || inner || repeated;
    } else if (repeatAt(i)) {
      stack[stack.length - 1] = true;
    }
  }
  return false;
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
          } catch {
            warnings.push(`fix_patterns_extra: "${src}" is not a valid regex, skipped`);
            continue;
          }
          if (hasNestedRepeat(src)) {
            warnings.push(`fix_patterns_extra: "${src}" repeats a group that already repeats, which can take forever to match, skipped`);
            continue;
          }
          cfg.fixPatternsExtra.push(src);
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
    text = readFileSync2(join2(repoRoot2, CONFIG_FILE), "utf8");
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

// src/index-store.ts
import { existsSync as existsSync2, mkdirSync, readdirSync, readFileSync as readFileSync3, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join as join3 } from "node:path";
var INDEX_FILE = "meta.json";
var SHARD_DIR = "shards";
var ID_RE = /^[0-9a-z-]{1,64}$/;
var SHARD_RE = /^[0-9a-f]{32}$/;
var dirCache = /* @__PURE__ */ new Map();
function indexDir(repoRoot2) {
  const cached = dirCache.get(repoRoot2);
  if (cached && existsSync2(cached)) return cached;
  const loc = locateRepo(repoRoot2);
  if (!loc) throw new GitError(`not a git repository: ${repoRoot2}`);
  const dir = join3(loc.gitDir, "chesterton");
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
function isValidCommitMap(x) {
  if (!isObj(x)) return false;
  for (const c of Object.values(x)) if (!isValidCommit(c)) return false;
  return true;
}
function isValidMeta(x) {
  return isObj(x) && x.version === INDEX_VERSION && typeof x.id === "string" && ID_RE.test(x.id) && typeof x.head === "string" && typeof x.builtAt === "string" && typeof x.fixCommits === "number" && typeof x.files === "number";
}
function isValidManifest(x, id) {
  if (!isObj(x) || x.version !== INDEX_VERSION || x.id !== id || !isObj(x.files)) return false;
  for (const v of Object.values(x.files)) if (typeof v !== "string" || !SHARD_RE.test(v)) return false;
  return true;
}
function isValidShard(x, path) {
  return isObj(x) && x.version === INDEX_VERSION && x.path === path && Array.isArray(x.records) && x.records.every(isValidRecord) && isValidCommitMap(x.commits);
}
var readJson = (file) => JSON.parse(readFileSync3(file, "utf8"));
function loadMeta(repoRoot2) {
  try {
    const meta = readJson(join3(indexDir(repoRoot2), INDEX_FILE));
    return isValidMeta(meta) ? meta : null;
  } catch {
    return null;
  }
}
function loadManifest(dir, meta) {
  const m = readJson(join3(dir, `manifest-${meta.id}.json`));
  return isValidManifest(m, meta.id) ? m : null;
}
function loadShard(dir, name, path) {
  const file = join3(dir, SHARD_DIR, `${name}.json`);
  let text;
  try {
    text = readFileSync3(file, "utf8");
  } catch {
    return null;
  }
  let s = null;
  try {
    s = JSON.parse(text);
  } catch {
  }
  if (isValidShard(s, path)) return s;
  try {
    unlinkSync(file);
  } catch {
  }
  return null;
}
function loadCommits(dir, meta) {
  const c = readJson(join3(dir, `commits-${meta.id}.json`));
  if (!isObj(c) || c.version !== INDEX_VERSION || c.id !== meta.id || !isValidCommitMap(c.commits)) return null;
  return c.commits;
}
function loadIndexForFiles(repoRoot2, relPaths, opts = {}) {
  try {
    const dir = indexDir(repoRoot2);
    const meta = loadMeta(repoRoot2);
    if (!meta) return null;
    const manifest = loadManifest(dir, meta);
    if (!manifest) return null;
    const commits = {};
    const files = /* @__PURE__ */ Object.create(null);
    for (const p of relPaths) {
      const key = normKey(p);
      if (Object.prototype.hasOwnProperty.call(files, key)) continue;
      const name = Object.prototype.hasOwnProperty.call(manifest.files, key) ? manifest.files[key] : void 0;
      if (!name) continue;
      const shard = loadShard(dir, name, key);
      if (!shard) return null;
      files[key] = shard.records;
      Object.assign(commits, shard.commits);
    }
    if (opts.allCommits) {
      const all = loadCommits(dir, meta);
      if (!all) return null;
      Object.assign(commits, all);
    }
    return { version: INDEX_VERSION, head: meta.head, builtAt: meta.builtAt, commits, files };
  } catch {
    return null;
  }
}
function normKey(relPath) {
  return toPosix(relPath).replace(/^(\.\/)+/, "");
}
function recordsForFile(idx, relPath) {
  const key = normKey(relPath);
  return Object.prototype.hasOwnProperty.call(idx.files, key) ? idx.files[key] : [];
}

// src/blame.ts
import { readFileSync as readFileSync4, statSync as statSync2 } from "node:fs";
import { join as join4 } from "node:path";

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

// src/index-builder.ts
var STALE_LOCK_MS = 5 * 6e4;
var MAX_LIVE_LOCK_MS = 30 * 6e4;
var DEFAULT_TIMEOUT_MS = 5 * 6e4;
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

// src/blame.ts
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
    const lineCount = splitLines(readFileSync4(full, "utf8")).length;
    const s = Math.max(1, Math.floor(start));
    const e = Math.min(lineCount, Math.floor(end));
    if (lineCount === 0 || s > e) return [];
    const out = runGit(["blame", "--porcelain", "-L", `${s},${e}`, "--", rel], repoRoot2, timeoutMs);
    return parsePorcelain(out);
  } catch {
    return [];
  }
}

// src/edit-diff.ts
import { lstatSync, readdirSync as readdirSync2, readFileSync as readFileSync5, realpathSync as realpathSync2, statSync as statSync3 } from "node:fs";
import { basename as basename2, dirname as dirname2, isAbsolute as isAbsolute2, join as join5, relative, resolve as resolve2 } from "node:path";
var MAX_FILE_BYTES = 5 * 1024 * 1024;
var MAX_EDIT_DISTANCE = 2e3;
function diffLines(before, after) {
  let pre = 0;
  while (pre < before.length && pre < after.length && before[pre] === after[pre]) pre++;
  let suf = 0;
  while (suf < before.length - pre && suf < after.length - pre && before[before.length - 1 - suf] === after[after.length - 1 - suf]) {
    suf++;
  }
  const a = before.slice(pre, before.length - suf);
  const b = after.slice(pre, after.length - suf);
  const removed = [];
  const added = [];
  if (a.length === 0 && b.length === 0) return { removed, added };
  const script = myers(a, b, MAX_EDIT_DISTANCE);
  if (!script) {
    a.forEach((text, i) => removed.push({ line: pre + i + 1, text }));
    added.push(...b);
    return { removed, added };
  }
  for (const op of script) {
    if (op.t === "del") removed.push({ line: pre + op.i + 1, text: a[op.i] });
    else if (op.t === "ins") added.push(b[op.j]);
  }
  return { removed, added };
}
function myers(a, b, maxD) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  v[off + 1] = 0;
  const trace = [];
  let found = -1;
  const limit = Math.min(max, maxD);
  outer: for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x2;
      if (k === -d || k !== d && v[off + k - 1] < v[off + k + 1]) x2 = v[off + k + 1];
      else x2 = v[off + k - 1] + 1;
      let y2 = x2 - k;
      while (x2 < n && y2 < m && a[x2] === b[y2]) {
        x2++;
        y2++;
      }
      v[off + k] = x2;
      if (x2 >= n && y2 >= m) {
        found = d;
        break outer;
      }
    }
  }
  if (found < 0) return null;
  const ops = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const snap = trace[d];
    const get = (k2) => snap[k2 + d + 1];
    const k = x - y;
    let prevK;
    if (k === -d || k !== d && get(k - 1) < get(k + 1)) prevK = k + 1;
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
function toolPathToNative(p) {
  if (process.platform === "win32") {
    const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
    if (m) return `${m[1]}:${m[2] ?? "/"}`;
  }
  return p;
}
function realOr(p) {
  try {
    return realpathSync2.native(p);
  } catch {
    return p;
  }
}
function realPathOf(abs) {
  try {
    if (!lstatSync(abs).isSymbolicLink()) return realpathSync2.native(abs);
    return join5(realOr(dirname2(abs)), basename2(abs));
  } catch {
  }
  const rest = [];
  let cur = abs;
  for (; ; ) {
    const up = dirname2(cur);
    rest.unshift(basename2(cur));
    if (up === cur) return abs;
    cur = up;
    try {
      return join5(realpathSync2.native(cur), ...rest);
    } catch {
    }
  }
}
function trueCase(rootReal, rel) {
  if (process.platform !== "darwin") return rel;
  const parts = rel.split(/[\\/]/);
  let dir = rootReal;
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    let name = part;
    try {
      const names = readdirSync2(dir);
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
    dir = join5(dir, name);
  }
  return out.join("/");
}
function resolveRepoPath(repoRoot2, filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") return null;
  const p = toolPathToNative(filePath.trim());
  const rootReal = realOr(resolve2(repoRoot2));
  const abs = realPathOf(isAbsolute2(p) ? resolve2(p) : resolve2(repoRoot2, p));
  let rel = relative(rootReal, abs);
  if (rel === "" || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute2(rel)) return null;
  rel = trueCase(rootReal, rel);
  const posix = toPosix(rel);
  if (posix === ".git" || posix.startsWith(".git/")) return null;
  return { abs, rel: posix };
}
function readText(abs) {
  let st;
  try {
    st = statSync3(abs);
  } catch {
    return void 0;
  }
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
  try {
    const text = readFileSync5(abs, "utf8");
    if (text.includes("\0")) return null;
    return text;
  } catch {
    return null;
  }
}
function asEdit(x) {
  if (!x || typeof x !== "object") return null;
  const o = x;
  if (typeof o.old_string !== "string" || typeof o.new_string !== "string") return null;
  return { old_string: o.old_string, new_string: o.new_string, replace_all: o.replace_all === true };
}
function applyEdit(content, e) {
  if (e.old_string === "") return null;
  const candidates = [[e.old_string, e.new_string]];
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
function applyEolInsensitive(content, e) {
  const oldN = e.old_string.replace(/\r\n/g, "\n");
  if (oldN === "") return null;
  const map = [];
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
  const starts = [];
  let from = 0;
  for (; ; ) {
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
    const start = map[s];
    const end = map[s + oldN.length];
    out += content.slice(last, start) + e.new_string;
    last = end;
  }
  return out + content.slice(last);
}
function changeFromToolCall(repoRoot2, toolName, toolInput) {
  if (!toolInput || typeof toolInput !== "object") return [];
  const input = toolInput;
  const filePath = input.file_path;
  if (typeof filePath !== "string") return [];
  const target = resolveRepoPath(repoRoot2, filePath);
  if (!target) return [];
  const current = readText(target.abs);
  if (current === null) return [];
  const exists = current !== void 0;
  let next = null;
  if (toolName === "Write") {
    if (typeof input.content !== "string") return [];
    next = input.content;
  } else if (toolName === "Edit") {
    const e = asEdit(input);
    if (!e) return [];
    if (!exists) {
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

// src/analyze.ts
import { readFileSync as readFileSync6 } from "node:fs";
import { join as join6 } from "node:path";
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
    return readFileSync6(join6(repoRoot2, relPath), "utf8");
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
  const survivors = survivingLines(removed, change.added);
  if (!deps.alwaysBlame) {
    if (records.length === 0) return [];
    const addedHashes = /* @__PURE__ */ new Set();
    for (const rec of records) for (const e of rec.added) addedHashes.add(e.hash);
    if (!removed.some((r) => !survivors.has(r.line) && addedHashes.has(hashLine(r.norm)))) return [];
  }
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
      const strong = !survivors.has(r.line) && recs.some((rec) => rec.added.some((e) => e.hash === hash));
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
function survivingLines(removed, added) {
  const counts = /* @__PURE__ */ new Map();
  for (const a of added) {
    const n = normalizeLine(a);
    if (!isTrivial(n)) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const out = /* @__PURE__ */ new Set();
  for (const r of removed) {
    const left = counts.get(r.norm) ?? 0;
    if (left > 0) {
      counts.set(r.norm, left - 1);
      out.add(r.line);
    }
  }
  return out;
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

// src/decide.ts
var MAX_LOGGED = 500;
function tokenizeGlob(glob) {
  let g = glob.trim().replace(/\\/g, "/");
  if (g.startsWith("./")) g = g.slice(2);
  if (g.startsWith("/")) g = g.slice(1);
  if (g.endsWith("/")) g += "**";
  if (!g.includes("/")) g = `**/${g}`;
  const out = [];
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        const slashAfter = g[i + 2] === "/";
        i += slashAfter ? 2 : 1;
        const t = slashAfter ? "DIRS" : "ANY";
        if (!(t === "DIRS" && out[out.length - 1]?.t === "DIRS")) out.push({ t });
      } else {
        out.push({ t: "STAR" });
      }
    } else if (c === "?") {
      out.push({ t: "ONE" });
    } else {
      out.push({ t: "LIT", c });
    }
  }
  return out;
}
function globMatches(tokens, s) {
  const n = s.length;
  let next = new Uint8Array(n + 1);
  next[n] = 1;
  for (let ti = tokens.length - 1; ti >= 0; ti--) {
    const tok = tokens[ti];
    const cur = new Uint8Array(n + 1);
    let slashAhead = 0;
    for (let i = n; i >= 0; i--) {
      const ch = i < n ? s[i] : "";
      let ok = 0;
      if (tok.t === "LIT") ok = i < n && ch === tok.c ? next[i + 1] : 0;
      else if (tok.t === "ONE") ok = i < n && ch !== "/" ? next[i + 1] : 0;
      else if (tok.t === "STAR") ok = next[i] || (i < n && ch !== "/" ? cur[i + 1] : 0);
      else if (tok.t === "ANY") ok = next[i] || (i < n ? cur[i + 1] : 0);
      else {
        if (i < n && ch === "/" && next[i + 1]) slashAhead = 1;
        ok = next[i] || slashAhead;
      }
      cur[i] = ok ? 1 : 0;
    }
    next = cur;
  }
  return next[0] === 1;
}
function matchGlob(relPath, glob) {
  if (!glob.trim()) return false;
  try {
    if (globMatches(tokenizeGlob(glob), relPath)) return true;
    return !/[*?]/.test(glob) && relPath.startsWith(glob.replace(/\\/g, "/").replace(/\/+$/, "") + "/");
  } catch {
    return false;
  }
}
function isProtected(relPath, cfg) {
  return cfg.protect.some((g) => matchGlob(relPath, g));
}
function short(sha) {
  return sha.slice(0, 7);
}
function fixHeader(fix) {
  const date = fix.date ? fix.date.slice(0, 10) : "unknown date";
  const who = fix.author ? `, ${fix.author}` : "";
  return `Fix: ${short(fix.sha)} (${date}${who}) "${fix.subject}"`;
}
var MAX_LISTED = 3;
function capList(items, max = MAX_LISTED) {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}
function whyLine(fix) {
  const parts = [...fix.reasons];
  const joined = parts.join(" ").toLowerCase();
  const refs = fix.refs.filter((r) => !joined.includes(r.toLowerCase()));
  if (refs.length > 0) parts.push(`references ${capList(refs)}`);
  if (!/\btests?\b/.test(joined) && fix.testFiles.length > 0) parts.push(`touches test ${capList(fix.testFiles)}`);
  return parts.length > 0 ? `Why it looks like a fix: ${parts.join("; ")}` : "";
}
function groupByFix(findings) {
  const groups = /* @__PURE__ */ new Map();
  for (const f of findings) {
    let g = groups.get(f.fix.sha);
    if (!g) {
      g = { fix: f.fix, strong: false, removes: [], readds: [] };
      groups.set(f.fix.sha, g);
    }
    if (f.strength === "strong") g.strong = true;
    const into = f.kind === "removes-fix" ? g.removes : g.readds;
    for (const l of f.lines) if (!into.includes(l)) into.push(l);
  }
  return [...groups.values()];
}
function indented(lines) {
  return lines.map((l) => `  ${l}`).join("\n");
}
function linesBlock(g) {
  if (g.removes.length > 0 && g.readds.length > 0) {
    return `Lines it removes:
${indented(g.removes)}
Lines it adds back:
${indented(g.readds)}`;
  }
  const lines = [...g.removes, ...g.readds];
  return lines.length > 0 ? `Lines:
${indented(lines)}` : "";
}
function groupBlock(g) {
  return [fixHeader(g.fix), whyLine(g.fix), linesBlock(g)].filter(Boolean).join("\n");
}
function verb(g) {
  const sha = short(g.fix.sha);
  const removes = g.removes.length > 0;
  const readds = g.readds.length > 0;
  if (removes && readds) return `removes code that fix ${sha} added and adds back code it removed`;
  return readds ? `adds back code that fix ${sha} removed` : `removes code that fix ${sha} added`;
}
function headline(groups, relPath, withList) {
  if (groups.length === 1) return `Chesterton: this edit to ${relPath} ${verb(groups[0])}.`;
  const list = withList ? ` (${groups.map(verb).join("; ")})` : "";
  return `Chesterton: this edit to ${relPath} touches ${groups.length} past bug fixes${list}.`;
}
function denyReason(strong, relPath) {
  const groups = groupByFix(strong);
  const blocks = groups.map(groupBlock).join("\n\n");
  const show = groups.map((g) => `git show ${short(g.fix.sha)}`).join(", ");
  const anyReadd = groups.some((g) => g.readds.length > 0);
  const anyRemove = groups.some((g) => g.removes.length > 0);
  const what = anyRemove && anyReadd ? "changing this" : anyRemove ? "removing this" : "adding this back";
  const tail = `Before ${what}, check the fix commit${groups.length === 1 ? "" : "s"} (${show}). Keep the fix, or rework the change around it. If you are sure it is safe, tell the user why, then retry the same edit and Chesterton will let it through.`;
  return `${headline(groups, relPath, true)}

${blocks}

${tail}`;
}
function askReason(strong, relPath, prot) {
  const groups = groupByFix(strong);
  const why = prot ? `${relPath} is a protected path, so a person has to approve this.` : `Chesterton is set to ask before edits like this.`;
  return `${headline(groups, relPath, false)} ${why}

${groups.map(groupBlock).join("\n\n")}`;
}
function contextText(findings, relPath, note) {
  const intro = note ?? `Chesterton: heads up, this edit to ${relPath} may touch code from a past bug fix. It was allowed; check it still holds.`;
  const items = groupByFix(findings).map(
    (g) => `- ${g.strong ? "" : "possibly "}${verb(g)}
  ${groupBlock(g).replace(/\n/g, "\n  ")}`
  );
  return `${intro}
${items.join("\n")}`;
}
function output(fields) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...fields } });
}
function log(session, f, relPath, decision) {
  session.findings.push({
    at: (/* @__PURE__ */ new Date()).toISOString(),
    key: `${relPath}@${f.fix.sha}`,
    kind: f.kind,
    strength: f.strength,
    file: relPath,
    sha: f.fix.sha,
    decision
  });
  if (session.findings.length > MAX_LOGGED) session.findings.splice(0, session.findings.length - MAX_LOGGED);
}
function decidePreToolUse(findings, session, cfg, relPath) {
  if (findings.length === 0) return { stdout: null };
  const strong = findings.filter((f) => f.strength === "strong");
  const weak = findings.filter((f) => f.strength !== "strong");
  const prot = isProtected(relPath, cfg);
  if (strong.length === 0) {
    for (const f of weak) log(session, f, relPath, "context");
    return { stdout: output({ additionalContext: contextText(weak, relPath) }) };
  }
  if (prot || cfg.mode === "ask") {
    for (const f of findings) log(session, f, relPath, f.strength === "strong" ? "ask" : "context");
    const out = { permissionDecision: "ask", permissionDecisionReason: askReason(strong, relPath, prot) };
    if (weak.length > 0) out.additionalContext = contextText(weak, relPath);
    return { stdout: output(out) };
  }
  if (cfg.mode === "warn-only") {
    for (const f of findings) log(session, f, relPath, "warn");
    return { stdout: output({ additionalContext: contextText(findings, relPath) }) };
  }
  const keyOf = (f) => `${relPath}@${f.fix.sha}`;
  const acked = new Set(session.acknowledged);
  const fresh = strong.filter((f) => !acked.has(keyOf(f)));
  if (fresh.length === 0) {
    for (const f of strong) log(session, f, relPath, "acknowledged");
    for (const f of weak) log(session, f, relPath, "context");
    const note = `Chesterton: allowed this edit to ${relPath} because the past fix below was already flagged this session. Make sure you told the user why changing it is safe.`;
    return { stdout: output({ additionalContext: contextText(findings, relPath, note) }) };
  }
  for (const f of fresh) {
    const k = keyOf(f);
    if (!acked.has(k)) {
      acked.add(k);
      session.acknowledged.push(k);
    }
    log(session, f, relPath, "deny");
  }
  for (const f of strong) if (!fresh.includes(f)) log(session, f, relPath, "acknowledged");
  for (const f of weak) log(session, f, relPath, "context");
  return { stdout: output({ permissionDecision: "deny", permissionDecisionReason: denyReason(strong, relPath) }) };
}

// src/session.ts
import { createHash as createHash2 } from "node:crypto";
import { mkdirSync as mkdirSync2, readFileSync as readFileSync7, renameSync as renameSync2, unlinkSync as unlinkSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { tmpdir } from "node:os";
import { join as join7, resolve as resolve3 } from "node:path";
var SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/;
var HASHED_TAIL = /\.h[0-9a-f]{12}$/;
function sanitizeSessionId(id) {
  const raw = String(id ?? "");
  if (raw === "") return "default";
  if (SAFE_ID.test(raw) && !HASHED_TAIL.test(raw)) return raw;
  const prefix = raw.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 100);
  const hash = createHash2("sha1").update(raw, "utf8").digest("hex").slice(0, 12);
  return `${prefix}.h${hash}`;
}
function sessionPath(repoRoot2, sessionId) {
  return join7(indexDir(repoRoot2), "sessions", `${sanitizeSessionId(sessionId)}.json`);
}
function fallbackSessionPath(repoRoot2, sessionId) {
  const key = createHash2("sha1").update(resolve3(repoRoot2), "utf8").digest("hex").slice(0, 16);
  return join7(tmpdir(), "chesterton-sessions", key, `${sanitizeSessionId(sessionId)}.json`);
}
function strings(x) {
  return Array.isArray(x) ? x.filter((v) => typeof v === "string") : [];
}
function readSessionFile(file) {
  try {
    const raw = JSON.parse(readFileSync7(file, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    const findings = Array.isArray(raw.findings) ? raw.findings.filter((f) => f && typeof f === "object" && typeof f.key === "string") : [];
    return { acknowledged: strings(raw.acknowledged), findings, files: strings(raw.files) };
  } catch {
    return null;
  }
}
function loadSession(repoRoot2, sessionId) {
  const s = { sessionId, acknowledged: [], findings: [], files: [] };
  const parts = [];
  try {
    parts.push(readSessionFile(sessionPath(repoRoot2, sessionId)));
  } catch {
  }
  parts.push(readSessionFile(fallbackSessionPath(repoRoot2, sessionId)));
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
function writeAtomic(file, text) {
  mkdirSync2(join7(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync2(tmp, text);
    renameSync2(tmp, file);
  } catch (err) {
    try {
      unlinkSync2(tmp);
    } catch {
    }
    throw err;
  }
}
function saveSession(repoRoot2, s) {
  const text = JSON.stringify(s);
  try {
    writeAtomic(sessionPath(repoRoot2, s.sessionId), text);
    return;
  } catch {
  }
  writeAtomic(fallbackSessionPath(repoRoot2, s.sessionId), text);
}
function baselinePath(repoRoot2, sessionId) {
  return join7(indexDir(repoRoot2), "baselines", `${sanitizeSessionId(sessionId)}.json`);
}
function loadBaseline(repoRoot2, sessionId) {
  try {
    const raw = JSON.parse(readFileSync7(baselinePath(repoRoot2, sessionId), "utf8"));
    if (!raw || typeof raw !== "object" || typeof raw.at !== "string" || typeof raw.complete !== "boolean") return null;
    if (!raw.files || typeof raw.files !== "object" || Array.isArray(raw.files)) return null;
    const files = /* @__PURE__ */ Object.create(null);
    for (const [k, v] of Object.entries(raw.files)) {
      if (typeof v === "string" || v === null) files[k] = v;
    }
    return { at: raw.at, complete: raw.complete, files };
  } catch {
    return null;
  }
}
function saveBaseline(repoRoot2, sessionId, b) {
  writeAtomic(baselinePath(repoRoot2, sessionId), JSON.stringify(b));
}

// src/hook.ts
var HookTimeout = class extends Error {
};
var Deadline = class {
  constructor(at) {
    this.at = at;
  }
  remaining() {
    return this.at - Date.now();
  }
  /** Budget for one git call; throws once the time is gone. */
  budget() {
    const r = this.remaining();
    if (r <= 0) throw new HookTimeout("hook budget spent");
    return Math.max(50, r);
  }
  check() {
    if (this.remaining() <= 0) throw new HookTimeout("hook budget spent");
  }
};
var EDIT_TOOLS = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit"]);
var MAX_SESSION_FILES = 500;
var MAX_FALLBACK_COMMITS = 6;
var MAX_STOP_FILES = 25;
function scriptDir() {
  try {
    return dirname3(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}
function defaultSpawnIndexer(cliPath) {
  return (root) => {
    if (!existsSync3(cliPath)) return;
    const child = spawn(process.execPath, [cliPath, "index", "--quiet"], {
      cwd: root,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.on("error", () => {
    });
    child.unref();
  };
}
function logError(root, err) {
  if (!root || err instanceof HookTimeout) return;
  try {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    appendFileSync(join8(indexDir(root), "chesterton.log"), `${(/* @__PURE__ */ new Date()).toISOString()} hook: ${msg}
`);
  } catch {
  }
}
function handleHookInput(raw, deps = {}) {
  const startedAt = deps.startedAt ?? Date.now();
  let root = null;
  try {
    const input = JSON.parse(raw);
    if (!input || typeof input !== "object") return null;
    const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
    root = repoRoot(cwd);
    const event = input.hook_event_name;
    if (event === "PreToolUse") root = rootForToolInput(input.tool_input, cwd, root);
    if (!root) return null;
    const cfg = loadConfig(root);
    const sessionId = typeof input.session_id === "string" && input.session_id ? input.session_id : "default";
    if (event === "PreToolUse") {
      const deadline = new Deadline(startedAt + cfg.hookTimeoutMs);
      return preToolUse(root, cfg, sessionId, input, deadline, deps.blame ?? blameRange);
    }
    if (event === "SessionStart") {
      return sessionStart(root, sessionId, deps);
    }
    if (event === "Stop") {
      if (input.stop_hook_active === true) return null;
      const deadline = new Deadline(startedAt + Math.max(cfg.hookTimeoutMs * 3, 3e3));
      const res = stop(root, cfg, sessionId, deadline);
      if (!res || deadline.remaining() <= 0) return null;
      res.commit();
      return res.text;
    }
    return null;
  } catch (err) {
    logError(root, err);
    return null;
  }
}
function rootForToolInput(toolInput, cwd, cwdRoot) {
  try {
    if (!toolInput || typeof toolInput !== "object") return cwdRoot;
    const fp = toolInput.file_path;
    if (typeof fp !== "string" || fp.trim() === "") return cwdRoot;
    const p = toolPathToNative(fp.trim());
    const abs = isAbsolute3(p) ? resolve4(p) : resolve4(cwdRoot ?? cwd, p);
    let dir = dirname3(abs);
    for (; ; ) {
      if (existsSync3(join8(dir, ".git"))) break;
      const up = dirname3(dir);
      if (up === dir) return cwdRoot;
      dir = up;
    }
    if (cwdRoot && samePath(dir, cwdRoot)) return cwdRoot;
    return repoRoot(dir) ?? cwdRoot;
  } catch {
    return cwdRoot;
  }
}
function samePath(a, b) {
  const norm = (p) => {
    let r = resolve4(p);
    try {
      r = realpathSync3.native(r);
    } catch {
    }
    return process.platform === "win32" || process.platform === "darwin" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}
function sessionStart(root, sessionId, deps) {
  const head = headSha(root);
  if (!head) return null;
  snapshotDirty(root, sessionId);
  const meta = loadMeta(root);
  if (!meta || meta.head !== head) {
    const spawnIt = deps.spawnIndexer ?? defaultSpawnIndexer(deps.cliPath ?? join8(scriptDir(), "cli.js"));
    try {
      spawnIt(root);
    } catch (err) {
      logError(root, err);
    }
  }
  if (!meta) return null;
  const n = meta.fixCommits;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `Chesterton: ${n} fix commit${n === 1 ? "" : "s"} indexed. Edits that undo a past bug fix will be flagged.`
    }
  });
}
var MAX_BASELINE_HASHED = 300;
var MAX_BASELINE_FILES = 5e3;
var MAX_HASH_BYTES = 2 * 1024 * 1024;
function contentHash(root, relPath) {
  const file = join8(root, relPath);
  try {
    if (statSync4(file).size > MAX_HASH_BYTES) return null;
    return createHash3("sha1").update(readFileSync8(file)).digest("hex");
  } catch (err) {
    return err.code === "ENOENT" ? "deleted" : null;
  }
}
function snapshotDirty(root, sessionId) {
  try {
    if (loadBaseline(root, sessionId)) return;
    const dirty = dirtyFiles(root, 3e3);
    const files = /* @__PURE__ */ Object.create(null);
    let hashed = 0;
    for (const f of dirty.slice(0, MAX_BASELINE_FILES)) {
      files[f] = hashed++ < MAX_BASELINE_HASHED ? contentHash(root, f) : null;
    }
    saveBaseline(root, sessionId, { at: (/* @__PURE__ */ new Date()).toISOString(), complete: dirty.length <= MAX_BASELINE_FILES, files });
  } catch (err) {
    logError(root, err);
  }
}
function preToolUse(root, cfg, sessionId, input, deadline, blameFn) {
  const tool = typeof input.tool_name === "string" ? input.tool_name : "";
  if (!EDIT_TOOLS.has(tool)) return null;
  const changes = changeFromToolCall(root, tool, input.tool_input);
  if (changes.length === 0) return null;
  deadline.check();
  const idx = loadIndexForFiles(root, changes.map((c) => c.relPath));
  deadline.check();
  const session = loadSession(root, sessionId);
  const before = JSON.stringify(session);
  let out = null;
  for (const change of changes) {
    if (!session.files.includes(change.relPath)) {
      session.files.push(change.relPath);
      if (session.files.length > MAX_SESSION_FILES) session.files.splice(0, session.files.length - MAX_SESSION_FILES);
    }
    const findings = idx ? analyzeChange(root, change, idx, cfg, { blame: (r, p, s, e) => blameFn(r, p, s, e, deadline.budget()) }) : fallbackFindings(root, change, cfg, deadline, blameFn);
    deadline.check();
    const res = decidePreToolUse(findings, session, cfg, change.relPath);
    if (res.stdout && !out) out = res.stdout;
  }
  deadline.check();
  if (JSON.stringify(session) !== before) {
    try {
      saveSession(root, session);
    } catch (err) {
      logError(root, err);
      out = denyToContext(out);
    }
  }
  return out;
}
function denyToContext(out) {
  if (!out) return out;
  try {
    const o = JSON.parse(out);
    const h = o.hookSpecificOutput;
    if (!h || h.permissionDecision !== "deny") return out;
    const reason = typeof h.permissionDecisionReason === "string" ? h.permissionDecisionReason : "";
    const extra = typeof h.additionalContext === "string" ? `

${h.additionalContext}` : "";
    const note = "Chesterton could not save its session state, so this edit was allowed instead of stopped. Read the note below before going on.";
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: `${note}

${reason}${extra}` }
    });
  } catch {
    return null;
  }
}
function memoBlame(deadline, inner = blameRange) {
  const cache = /* @__PURE__ */ new Map();
  const shas = /* @__PURE__ */ new Map();
  const fn = (r, p, s, e) => {
    const key = `${p}:${s}-${e}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const lines = inner(r, p, s, e, deadline.budget());
    cache.set(key, lines);
    for (const l of lines) {
      if (/^0+$/.test(l.sha)) continue;
      let paths = shas.get(l.sha);
      if (!paths) shas.set(l.sha, paths = /* @__PURE__ */ new Set());
      paths.add(l.origPath || p);
    }
    return lines;
  };
  return { fn, shas };
}
function addedLinesInCommit(root, sha, path, timeoutMs) {
  const diff = runGit(["show", "--format=", "-U0", "--no-color", "--no-ext-diff", sha, "--", path], root, timeoutMs);
  const out = [];
  let line = 0;
  for (const l of diff.split(/\r?\n/)) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (m) {
      line = Number(m[1]);
      continue;
    }
    if (l.startsWith("+++") || l.startsWith("---")) continue;
    if (l.startsWith("+")) {
      const norm = normalizeLine(l.slice(1));
      if (!isTrivial(norm)) out.push({ hash: hashLine(norm), text: l.slice(1).trim().slice(0, 200), line });
      line++;
    }
  }
  return out;
}
function fallbackFindings(root, change, cfg, deadline, blameFn) {
  if (change.isNewFile || change.removed.length === 0) return [];
  const blame = memoBlame(deadline, blameFn);
  const empty = { version: INDEX_VERSION, head: "", builtAt: "", commits: {}, files: {} };
  const removalOnly = { ...change, added: [] };
  analyzeChange(root, removalOnly, empty, cfg, { blame: blame.fn, alwaysBlame: true });
  const idx = { version: INDEX_VERSION, head: "", builtAt: "", commits: {}, files: { [change.relPath]: [] } };
  let n = 0;
  let shallow = null;
  for (const [sha, paths] of blame.shas) {
    if (n++ >= MAX_FALLBACK_COMMITS) break;
    if (cfg.ignoreCommits.some((p) => p && sha.startsWith(p))) continue;
    const meta = runGit(["show", "-s", "--format=%H%x00%aI%x00%an%x00%P%x00%s%x00%b", sha], root, deadline.budget());
    const [full = sha, date = "", author = "", parents = "", subject = "", body = ""] = meta.replace(/\n$/, "").split("\0");
    const parentCount = parents.trim() ? parents.trim().split(/\s+/).length : 0;
    shallow ??= shallowInfo(root);
    if (shallow.boundary.has(full) || shallow.shallow && parentCount === 0) continue;
    const files = parseNumstat(runGit(["show", "--numstat", "--format=", "--no-color", sha], root, deadline.budget()));
    const res = classifyCommit({ sha: full, subject, body, files, parents: parentCount }, cfg);
    if (!res.isFix) continue;
    const fix = { sha: full, date, author, subject, score: res.score, reasons: res.reasons, refs: res.refs, testFiles: res.testFiles };
    idx.commits[full] = fix;
    for (const path of paths) {
      const added = addedLinesInCommit(root, full, path, deadline.budget());
      const rec = { sha: full, path, added, removed: [] };
      idx.files[change.relPath].push(rec);
    }
  }
  if (Object.keys(idx.commits).length === 0) return [];
  deadline.check();
  return analyzeChange(root, change, idx, cfg, { blame: blame.fn, alwaysBlame: true });
}
function parseNumstat(text) {
  const out = [];
  for (const l of text.split(/\r?\n/)) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l);
    if (!m) continue;
    out.push({ path: m[3], status: "M", added: m[1] === "-" ? 0 : Number(m[1]), removed: m[2] === "-" ? 0 : Number(m[2]) });
  }
  return out;
}
function blameAtHead(root, relPath, start, end, timeoutMs) {
  const text = runGit(["blame", "--porcelain", "-L", `${start},${end}`, "HEAD", "--", relPath], root, timeoutMs ?? 1e4);
  return parsePorcelain(text).map((b) => ({ ...b, origPath: b.origPath || relPath }));
}
function shortVerb(f) {
  return f.kind === "removes-fix" ? "removes code added by fix" : "adds back code removed by fix";
}
function stopCandidates(root, session, deadline) {
  const edited = new Set(session.files);
  const out = [];
  const base = loadBaseline(root, session.sessionId);
  if (base && base.complete) {
    let dirty = [];
    try {
      dirty = dirtyFiles(root, Math.min(3e3, deadline.budget()));
    } catch {
      dirty = [];
    }
    for (const f of dirty) {
      if (edited.has(f)) continue;
      if (Object.prototype.hasOwnProperty.call(base.files, f)) {
        const was = base.files[f];
        if (was === null || was === void 0 || contentHash(root, f) === was) continue;
      }
      out.push(f);
    }
  }
  out.push(...session.files);
  return out.slice(-MAX_STOP_FILES);
}
function stop(root, cfg, sessionId, deadline) {
  const session = loadSession(root, sessionId);
  const files = stopCandidates(root, session, deadline);
  if (files.length === 0) return null;
  const idx = loadIndexForFiles(root, files);
  if (!idx) return null;
  const seen = /* @__PURE__ */ new Set([...session.acknowledged, ...session.findings.map((f) => f.key)]);
  const ledger = [];
  const blame = (r, p, s, e) => blameAtHead(r, p, s, e, deadline.budget());
  for (const rel of files) {
    deadline.check();
    let headText = null;
    try {
      headText = runGit(["show", `HEAD:${rel}`], root, deadline.budget());
    } catch {
      headText = null;
    }
    let workText = "";
    try {
      workText = readFileSync8(join8(root, rel), "utf8");
    } catch {
      workText = "";
    }
    const d = diffLines(splitLines(headText ?? ""), splitLines(workText));
    if (d.removed.length === 0 && d.added.length === 0) continue;
    const change = { relPath: rel, removed: d.removed, added: d.added, isNewFile: headText === null };
    const findings = analyzeChange(root, change, idx, cfg, { blame, currentContent: headText, timeoutMs: deadline.budget() });
    for (const f of findings) {
      const key = `${rel}@${f.fix.sha}`;
      if (f.strength !== "strong" || seen.has(key)) continue;
      seen.add(key);
      ledger.push(f);
    }
  }
  if (ledger.length === 0) return null;
  const commit = () => {
    for (const f of ledger) {
      session.findings.push({
        at: (/* @__PURE__ */ new Date()).toISOString(),
        key: `${f.file}@${f.fix.sha}`,
        kind: f.kind,
        strength: f.strength,
        file: f.file,
        sha: f.fix.sha,
        decision: "stop-ledger"
      });
    }
    try {
      saveSession(root, session);
    } catch (err) {
      logError(root, err);
    }
  };
  const items = ledger.map((f) => `- ${f.file}: ${shortVerb(f)} ${f.fix.sha.slice(0, 7)} "${f.fix.subject}" (git show ${f.fix.sha.slice(0, 7)})`);
  const text = `Chesterton: before you finish, ${ledger.length === 1 ? "one change from this session touches a past bug fix that was" : `${ledger.length} changes from this session touch past bug fixes that were`} not flagged at edit time:
${items.join("\n")}
Check each fix still holds, and tell the user if you removed or reverted one on purpose.`;
  return { text: JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: text } }), commit };
}
function readStdin() {
  return new Promise((res) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => res(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => res(""));
  });
}
async function main() {
  const startedAt = Date.now();
  const timer = setTimeout(() => process.exit(0), Math.max(DEFAULT_CONFIG.hookTimeoutMs, 1e3) + 2e3);
  timer.unref();
  try {
    const raw = await readStdin();
    const out = handleHookInput(raw, { startedAt });
    if (out) {
      process.stdout.write(out + "\n", () => process.exit(0));
      return;
    }
  } catch {
  }
  process.exit(0);
}
function isMain() {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    const self = fileURLToPath(import.meta.url);
    const norm = (p) => {
      let r = resolve4(p);
      try {
        r = realpathSync3(r);
      } catch {
      }
      return process.platform === "win32" ? r.toLowerCase() : r;
    };
    return norm(argv1) === norm(self);
  } catch {
    return false;
  }
}
if (isMain()) void main();
export {
  addedLinesInCommit,
  blameAtHead,
  contentHash,
  handleHookInput,
  main
};
