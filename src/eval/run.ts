import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { memoryAuditLog } from "../core/audit.js";
import { estimateCostUsd } from "../core/cost.js";
import { DEFAULT_POLICY, policyForMode } from "../core/approval.js";
import { runAgent, type ApprovalHandler } from "../core/engine.js";
import { compileRuleList } from "../core/permissionRules.js";
import type { AgentEvent } from "../core/events.js";
import { ScriptedChatModel } from "../core/scripted.js";
import { makeGitTools } from "../core/tools/gitTools.js";
import { evaluate, type RunCapture } from "./assert.js";
import type { EvalResult, EvalTask } from "./types.js";

/** Produce the model for a task: scripted (deterministic) or a real model. */
export type ModelForTask = (task: EvalTask) => { model: BaseChatModel; label: string };

export const scriptedModelFor: ModelForTask = (task) => ({
  model: new ScriptedChatModel(task.script),
  label: "scripted",
});

const approveAll: ApprovalHandler = async (calls) => Object.fromEntries(calls.map((c) => [c.id, true]));

async function setupFixture(task: EvalTask): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), `coble-eval-${task.id}-`));
  for (const [rel, content] of Object.entries(task.fixture?.files ?? {})) {
    const abs = path.join(cwd, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  if (task.fixture?.git) {
    await execa("git", ["init", "-q", "-b", "main", "."], { cwd });
    await execa("git", ["config", "user.email", "eval@coble.dev"], { cwd });
    await execa("git", ["config", "user.name", "coble eval"], { cwd });
    await execa("git", ["config", "commit.gpgsign", "false"], { cwd });
    await execa("git", ["add", "-A"], { cwd });
    await execa("git", ["commit", "-qm", "fixture"], { cwd });
  }
  return cwd;
}

export async function runTask(task: EvalTask, modelFor: ModelForTask, nowMs: number): Promise<EvalResult> {
  const cwd = await setupFixture(task);
  const audit = memoryAuditLog();
  const events: AgentEvent[] = [];
  const { model, label } = modelFor(task);

  const extraTools = task.tools?.includes("git")
    ? makeGitTools({ cwd }, { dryRun: true, createPr: async () => "dry://pr" })
    : undefined;

  const policy =
    task.mode || task.rules
      ? policyForMode(task.mode ?? "default", {
          allow: compileRuleList(task.rules?.allow ?? [], true), // grants are case-sensitive
          ask: compileRuleList(task.rules?.ask ?? []),
          deny: compileRuleList(task.rules?.deny ?? []),
        })
      : DEFAULT_POLICY;

  try {
    const stream = runAgent({
      prompt: task.prompt,
      cwd,
      model,
      policy,
      // auto mode routes would-prompt calls to a classifier; without a model it
      // would fail closed and deny everything. Reuse the task model as the judge.
      classifierModel: policy.mode === "auto" ? model : undefined,
      onApproval: task.approve === "all" ? approveAll : undefined,
      extraTools,
      audit: audit.record,
    });

    let finalText = "";
    let steps = 0;
    let usage = { inputTokens: 0, outputTokens: 0 };
    for await (const ev of stream) {
      events.push(ev);
      if (ev.type === "final") {
        finalText = ev.text;
        steps = ev.steps;
        usage = ev.usage;
      }
    }

    const capture: RunCapture = { cwd, events, audit: audit.entries(), finalText };
    const failures = await evaluate(task.assert, capture);
    return {
      id: task.id,
      description: task.description,
      pass: failures.length === 0,
      failures,
      steps,
      usage,
      costUsd: estimateCostUsd(label, usage),
      ms: 0,
    };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

export async function runAll(tasks: EvalTask[], modelFor: ModelForTask, nowMs: number): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const task of tasks) {
    results.push(await runTask(task, modelFor, nowMs));
  }
  return results;
}
