import type { ChestertonConfig, Finding, FixCommit } from "./types.js";
import type { SessionState } from "./session.js";

/** JSON to print, or null for a silent allow. */
export interface HookResponse {
  stdout: string | null;
}

/** Cap on remembered findings per session so the file stays small. */
const MAX_LOGGED = 500;

// ---------- glob matching ----------

/**
 * Glob pieces: DIRS is "**" plus a slash (nothing, or anything ending in a slash), ANY is "**",
 * STAR is "*" (no slash), ONE is "?" (one character, not a slash), LIT is a literal character.
 */
type GlobToken = { t: "DIRS" | "ANY" | "STAR" | "ONE" } | { t: "LIT"; c: string };

function tokenizeGlob(glob: string): GlobToken[] {
  let g = glob.trim().replace(/\\/g, "/");
  if (g.startsWith("./")) g = g.slice(2);
  if (g.startsWith("/")) g = g.slice(1);
  // "dir/" means everything under dir.
  if (g.endsWith("/")) g += "**";
  // A pattern with no slash matches the basename anywhere, like .gitignore.
  if (!g.includes("/")) g = `**/${g}`;
  const out: GlobToken[] = [];
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        const slashAfter = g[i + 2] === "/";
        i += slashAfter ? 2 : 1;
        const t = slashAfter ? "DIRS" : "ANY";
        // "**/**/" is the same as "**/".
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

/**
 * Whole-path glob match by dynamic programming, so the time is tokens times path length whatever
 * the pattern. A regex backtracks exponentially on patterns like "**" + "/**" repeated, and
 * `protect` comes from a config file inside the repo.
 */
function globMatches(tokens: GlobToken[], s: string): boolean {
  const n = s.length;
  // next[i] is 1 when the tokens after the current one match s.slice(i).
  let next = new Uint8Array(n + 1);
  next[n] = 1;
  for (let ti = tokens.length - 1; ti >= 0; ti--) {
    const tok = tokens[ti]!;
    const cur = new Uint8Array(n + 1);
    // DIRS: a slash at or after i is followed by a match of the rest.
    let slashAhead = 0;
    for (let i = n; i >= 0; i--) {
      const ch = i < n ? s[i] : "";
      let ok = 0;
      if (tok.t === "LIT") ok = i < n && ch === tok.c ? next[i + 1]! : 0;
      else if (tok.t === "ONE") ok = i < n && ch !== "/" ? next[i + 1]! : 0;
      else if (tok.t === "STAR") ok = next[i]! || (i < n && ch !== "/" ? cur[i + 1]! : 0);
      else if (tok.t === "ANY") ok = next[i]! || (i < n ? cur[i + 1]! : 0);
      else {
        if (i < n && ch === "/" && next[i + 1]) slashAhead = 1;
        ok = next[i]! || slashAhead;
      }
      cur[i] = ok ? 1 : 0;
    }
    next = cur;
  }
  return next[0] === 1;
}

/** Minimal glob match on repo-relative posix paths. Supports **, * and ?. */
export function matchGlob(relPath: string, glob: string): boolean {
  if (!glob.trim()) return false;
  try {
    if (globMatches(tokenizeGlob(glob), relPath)) return true;
    // "src/auth" should also cover files under it.
    return !/[*?]/.test(glob) && relPath.startsWith(glob.replace(/\\/g, "/").replace(/\/+$/, "") + "/");
  } catch {
    return false;
  }
}

export function isProtected(relPath: string, cfg: ChestertonConfig): boolean {
  return cfg.protect.some((g) => matchGlob(relPath, g));
}

// ---------- message text ----------

function short(sha: string): string {
  return sha.slice(0, 7);
}

function fixHeader(fix: FixCommit): string {
  const date = fix.date ? fix.date.slice(0, 10) : "unknown date";
  const who = fix.author ? `, ${fix.author}` : "";
  return `Fix: ${short(fix.sha)} (${date}${who}) "${fix.subject}"`;
}

/** Most test files or refs named in one message. */
const MAX_LISTED = 3;

/** "a, b, c and 4 more" style cap for lists shown to Claude or the user. */
export function capList(items: string[], max = MAX_LISTED): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}

function whyLine(fix: FixCommit): string {
  const parts = [...fix.reasons];
  const joined = parts.join(" ").toLowerCase();
  const refs = fix.refs.filter((r) => !joined.includes(r.toLowerCase()));
  if (refs.length > 0) parts.push(`references ${capList(refs)}`);
  // The classifier already names up to 3 test files and counts the rest; only add them if it did not.
  if (!/\btests?\b/.test(joined) && fix.testFiles.length > 0) parts.push(`touches test ${capList(fix.testFiles)}`);
  return parts.length > 0 ? `Why it looks like a fix: ${parts.join("; ")}` : "";
}

/**
 * Findings about one fix commit, merged. One edit can both remove what a fix added and put back
 * what it removed; that is still one fix, shown once.
 */
interface FixGroup {
  fix: FixCommit;
  strong: boolean;
  removes: string[];
  readds: string[];
}

/** One group per fix commit, in the order the findings came (analyze puts strong ones first). */
function groupByFix(findings: Finding[]): FixGroup[] {
  const groups = new Map<string, FixGroup>();
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

function indented(lines: string[]): string {
  return lines.map((l) => `  ${l}`).join("\n");
}

function linesBlock(g: FixGroup): string {
  if (g.removes.length > 0 && g.readds.length > 0) {
    return `Lines it removes:\n${indented(g.removes)}\nLines it adds back:\n${indented(g.readds)}`;
  }
  const lines = [...g.removes, ...g.readds];
  return lines.length > 0 ? `Lines:\n${indented(lines)}` : "";
}

function groupBlock(g: FixGroup): string {
  return [fixHeader(g.fix), whyLine(g.fix), linesBlock(g)].filter(Boolean).join("\n");
}

function verb(g: FixGroup): string {
  const sha = short(g.fix.sha);
  const removes = g.removes.length > 0;
  const readds = g.readds.length > 0;
  if (removes && readds) return `removes code that fix ${sha} added and adds back code it removed`;
  return readds ? `adds back code that fix ${sha} removed` : `removes code that fix ${sha} added`;
}

function headline(groups: FixGroup[], relPath: string, withList: boolean): string {
  if (groups.length === 1) return `Chesterton: this edit to ${relPath} ${verb(groups[0]!)}.`;
  const list = withList ? ` (${groups.map(verb).join("; ")})` : "";
  return `Chesterton: this edit to ${relPath} touches ${groups.length} past bug fixes${list}.`;
}

function denyReason(strong: Finding[], relPath: string): string {
  const groups = groupByFix(strong);
  const blocks = groups.map(groupBlock).join("\n\n");
  const show = groups.map((g) => `git show ${short(g.fix.sha)}`).join(", ");
  const anyReadd = groups.some((g) => g.readds.length > 0);
  const anyRemove = groups.some((g) => g.removes.length > 0);
  const what = anyRemove && anyReadd ? "changing this" : anyRemove ? "removing this" : "adding this back";
  const tail =
    `Before ${what}, check the fix commit${groups.length === 1 ? "" : "s"} (${show}). Keep the fix, or rework the change around it. ` +
    `If you are sure it is safe, tell the user why, then retry the same edit and Chesterton will let it through.`;
  return `${headline(groups, relPath, true)}\n\n${blocks}\n\n${tail}`;
}

function askReason(strong: Finding[], relPath: string, prot: boolean): string {
  const groups = groupByFix(strong);
  const why = prot ? `${relPath} is a protected path, so a person has to approve this.` : `Chesterton is set to ask before edits like this.`;
  return `${headline(groups, relPath, false)} ${why}\n\n${groups.map(groupBlock).join("\n\n")}`;
}

function contextText(findings: Finding[], relPath: string, note?: string): string {
  const intro =
    note ??
    `Chesterton: heads up, this edit to ${relPath} may touch code from a past bug fix. It was allowed; check it still holds.`;
  const items = groupByFix(findings).map(
    (g) => `- ${g.strong ? "" : "possibly "}${verb(g)}\n  ${groupBlock(g).replace(/\n/g, "\n  ")}`,
  );
  return `${intro}\n${items.join("\n")}`;
}

// ---------- decision ----------

function output(fields: { permissionDecision?: "deny" | "ask" | "allow"; permissionDecisionReason?: string; additionalContext?: string }): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...fields } });
}

function log(session: SessionState, f: Finding, relPath: string, decision: string): void {
  session.findings.push({
    at: new Date().toISOString(),
    key: `${relPath}@${f.fix.sha}`,
    kind: f.kind,
    strength: f.strength,
    file: relPath,
    sha: f.fix.sha,
    decision,
  });
  if (session.findings.length > MAX_LOGGED) session.findings.splice(0, session.findings.length - MAX_LOGGED);
}

/**
 * Turn findings into a PreToolUse response. Mutates `session` (acknowledged keys and the finding
 * log); the caller saves it.
 */
export function decidePreToolUse(findings: Finding[], session: SessionState, cfg: ChestertonConfig, relPath: string): HookResponse {
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
    const out: Parameters<typeof output>[0] = { permissionDecision: "ask", permissionDecisionReason: askReason(strong, relPath, prot) };
    if (weak.length > 0) out.additionalContext = contextText(weak, relPath);
    return { stdout: output(out) };
  }

  if (cfg.mode === "warn-only") {
    for (const f of findings) log(session, f, relPath, "warn");
    return { stdout: output({ additionalContext: contextText(findings, relPath) }) };
  }

  // speedbump
  const keyOf = (f: Finding) => `${relPath}@${f.fix.sha}`;
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
  // Acked strong findings ride along in the reason so Claude sees the whole picture.
  return { stdout: output({ permissionDecision: "deny", permissionDecisionReason: denyReason(strong, relPath) }) };
}
