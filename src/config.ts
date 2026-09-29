import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChestertonConfig, Mode } from "./types.js";

export const DEFAULT_CONFIG: ChestertonConfig = {
  mode: "speedbump",
  history: "all",
  maxCommits: 20_000,
  protect: [],
  fixPatternsExtra: [],
  ignoreCommits: [],
  hookTimeoutMs: 1_500,
};

export const CONFIG_FILE = ".chesterton.yml";

/**
 * Largest accepted hook_timeout_ms. hooks/hooks.json gives PreToolUse 5 s and Stop 15 s; the edit
 * check must finish (plus Node startup) inside 5 s, and the Stop sweep gets 3x this budget.
 * Higher values are capped so Claude Code never kills the hook mid-run and reports an error.
 */
export const MAX_HOOK_TIMEOUT_MS = 4_000;
export const MIN_HOOK_TIMEOUT_MS = 100;

const MODES: readonly Mode[] = ["speedbump", "ask", "warn-only"];

export type YamlValue = string | string[];

/**
 * Parse the small YAML subset `.chesterton.yml` needs:
 *
 *   key: scalar          # comment
 *   key: "quoted # not a comment"
 *   key: [a, "b", 'c']
 *   key:
 *     - item
 *     - "item two"
 *
 * Only top-level keys. Nested maps, anchors, multi-line strings and the rest of YAML are not
 * supported; lines it cannot read are skipped and reported in `warnings`. Never throws.
 */
export function parseYamlSubset(text: string): { values: Record<string, YamlValue>; warnings: string[] } {
  const values: Record<string, YamlValue> = {};
  const warnings: string[] = [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let listKey: string | null = null;

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
    const key = kv[1]!;
    const rest = (kv[2] ?? "").trim();
    if (rest === "") {
      // Either an empty value or the start of a block list.
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

/** Drop a `#` comment that starts the line or follows whitespace, ignoring `#` inside quotes. */
function stripComment(line: string): string {
  let quote: string | null = null;
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
    if (c === "#" && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\(["\\nt])/g, (_m, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  return t;
}

function splitInlineList(inner: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
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

function asList(v: YamlValue | undefined): string[] | null {
  if (v === undefined) return null;
  if (Array.isArray(v)) return v;
  return v === "" ? [] : [v];
}

function asInt(v: YamlValue | undefined): number | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/_/g, "");
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * True when a regex source repeats a group that holds a repeat, like `(a+)+` or `(\w*\s)*`. Those
 * can backtrack for ages on a message that almost matches, and `.chesterton.yml` comes from the
 * repo, so a cloned repo must not be able to hang the hook or the indexer with one. A rough check:
 * it looks at `*`, `+` and `{n,}` style repeats and ignores `?`, escapes and character classes.
 */
export function hasNestedRepeat(src: string): boolean {
  const stack: boolean[] = [false];
  const repeatAt = (i: number) => {
    const c = src[i];
    if (c === "*" || c === "+") return true;
    const m = c === "{" ? /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i)) : null;
    if (!m) return false;
    // {3}, {2,}, {1,5} repeat; {0}, {1}, {0,1} do not.
    const max = m[2] === undefined ? Number(m[1]) : m[3] === "" ? Infinity : Number(m[3]);
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
      const inner = stack.length > 1 ? stack.pop()! : false;
      const repeated = repeatAt(i + 1);
      if (inner && repeated) return true;
      stack[stack.length - 1] = stack[stack.length - 1]! || inner || repeated;
    } else if (repeatAt(i)) {
      stack[stack.length - 1] = true;
    }
  }
  return false;
}

/**
 * Turn the text of `.chesterton.yml` into a config. Bad values fall back to their defaults and
 * produce a warning. Unknown keys produce a warning and are ignored.
 */
export function parseConfig(text: string): { config: ChestertonConfig; warnings: string[] } {
  const { values, warnings } = parseYamlSubset(text);
  const cfg: ChestertonConfig = {
    ...DEFAULT_CONFIG,
    protect: [],
    fixPatternsExtra: [],
    ignoreCommits: [],
  };
  const bad = (key: string, why: string) => warnings.push(`${key}: ${why}, using default`);

  for (const [key, value] of Object.entries(values)) {
    switch (key) {
      case "mode": {
        const m = typeof value === "string" ? value.toLowerCase() : "";
        if ((MODES as readonly string[]).includes(m)) cfg.mode = m as Mode;
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

/** Same as loadConfig, plus the warnings, for `chesterton status`. */
export function loadConfigWithWarnings(repoRoot: string): { config: ChestertonConfig; warnings: string[]; found: boolean } {
  let text: string;
  try {
    text = readFileSync(join(repoRoot, CONFIG_FILE), "utf8");
  } catch {
    return { config: { ...DEFAULT_CONFIG, protect: [], fixPatternsExtra: [], ignoreCommits: [] }, warnings: [], found: false };
  }
  try {
    return { ...parseConfig(text), found: true };
  } catch (e) {
    return {
      config: { ...DEFAULT_CONFIG, protect: [], fixPatternsExtra: [], ignoreCommits: [] },
      warnings: [`could not parse ${CONFIG_FILE}: ${(e as Error).message}`],
      found: true,
    };
  }
}

/**
 * Load `.chesterton.yml` from the repo root and merge over DEFAULT_CONFIG.
 * Never throws: a missing or broken file yields defaults.
 */
export function loadConfig(repoRoot: string): ChestertonConfig {
  return loadConfigWithWarnings(repoRoot).config;
}
