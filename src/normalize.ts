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
