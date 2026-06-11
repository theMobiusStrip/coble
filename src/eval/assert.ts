import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import type { AgentEvent } from "../core/events.js";
import type { AuditEntry } from "../core/graph.js";
import type { Assertion } from "./types.js";

/** Everything observed during a task run, fed to the assertion evaluator. */
export interface RunCapture {
  cwd: string;
  events: AgentEvent[];
  audit: AuditEntry[];
  finalText: string;
}

function readMaybe(cwd: string, p: string): string | null {
  try {
    return readFileSync(path.join(cwd, p), "utf8");
  } catch {
    return null;
  }
}

function toolsCalled(events: AgentEvent[]): Set<string> {
  return new Set(events.filter((e) => e.type === "tool_start").map((e) => (e as { name: string }).name));
}

function toolsDenied(events: AgentEvent[]): Set<string> {
  return new Set(events.filter((e) => e.type === "tool_denied").map((e) => (e as { name: string }).name));
}

async function gitInfo(cwd: string): Promise<{ branch: string; head: string }> {
  const branch = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, reject: false });
  const head = await execa("git", ["log", "-1", "--pretty=%s"], { cwd, reject: false });
  return { branch: (branch.stdout ?? "").trim(), head: (head.stdout ?? "").trim() };
}

function needsGit(assertions: Assertion[]): boolean {
  return assertions.some((a) => a.git_current_branch !== undefined || a.git_head_contains !== undefined);
}

/** Evaluate all assertions; return a list of human-readable failure messages (empty ⇒ pass). */
export async function evaluate(assertions: Assertion[], cap: RunCapture): Promise<string[]> {
  const failures: string[] = [];
  const called = toolsCalled(cap.events);
  const denied = toolsDenied(cap.events);
  const steps = cap.events.filter((e) => e.type === "tool_start").length;
  const git = needsGit(assertions) ? await gitInfo(cap.cwd) : { branch: "", head: "" };

  for (const a of assertions) {
    if (a.file_exists !== undefined) {
      if (!existsSync(path.join(cap.cwd, a.file_exists))) failures.push(`expected file to exist: ${a.file_exists}`);
    }
    if (a.file_absent !== undefined) {
      if (existsSync(path.join(cap.cwd, a.file_absent))) failures.push(`expected file to be absent: ${a.file_absent}`);
    }
    if (a.file_contains !== undefined) {
      const c = readMaybe(cap.cwd, a.file_contains.path);
      if (c === null) failures.push(`file missing for contains check: ${a.file_contains.path}`);
      else if (!c.includes(a.file_contains.text)) failures.push(`${a.file_contains.path} does not contain "${a.file_contains.text}"`);
    }
    if (a.file_regex !== undefined) {
      const c = readMaybe(cap.cwd, a.file_regex.path);
      if (c === null) failures.push(`file missing for regex check: ${a.file_regex.path}`);
      else if (!new RegExp(a.file_regex.pattern).test(c)) failures.push(`${a.file_regex.path} does not match /${a.file_regex.pattern}/`);
    }
    if (a.final_contains !== undefined) {
      if (!cap.finalText.includes(a.final_contains)) failures.push(`final answer does not contain "${a.final_contains}"`);
    }
    if (a.final_regex !== undefined) {
      if (!new RegExp(a.final_regex).test(cap.finalText)) failures.push(`final answer does not match /${a.final_regex}/`);
    }
    if (a.tool_called !== undefined) {
      if (!called.has(a.tool_called)) failures.push(`expected tool to be called: ${a.tool_called}`);
    }
    if (a.tool_not_called !== undefined) {
      if (called.has(a.tool_not_called)) failures.push(`expected tool NOT to be called: ${a.tool_not_called}`);
    }
    if (a.tool_denied !== undefined) {
      if (!denied.has(a.tool_denied)) failures.push(`expected tool to be denied: ${a.tool_denied}`);
    }
    if (a.audit_decision !== undefined) {
      const hit = cap.audit.some((e) => e.tool === a.audit_decision!.tool && e.decision === a.audit_decision!.decision);
      if (!hit) failures.push(`expected audit ${a.audit_decision.tool}=${a.audit_decision.decision}`);
    }
    if (a.git_current_branch !== undefined) {
      if (git.branch !== a.git_current_branch) failures.push(`expected branch ${a.git_current_branch}, got ${git.branch}`);
    }
    if (a.git_head_contains !== undefined) {
      if (!git.head.includes(a.git_head_contains)) failures.push(`HEAD message lacks "${a.git_head_contains}" (got "${git.head}")`);
    }
    if (a.max_steps !== undefined) {
      if (steps > a.max_steps) failures.push(`expected ≤${a.max_steps} tool steps, got ${steps}`);
    }
  }
  return failures;
}
