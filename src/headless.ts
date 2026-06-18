import type { StructuredToolInterface } from "@langchain/core/tools";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ApprovalPolicy } from "./core/approval.js";
import type { Sandbox } from "./core/sandbox.js";
import { openAuditLog } from "./core/audit.js";
import { openCheckpointer } from "./core/checkpointer.js";
import { formatUsage } from "./core/cost.js";
import { runAgent } from "./core/engine.js";
import { observeSession } from "./core/sessionRunner.js";
import { openSessionStore } from "./core/sessions.js";
import { auditLogPath } from "./core/store.js";
import { renderPrint } from "./print.js";

export interface HeadlessRun {
  prompt: string;
  cwd: string;
  model: BaseChatModel;
  modelLabel: string;
  policy: ApprovalPolicy;
  extraTools?: StructuredToolInterface[];
  systemExtra?: string;
  sandbox?: Sandbox;
}

/** Create a session, run a task headlessly with persistence + audit, render to stdout. */
export async function runHeadless(opts: HeadlessRun): Promise<number> {
  const store = openSessionStore();
  const audit = openAuditLog(auditLogPath());
  const session = store.create({
    cwd: opts.cwd,
    model: opts.modelLabel,
    prompt: opts.prompt,
    nowIso: new Date().toISOString(),
  });
  const events = observeSession(
    runAgent({
      prompt: opts.prompt,
      cwd: opts.cwd,
      model: opts.model,
      policy: opts.policy,
      checkpointer: openCheckpointer(),
      threadId: session.id,
      audit: audit.record,
      extraTools: opts.extraTools,
      systemExtra: opts.systemExtra,
      sandbox: opts.sandbox,
    }),
    store,
    session.id,
  );
  console.log(`\x1b[2msession ${session.id}\x1b[0m`);
  return renderPrint(events, {
    modelLabel: opts.modelLabel,
    formatUsage: (u) => formatUsage(opts.modelLabel, u),
  });
}
