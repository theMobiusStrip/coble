import type { DangerTier } from "../core/events.js";

/** Pretty, capitalized tool labels (Claude Code style): bash → Bash. */
const TOOL_LABELS: Record<string, string> = {
  bash: "Bash",
  read_file: "Read",
  write_file: "Write",
  edit_file: "Edit",
  git_branch: "Branch",
  git_commit: "Commit",
  git_push: "Push",
  create_pull_request: "PR",
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

/** Compact a model label for display: scripted file paths → provider:basename. */
export function shortModel(label: string): string {
  const slash = label.lastIndexOf("/");
  if (slash === -1) return label;
  const provider = label.includes(":") ? `${label.slice(0, label.indexOf(":"))}:` : "";
  return provider + label.slice(slash + 1);
}

export const TIER_COLOR: Record<DangerTier, string> = {
  safe: "green",
  confirm: "yellow",
  dangerous: "red",
};

/** First N non-empty lines of tool output, with an overflow marker. */
export function previewLines(output: string, maxLines = 4): string[] {
  const lines = output.replace(/\s+$/, "").split("\n");
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines), `… +${lines.length - maxLines} lines`];
}
