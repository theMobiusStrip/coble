import type { DangerTier } from "./events.js";
import { emptyRules, evaluateRules, type CompiledRules } from "./permissionRules.js";

/** Permission modes — presets over the danger-tier gate, plus the read-only
 *  `plan` mode and the model-judged `auto` mode. */
export const PERMISSION_MODES = ["plan", "default", "careful", "auto", "bypass"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * Danger tiers:
 *  - safe:      read-only
 *  - confirm:   workspace writes
 *  - dangerous: arbitrary shell, push, PR
 */
export interface TierPolicy {
  /** Highest tier that may run without asking. */
  autoTier: "safe" | "confirm";
  /** Approve dangerous calls without asking (bypass mode / --dangerously-allow). */
  dangerouslyAllow: boolean;
}

export interface ApprovalPolicy extends TierPolicy {
  /** Active permission mode (drives the tier preset + auto-mode classifier routing). */
  mode: PermissionMode;
  /** User-authored allow/ask/deny rules, evaluated before the mode gate. */
  rules: CompiledRules;
}

/** Tier preset each mode compiles to. `plan` is handled explicitly in decideCall
 *  (it blocks rather than prompts), so its preset is only a safe-only floor. */
const MODE_TIERS: Record<PermissionMode, TierPolicy> = {
  plan: { autoTier: "safe", dangerouslyAllow: false },
  default: { autoTier: "confirm", dangerouslyAllow: false },
  careful: { autoTier: "safe", dangerouslyAllow: false },
  auto: { autoTier: "safe", dangerouslyAllow: false },
  bypass: { autoTier: "confirm", dangerouslyAllow: true },
};

/** Build a full policy for a mode (+ optional rules). */
export function policyForMode(mode: PermissionMode, rules: CompiledRules = emptyRules()): ApprovalPolicy {
  return { mode, ...MODE_TIERS[mode], rules };
}

export const DEFAULT_POLICY: ApprovalPolicy = policyForMode("default");

const TIER_ORDER: Record<DangerTier, number> = { safe: 0, confirm: 1, dangerous: 2 };

export function tierExceeds(tier: DangerTier, policy: TierPolicy): boolean {
  if (policy.dangerouslyAllow) return false;
  return TIER_ORDER[tier] > TIER_ORDER[policy.autoTier];
}

/** Binaries that are safe to run without approval (read-only, no side effects).
 *  `env` is deliberately ABSENT: `env <cmd>` executes <cmd>, so allowlisting it
 *  would downgrade any command to "safe" (the env-prefix bypass). */
const SAFE_BINARIES = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "rg", "echo", "pwd", "stat",
  "file", "du", "df", "sort", "uniq", "cut", "tr", "which", "date",
  "basename", "dirname", "true", "false", "uname", "find", "diff",
]);

const SAFE_GIT_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "ls-files", "rev-parse", "branch",
  "remote", "shortlog", "blame", "tag", "describe", "config",
]);

/** Anything that lets `find` mutate or execute is not read-only. */
const FIND_MUTATING = /-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls|fprint0)\b/;

/**
 * Per-binary flags that turn an otherwise read-only binary into one that writes
 * a file, runs another program, or mutates state (argument injection). Matched
 * against each argument token; short clusters like `-bo` are caught by the
 * `-[a-z]*<letter>` form.
 */
const DANGEROUS_FLAGS: Record<string, RegExp> = {
  // `sort -o FILE` / `--output=FILE` writes a file; `--compress-program=PROG`
  // runs PROG to (de)compress spill files (arbitrary exec on GNU sort).
  sort: /^(--output(=|$)|--compress-program(=|$)|-[a-z]*o)/,
  // `date -s` / `--set` changes the system clock.
  date: /^(--set(=|$)|-[a-z]*s)/,
  // ripgrep runs external programs: `--pre` (per-file preprocessor),
  // `--hostname-bin`, and `-z`/`--search-zip` (external decompressors).
  // `--pre-glob` only scopes `--pre`, so flagging `--pre` alone suffices.
  rg: /^(--pre(=|$)|--hostname-bin(=|$)|--search-zip$|-[a-z]*z)/,
};

/**
 * `uniq [opts] [input [output]]` writes its second positional operand — a write
 * primitive no flag reveals. These value-taking flags consume the following
 * token, so it isn't miscounted as that operand (`uniq -f 2 input` is read-only).
 */
const UNIQ_VALUE_FLAGS = new Set([
  "-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars",
]);

/** Count positional operands, treating `-` as the stdin operand and skipping
 *  the value token after a separate-value flag. Everything after `--` is an
 *  operand. */
function countOperands(rest: string[], valueFlags: Set<string>): number {
  let operands = 0;
  let afterDoubleDash = false;
  for (let i = 0; i < rest.length; i += 1) {
    const w = rest[i] ?? "";
    if (afterDoubleDash) {
      operands += 1;
      continue;
    }
    if (w === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (w === "-") {
      operands += 1; // stdin operand
      continue;
    }
    if (w.startsWith("-")) {
      if (valueFlags.has(w)) i += 1; // its value is the next token, not an operand
      continue;
    }
    operands += 1;
  }
  return operands;
}

/**
 * Classify a shell command line. Conservative by design: anything we cannot
 * positively identify as read-only is "dangerous". Output redirection makes
 * any command mutating.
 *
 * IMPORTANT: this is defense-in-depth (it decides whether to ask the human),
 * NOT a security boundary. Allowlist-parsing of shell strings cannot keep up
 * with full shell semantics (`eval`, `xargs`, quoting, locale tricks); the OS
 * sandbox (sandbox.ts) is the layer that actually confines what runs.
 */
export function classifyBash(command: string): DangerTier {
  const trimmed = command.trim();
  if (trimmed.length === 0) return "safe";
  if (/[<>]/.test(trimmed)) return "dangerous";
  if (/\$\(|`/.test(trimmed)) return "dangerous";

  // Split on every connector the shell treats as a command boundary, so each
  // segment of a compound command is vetted independently. This includes
  // newlines and a single `&` (backgrounding) — both are shell separators the
  // old splitter missed, which let `ls\nrm -rf x` and `ls & rm x` smuggle a
  // mutating command into the "args" of a safe one. `&&` and `||` are matched
  // before the single-char `&`/`|` so they are not mis-split.
  const segments = trimmed.split(/&&|\|\||[;|&\n\r]/).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return "dangerous";

  for (const segment of segments) {
    const words = segment.split(/\s+/);
    let bin = words[0] ?? "";
    let rest = words.slice(1);
    // Skip leading env assignments like FOO=bar cmd
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(bin) && rest.length > 0) {
      bin = rest[0] ?? "";
      rest = rest.slice(1);
    }
    if (bin === "git") {
      const sub = rest.find((w) => !w.startsWith("-"));
      if (!sub || !SAFE_GIT_SUBCOMMANDS.has(sub)) return "dangerous";
      // `git config` is only safe to read, never to set
      if (sub === "config" && rest.some((w) => !w.startsWith("-") && w !== "config" && rest.indexOf(w) > rest.indexOf(sub))) {
        const args = rest.filter((w) => !w.startsWith("-"));
        if (args.length > 2) return "dangerous";
      }
      continue;
    }
    if (!SAFE_BINARIES.has(bin)) return "dangerous";
    const dangerousFlag = DANGEROUS_FLAGS[bin];
    if (dangerousFlag && rest.some((w) => dangerousFlag.test(w))) return "dangerous";
    if (bin === "uniq" && countOperands(rest, UNIQ_VALUE_FLAGS) > 1) return "dangerous";
    if (bin === "find" && FIND_MUTATING.test(segment)) return "dangerous";
  }
  return "safe";
}

/** Classify a tool call by tool name (and, for bash, by command content). */
export function classifyToolCall(name: string, args: Record<string, unknown>): DangerTier {
  switch (name) {
    case "read_file":
      return "safe";
    case "write_file":
    case "edit_file":
      return "confirm";
    case "bash":
      return classifyBash(String(args.command ?? ""));
    case "git_branch":
    case "git_commit":
    case "git_push":
    case "create_pull_request":
      return "dangerous";
    default:
      return "dangerous";
  }
}

/** One-line rendering of a tool call for transcripts and approval prompts. */
export function summarizeCall(name: string, args: Record<string, unknown>): string {
  if (name === "bash") return String(args.command ?? "");
  if (name === "read_file" || name === "write_file" || name === "edit_file") {
    return String(args.path ?? "");
  }
  if (name === "git_branch") return String(args.name ?? "");
  if (name === "git_commit") return String(args.message ?? "");
  if (name === "git_push") return String(args.branch ?? "");
  if (name === "create_pull_request") return String(args.title ?? "");
  const json = JSON.stringify(args);
  return json.length > 120 ? `${json.slice(0, 120)}…` : json;
}

/** Outcome for a single tool call after rules + mode are applied. */
export type CallDecision = {
  outcome: "auto" | "ask" | "classify" | "deny";
  /** Short reason for the audit trail. */
  reason: string;
};

/** Calls that always require a human even in `auto` mode (never the classifier):
 *  they leave the machine or are irreversibly destructive. Best-effort (full
 *  shell obfuscation can still slip past — the classifier + sandbox back it up);
 *  the goal is that a push/PR, or a recursive/force `rm` of an absolute path or
 *  home, never auto-runs — however it is spelled (structured tool or bash). */
const RM_RECURSIVE_OR_FORCE = /(^|\s)(-[a-zA-Z]*[rRfF]|--(recursive|force))\b/; // -r/-R/-f/-rf or --recursive/--force
const RM_ABS_OR_HOME = /(^|\s)(\/|~|\$\{?HOME\}?)/; // a token that is an absolute path, ~, or $HOME
function isHardPrompt(name: string, summary: string): boolean {
  if (name === "git_push" || name === "create_pull_request") return true;
  if (name !== "bash") return false;
  // Strip quotes so `rm -rf "$HOME"` / `rm -rf '/'` are caught like the bare forms.
  const s = summary.replace(/['"]/g, "");
  // Push / PR spelled as a shell command must still reach a human: the structured
  // git_push / create_pull_request tools are only added by `coble review`, so the
  // default toolset can push/PR ONLY via bash. Deliberately over-inclusive — for
  // a hard prompt, failing toward "ask the human" is the safe direction, so this
  // also catches wrappers (`sudo git push`), git global flags (`git -C r push`),
  // and chaining. Full obfuscation still falls through to the classifier + sandbox.
  if (/\bgit\b.*\bpush\b/is.test(s)) return true;
  if (/\bgh\b.*\bpr\b.*\bcreate\b/is.test(s)) return true;
  return /\brm\b/.test(s) && RM_RECURSIVE_OR_FORCE.test(s) && RM_ABS_OR_HOME.test(s);
}

/**
 * Decide what happens to one tool call: evaluate user rules first (deny → ask →
 * allow), then fall back to the mode gate. In `auto` mode a tier-`ask` becomes a
 * `classify` (the model decides) unless it is a hard-prompt action. This is the
 * single decision point the graph consumes.
 */
export function decideCall(
  name: string,
  args: Record<string, unknown>,
  tier: DangerTier,
  policy: ApprovalPolicy,
): CallDecision {
  const summary = summarizeCall(name, args);
  const hit = evaluateRules(name, summary, policy.rules);
  // deny always wins, in every mode.
  if (hit?.effect === "deny") return { outcome: "deny", reason: `rule:deny ${hit.rule.raw}` };
  // plan mode is read-only: writes/commands are blocked even if an allow/ask rule
  // matches (only a deny rule, handled above, could change this).
  if (policy.mode === "plan" && tier !== "safe") {
    return { outcome: "deny", reason: "mode:plan blocks writes/commands" };
  }
  if (hit?.effect === "ask") return { outcome: "ask", reason: `rule:ask ${hit.rule.raw}` };
  if (hit?.effect === "allow") return { outcome: "auto", reason: `rule:allow ${hit.rule.raw}` };
  if (policy.mode === "plan") return { outcome: "auto", reason: "mode:plan (read-only)" }; // tier === safe
  if (!tierExceeds(tier, policy)) return { outcome: "auto", reason: `mode:${policy.mode}` };
  if (policy.mode === "auto" && !isHardPrompt(name, summary)) {
    return { outcome: "classify", reason: "mode:auto classifier" };
  }
  return { outcome: "ask", reason: `mode:${policy.mode}` };
}
