/**
 * Customizable allow / ask / deny permission rules — deterministic, user-authored,
 * NOT an LLM. A rule targets a tool with an optional argument pattern,
 * `Tool(pattern)` (bare `Tool` matches any arguments). The pattern is matched
 * against the call's one-line summary (summarizeCall): the command for bash, the
 * path for read/write/edit, the title for a PR.
 *
 * Patterns support: exact text, `*` / `**` (any chars), `?` (one char), and the
 * Claude-style `:*` suffix for a prefix match (`Bash(git push:*)`). Rules are
 * evaluated deny → ask → allow and override the mode gate (see decideCall).
 */

import path from "node:path";

export type RuleEffect = "allow" | "ask" | "deny";

export interface Rule {
  /** Canonical tool name (e.g. "Bash", "Read") or "*" for any tool. */
  tool: string;
  /** null = match any arguments. */
  match: RegExp | null;
  /** Original `Tool(pattern)` text, for audit/diagnostics. */
  raw: string;
}

export interface CompiledRules {
  allow: Rule[];
  ask: Rule[];
  deny: Rule[];
}

export function emptyRules(): CompiledRules {
  return { allow: [], ask: [], deny: [] };
}

/** coble's wire tool names ↔ ergonomic rule aliases (either form is accepted). */
const TOOL_ALIASES: Record<string, string> = {
  read_file: "Read",
  write_file: "Write",
  edit_file: "Edit",
  bash: "Bash",
  git_branch: "GitBranch",
  git_commit: "GitCommit",
  git_push: "GitPush",
  create_pull_request: "CreatePullRequest",
};

/** Normalize a tool name (wire name or alias) to its canonical alias form. */
export function canonicalTool(name: string): string {
  return TOOL_ALIASES[name] ?? name;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strip a leading `./` so `Read(./src/**)` matches `src/...` paths too. */
function stripDotSlash(s: string): string {
  return s.startsWith("./") ? s.slice(2) : s;
}

/**
 * Compile a glob pattern to an anchored RegExp. `:*` suffix = prefix match;
 * otherwise `**`/`*` → any chars, `?` → one char, everything else literal.
 */
export function globToRegExp(glob: string, caseSensitive = false): RegExp {
  const g = stripDotSlash(glob);
  // Deny/ask compile case-INSENSITIVE: matches macOS/Windows filesystem semantics
  // and is the safe (over-blocking) direction on case-sensitive Linux too. ALLOW
  // compiles case-SENSITIVE (caseSensitive=true) — a grant must not widen to a
  // different case-variant (`Write(src/**)` must not auto-run `SRC/x`, a distinct
  // tree on Linux).
  const flags = caseSensitive ? "" : "i";
  if (g.endsWith(":*")) {
    return new RegExp("^" + escapeRegex(g.slice(0, -2)), flags); // prefix match, no end anchor
  }
  let out = "^";
  let prevStar = false; // collapse runs of `*` to a single `.*` (avoids `.*.*` backtracking / ReDoS)
  for (let i = 0; i < g.length; i += 1) {
    const ch = g[i] ?? "";
    if (ch === "*") {
      if (g[i + 1] === "*") i += 1; // ** and * are the same "any" semantics
      if (!prevStar) {
        out += ".*";
        prevStar = true;
      }
      continue;
    }
    prevStar = false;
    out += ch === "?" ? "." : escapeRegex(ch);
  }
  return new RegExp(out + "$", flags);
}

/** Parse a `Tool(pattern)` / `Tool` rule string. Returns null if malformed.
 *  `caseSensitive` controls glob compilation — true for allow grants (see
 *  globToRegExp), false (default) for deny/ask. */
export function parseRule(raw: string, caseSensitive = false): Rule | null {
  const trimmed = raw.trim();
  if (trimmed.length > 1000) return null; // guard against pathological / ReDoS patterns
  const m = /^([A-Za-z_*]+)(?:\((.*)\))?$/.exec(trimmed);
  if (!m) return null;
  const tool = m[1] === "*" ? "*" : canonicalTool(m[1] ?? "");
  const pattern = m[2];
  // No parens, empty parens, or `(*)` ⇒ match any arguments.
  const match = pattern === undefined || pattern === "" || pattern === "*" ? null : globToRegExp(pattern, caseSensitive);
  return { tool, match, raw: trimmed };
}

/** Compile a list of rule strings, dropping (and not silently inventing) bad
 *  ones. Pass `caseSensitive: true` for allow lists (grants must not case-fold). */
export function compileRuleList(raws: string[], caseSensitive = false): Rule[] {
  const out: Rule[] = [];
  for (const r of raws) {
    const rule = parseRule(r, caseSensitive);
    if (rule) out.push(rule);
  }
  return out;
}

const PATH_TOOLS = new Set(["Read", "Write", "Edit"]);

/** Transparent command wrappers / multicall binaries whose trailing argument is
 *  the real command. Best-effort: this set is inherently open-ended (the OS
 *  sandbox is the real boundary), but it covers the common everyday prefixes. */
const BASH_WRAPPERS = new Set([
  "env", "nohup", "command", "exec", "setsid", "sudo", "doas", "time", "timeout",
  "nice", "ionice", "stdbuf", "xargs", "busybox", "toybox", "chrt", "taskset",
]);

/** Basename of a binary token (handles `/` and `\` separators), plus the form
 *  with a Windows executable extension stripped (`curl.exe` → `curl`). */
function binaryBasenames(token: string): string[] {
  const base = token.split(/[\\/]+/).pop() || token;
  const noExt = base.replace(/\.(exe|cmd|bat|com)$/i, "");
  return noExt !== base ? [base, noExt] : [base];
}

/**
 * Strings a rule pattern is tested against. For Bash: every sub-command of a
 * compound line (env-prefix-stripped, wrappers unwrapped, binary reduced to its
 * basename) plus the whole line — so a deny rule survives chaining/prefixing
 * (`X=1 curl …`, `ls; curl …`), absolute/relative invocation (`/usr/bin/curl`,
 * `./curl`), and `nohup curl …`. For path tools: the path normalized (`..`/`./`
 * collapsed, trailing slash dropped) plus every trailing path suffix, so a deny
 * like `Read(secrets/**)` also blocks `/abs/secrets/x` and `a/../secrets/x`.
 *
 * `strict` (allow rules) skips this expansion: it matches only the literal
 * command / canonical path granted, so the deliberate over-matching can't turn
 * into an over-grant (`Bash(npm test)` won't approve `sudo npm test`;
 * `Write(src/**)` won't approve `tmp/src/x`).
 *
 * Best-effort: it cannot beat full shell obfuscation (`sh -c '…'`, `eval`,
 * base64) — the OS sandbox is the real containment boundary.
 */
const BASH_SEPARATORS = /&&|\|\||[;|&\n\r]/;

/** Shell control / expansion operators that make a command do more than its
 *  literal text — separators, redirection (`< >`), and command substitution
 *  (`$(…)` / backticks). A pattern ALLOW rule must not match a command carrying
 *  any of these: it would auto-approve a smuggled write or a second / substituted
 *  command (`Bash(echo:*)` → `echo x > f` / `echo $(curl …)`). Deny/ask use the
 *  looser BASH_SEPARATORS — they only need to split a line into segments. */
const SHELL_CONTROL_CHARS = /[;&|<>\n\r`]|\$\(/;

function matchCandidates(tool: string, summary: string, strict: boolean): string[] {
  if (tool === "Bash") {
    // Allow rules (strict) match the LITERAL command line only, and never one
    // carrying a shell control/expansion operator. The expansion below — split
    // segments, strip env prefixes, unwrap wrappers, basename the binary —
    // deliberately OVER-matches to catch deny/ask evasions; applied to allow it
    // would auto-approve a different, more dangerous command off a benign grant
    // (`Bash(npm test)` → `sudo npm test` / `./npm test`; `Bash(echo:*)` →
    // `echo x > f` / `echo $(curl …)`; `Bash(ls:*)` → `ls; rm -rf /`).
    if (strict) return SHELL_CONTROL_CHARS.test(summary) ? [] : [summary.trim()];
    return bashSegments(summary);
  }
  const cleaned = stripDotSlash(summary.trim()).replace(/\\/g, "/").replace(/\/+$/, ""); // backslash→slash, drop trailing slash
  if (!PATH_TOOLS.has(tool)) return [cleaned];
  const norm = path.posix.normalize(cleaned || ".");
  // Allow rules (strict) stay anchored to the NORMALIZED path only — never the
  // raw form, or `Write(src/**)` would approve `src/../.env` (the raw string
  // still begins with `src/`, while its normalized form `.env` does not). The
  // trailing-suffix expansion below over-matches for deny/ask (so
  // `Read(secrets/**)` also blocks `/abs/.../secrets/x`); for allow it would let
  // `Write(src/**)` approve `tmp/src/x`, escaping the granted root.
  if (strict) return [norm].filter(Boolean);
  const segs = norm.split("/").filter((s) => s && s !== "." && s !== "..");
  const out = new Set<string>([cleaned, norm]);
  for (let i = 0; i < segs.length; i += 1) out.add(segs.slice(i).join("/")); // every trailing suffix
  return [...out].filter(Boolean);
}

/** Candidate command lines for one segment's words: the binary reduced to its
 *  basename, plus — when the leading binary is a transparent wrapper (`sudo`,
 *  `env`, `timeout`, `xargs`, …) — the tail starting at every bare (non-flag,
 *  non-`KEY=val`) token. We can't reliably tell a wrapper flag from its value
 *  across every wrapper (`sudo -g group cmd`, `xargs -I {} cmd`, `timeout -s KILL
 *  cmd`), so we over-match (the safe direction for deny/ask) and let the wrapped
 *  binary surface however the flags are spelled. Allow rules don't use this —
 *  they match the literal command (see matchCandidates). */
function normalizeBashWords(words: string[]): string[] {
  const firstBases = binaryBasenames(words[0] ?? "");
  const out = firstBases.map((b) => [b, ...words.slice(1)].join(" "));
  // Case-insensitive wrapper match (mirrors globToRegExp's `i` flag): on a
  // case-insensitive FS `SUDO curl` runs the real sudo, so it must unwrap too.
  if (!BASH_WRAPPERS.has((firstBases.at(-1) ?? "").toLowerCase())) return out;
  for (let i = 1; i < words.length; i += 1) {
    const t = words[i] ?? "";
    if (t.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue; // a flag or KEY=val, not the command
    for (const b of binaryBasenames(t)) out.push([b, ...words.slice(i + 1)].join(" "));
  }
  return out;
}

/** Sub-commands of a shell line (mirrors classifyBash's separators), each with
 *  leading env assignments stripped and the binary basename-normalized, plus the
 *  whole line. */
function bashSegments(command: string): string[] {
  const out = new Set<string>([command.trim()]);
  for (const seg of command.split(BASH_SEPARATORS)) {
    let words = seg.trim().split(/\s+/).filter(Boolean);
    while (words.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words = words.slice(1);
    if (words.length === 0) continue;
    for (const cmd of normalizeBashWords(words)) out.add(cmd);
  }
  return [...out];
}

/** Does a rule match a tool call (by canonical tool + the call summary)? `strict`
 *  (used for allow rules) refuses to match a chained bash command. */
export function matchRule(rule: Rule, toolName: string, summary: string, strict = false): boolean {
  if (rule.tool !== "*" && rule.tool !== canonicalTool(toolName)) return false;
  if (rule.match === null) return true; // bare tool = any args (an explicit broad grant)
  return matchCandidates(canonicalTool(toolName), summary, strict).some((c) => rule.match!.test(c));
}

/**
 * Evaluate the rule set against a call. Precedence is deny → ask → allow; the
 * first matching list wins. Returns the matched rule + effect, or undefined when
 * nothing matches (caller falls back to the mode gate). Allow is matched
 * strictly (a pattern allow rule won't match a chained bash command), so a
 * narrow allow can't auto-approve a dangerous tail.
 */
export function evaluateRules(
  toolName: string,
  summary: string,
  rules: CompiledRules,
): { effect: RuleEffect; rule: Rule } | undefined {
  for (const effect of ["deny", "ask", "allow"] as const) {
    const hit = rules[effect].find((r) => matchRule(r, toolName, summary, effect === "allow"));
    if (hit) return { effect, rule: hit };
  }
  return undefined;
}
