import type { PermissionMode } from "../core/approval.js";
import type { ScriptTurn } from "../core/scripted.js";

/** A single declarative assertion. Exactly one key is set. */
export interface Assertion {
  file_exists?: string;
  file_absent?: string;
  file_contains?: { path: string; text: string };
  file_regex?: { path: string; pattern: string };
  final_contains?: string;
  final_regex?: string;
  tool_called?: string;
  tool_not_called?: string;
  tool_denied?: string;
  audit_decision?: { tool: string; decision: string };
  git_current_branch?: string;
  git_head_contains?: string;
  max_steps?: number;
}

export interface EvalTask {
  id: string;
  description: string;
  /** Prompt used when running against a real model. */
  prompt: string;
  /** Deterministic model script used in scripted (CI) mode. */
  script: ScriptTurn[];
  /** Extra toolsets to enable, e.g. "git". */
  tools?: Array<"git">;
  /** Permission mode for the run (default: "default"). */
  mode?: PermissionMode;
  /** Allow/ask/deny rule patterns to apply during the run. */
  rules?: { allow?: string[]; ask?: string[]; deny?: string[] };
  /** Approval behaviour for policy-exceeding calls during the run. */
  approve?: "all" | "none";
  fixture?: {
    files?: Record<string, string>;
    /** Initialise a git repo (and commit the fixture files). */
    git?: boolean;
  };
  assert: Assertion[];
}

export interface EvalResult {
  id: string;
  description: string;
  pass: boolean;
  failures: string[];
  steps: number;
  usage: { inputTokens: number; outputTokens: number };
  costUsd?: number;
  ms: number;
}
