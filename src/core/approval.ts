import type { DangerTier } from "./events.js";

/**
 * Danger tiers:
 *  - safe:      executed without asking (read-only)
 *  - confirm:   executed by default; asked first in --paranoid mode (workspace writes)
 *  - dangerous: always requires approval (arbitrary shell, push, PR)
 */
export interface ApprovalPolicy {
  /** Highest tier that may run without asking. */
  autoTier: "safe" | "confirm";
  /** Print-mode escape hatch: approve dangerous calls without asking. */
  dangerouslyAllow: boolean;
}

export const DEFAULT_POLICY: ApprovalPolicy = { autoTier: "confirm", dangerouslyAllow: false };

const TIER_ORDER: Record<DangerTier, number> = { safe: 0, confirm: 1, dangerous: 2 };

export function tierExceeds(tier: DangerTier, policy: ApprovalPolicy): boolean {
  if (policy.dangerouslyAllow) return false;
  return TIER_ORDER[tier] > TIER_ORDER[policy.autoTier];
}

/** Binaries that are safe to run without approval (read-only, no side effects). */
const SAFE_BINARIES = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "rg", "echo", "pwd", "stat",
  "file", "du", "df", "sort", "uniq", "cut", "tr", "which", "date",
  "basename", "dirname", "true", "false", "env", "uname", "find", "diff",
]);

const SAFE_GIT_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "ls-files", "rev-parse", "branch",
  "remote", "shortlog", "blame", "tag", "describe", "config",
]);

/** Anything that lets `find` mutate or execute is not read-only. */
const FIND_MUTATING = /-(delete|exec|execdir|ok|okdir)\b/;

/**
 * Classify a shell command line. Conservative by design: anything we cannot
 * positively identify as read-only is "dangerous". Output redirection makes
 * any command mutating.
 */
export function classifyBash(command: string): DangerTier {
  const trimmed = command.trim();
  if (trimmed.length === 0) return "safe";
  if (/[<>]/.test(trimmed)) return "dangerous";
  if (/\$\(|`/.test(trimmed)) return "dangerous";

  // Split on connectors so every segment of a compound command is vetted.
  const segments = trimmed.split(/&&|\|\||[;|]/).map((s) => s.trim()).filter(Boolean);
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
  const json = JSON.stringify(args);
  return json.length > 120 ? `${json.slice(0, 120)}…` : json;
}
