import { createHash } from "node:crypto";

/** Trim, collapse inner whitespace, drop trailing CR. Both sides of the check must use this. */
export function normalizeLine(raw: string): string {
  return raw.replace(/\r$/, "").trim().replace(/\s+/g, " ");
}

const TRIVIAL = new Set([
  "", "{", "}", "(", ")", "[", "]", "};", "});", "})", ");", "],", "},", "end", "else", "else {",
  "} else {", "} else", "try {", "} catch {", "finally {", "} finally {", "return", "return;",
  "break;", "continue;", "pass", "fi", "done", "esac", "then", "do", "begin", "*/", "/*", "*",
  "//", "#", "\"\"\"", "'''", "<div>", "</div>", "default:", "</>", "<>",
]);

/**
 * True for lines that carry no meaning alone: braces, keywords, blanks, bare comment markers,
 * and very short lines. Trivial lines are never stored in the index and never matched.
 */
export function isTrivial(normalized: string): boolean {
  if (TRIVIAL.has(normalized)) return true;
  if (normalized.length < 4) return true;
  // Pure punctuation.
  if (/^[\s{}()[\];,.:]*$/.test(normalized)) return true;
  // Import / require / use lines move around constantly; too noisy to match on.
  if (/^(import|from|use|require|#include|using|package)\b/.test(normalized)) return true;
  // `const x = require("x");` is an import too.
  // Also `require('debug')('express:router')` and `require('x').y`.
  if (/^(var|let|const)\s+[\w$\s{},:]+=\s*require\(\s*["'`][^"'`]+["'`]\s*\)(\s*\(\s*["'`][^"'`]*["'`]\s*\)|\.[\w$]+)*\s*[;,]?$/.test(normalized)) return true;
  if (isVersionPin(normalized)) return true;
  // A lone string list entry: `"urllib3>=1.21.1,<1.27",`.
  if (/^(["'`])(?:(?!\1)[^\\]|\\.)*\1,$/.test(normalized)) return true;
  return false;
}

/**
 * Dependency and version pins: they change on every bump, so matching on them is noise.
 * `"pkg": "^1.2.3",`, `version = "1.2.3"`, `pkg>=1.2,<2`, `pkg==1.2`, `uses: owner/action@v4`.
 */
function isVersionPin(n: string): boolean {
  const ver = String.raw`[~^<>=!]*\s*v?\d+(?:\.[\w*+-]+)*`;
  // package.json style: "name": "^1.2.3"
  if (new RegExp(String.raw`^["'][@\w./-]+["']\s*:\s*["']${ver}["'],?$`).test(n)) return true;
  // toml / ini style: version = "1.2.3", serde = "1.0.100"
  if (new RegExp(String.raw`^[\w.-]+\s*=\s*["']${ver}["'],?$`).test(n) && /\d\.\d/.test(n)) return true;
  // pip style: pkg>=1.2,<2 or pkg==1.2 (optionally with extras and an environment marker)
  if (/^[A-Za-z][\w.-]*(\[[\w,.-]+\])?\s*(==|>=|<=|~=|!=|>|<)\s*\d+\.[\w.*]*(\s*,\s*(==|>=|<=|~=|!=|>|<)\s*\d[\w.*]*)*(\s*;.*)?$/.test(n)) return true;
  // GitHub Actions: uses: actions/checkout@v4 or @<sha> # v4.1.0
  if (/^(-\s*)?uses:\s*["']?[\w./-]+@[\w.-]+["']?(\s*#.*)?$/.test(n)) return true;
  // pre-commit style: rev: v4.4.0
  if (/^(-\s*)?rev:\s*["']?v?\d[\w.-]*["']?$/.test(n)) return true;
  return false;
}

export function hashLine(normalized: string): string {
  return createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

/** Split text into lines, tolerant of CRLF. A trailing newline does not produce an empty last line. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Repo-relative path with forward slashes. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}
