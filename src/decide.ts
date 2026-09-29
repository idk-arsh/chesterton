import type { ChestertonConfig, Finding, FixCommit } from "./types.js";
import type { SessionState } from "./session.js";

/** JSON to print, or null for a silent allow. */
export interface HookResponse {
  stdout: string | null;
}

/** Cap on remembered findings per session so the file stays small. */
const MAX_LOGGED = 500;

// ---------- glob matching ----------

function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/\\/g, "/");
  if (g.startsWith("./")) g = g.slice(2);
  if (g.startsWith("/")) g = g.slice(1);
  // "dir/" means everything under dir.
  if (g.endsWith("/")) g += "**";
  // A pattern with no slash matches the basename anywhere, like .gitignore.
  if (!g.includes("/")) g = `**/${g}`;
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        const slashAfter = g[i + 2] === "/";
        i += slashAfter ? 2 : 1;
        re += slashAfter ? "(?:.*/)?" : ".*";
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

/** Minimal glob match on repo-relative posix paths. Supports **, * and ?. */
export function matchGlob(relPath: string, glob: string): boolean {
  if (!glob.trim()) return false;
  try {
    const re = globToRegExp(glob);
    if (re.test(relPath)) return true;
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

function whyLine(fix: FixCommit): string {
  const parts = [...fix.reasons];
  const joined = parts.join(" ").toLowerCase();
  for (const r of fix.refs) if (!joined.includes(r.toLowerCase())) parts.push(`references ${r}`);
  for (const t of fix.testFiles) if (!joined.includes(t.toLowerCase())) parts.push(`touches test ${t}`);
  return parts.length > 0 ? `Why it looks like a fix: ${parts.join("; ")}` : "";
}

function linesBlock(f: Finding): string {
  if (f.lines.length === 0) return "";
  return `Lines:\n${f.lines.map((l) => `  ${l}`).join("\n")}`;
}

function findingBlock(f: Finding): string {
  return [fixHeader(f.fix), whyLine(f.fix), linesBlock(f)].filter(Boolean).join("\n");
}

function verb(f: Finding): string {
  return f.kind === "removes-fix"
    ? `removes code that fix ${short(f.fix.sha)} added`
    : `adds back code that fix ${short(f.fix.sha)} removed`;
}

function denyReason(strong: Finding[], relPath: string): string {
  const head =
    strong.length === 1
      ? `Chesterton: this edit to ${relPath} ${verb(strong[0]!)}.`
      : `Chesterton: this edit to ${relPath} touches ${strong.length} past bug fixes (${strong.map(verb).join("; ")}).`;
  const blocks = strong.map(findingBlock).join("\n\n");
  const shas = [...new Set(strong.map((f) => short(f.fix.sha)))];
  const show = shas.map((s) => `git show ${s}`).join(", ");
  const anyReadd = strong.some((f) => f.kind === "re-adds-removed");
  const anyRemove = strong.some((f) => f.kind === "removes-fix");
  const what = anyRemove && anyReadd ? "changing this" : anyRemove ? "removing this" : "adding this back";
  const tail =
    `Before ${what}, check the fix commit (${show}). Keep the fix, or rework the change around it. ` +
    `If you are sure it is safe, tell the user why, then retry the same edit and Chesterton will let it through.`;
  return `${head}\n\n${blocks}\n\n${tail}`;
}

function askReason(strong: Finding[], relPath: string, prot: boolean): string {
  const head =
    strong.length === 1
      ? `Chesterton: this edit to ${relPath} ${verb(strong[0]!)}.`
      : `Chesterton: this edit to ${relPath} touches ${strong.length} past bug fixes.`;
  const why = prot ? `${relPath} is a protected path, so a person has to approve this.` : `Chesterton is set to ask before edits like this.`;
  return `${head} ${why}\n\n${strong.map(findingBlock).join("\n\n")}`;
}

function contextText(findings: Finding[], relPath: string, note?: string): string {
  const intro =
    note ??
    `Chesterton: heads up, this edit to ${relPath} may touch code from a past bug fix. It was allowed; check it still holds.`;
  const items = findings.map((f) => `- ${f.strength === "strong" ? "" : "possibly "}${verb(f)}\n  ${findingBlock(f).replace(/\n/g, "\n  ")}`);
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
