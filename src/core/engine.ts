import { HumanMessage } from "@langchain/core/messages";
import { isAIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { DEFAULT_POLICY, type ApprovalPolicy } from "./approval.js";
import { totalUsage } from "./cost.js";
import type { AgentEvent } from "./events.js";
import { buildGraph, type AuditEntry } from "./graph.js";
import { AsyncQueue } from "./queue.js";
import { makeCoreTools } from "./tools/index.js";

export interface EngineOptions {
  prompt: string;
  cwd: string;
  model: BaseChatModel;
  policy?: ApprovalPolicy;
  checkpointer?: BaseCheckpointSaver;
  threadId?: string;
  systemExtra?: string;
  maxSteps?: number;
  audit?: (entry: AuditEntry) => void;
  signal?: AbortSignal;
}

/**
 * Run one agent task, yielding UI-agnostic events as it progresses.
 * The graph executes in the background; events flow through an async queue
 * so the consumer (print mode, Ink TUI, eval runner) just iterates.
 */
export function runAgent(opts: EngineOptions): AsyncIterable<AgentEvent> {
  const queue = new AsyncQueue<AgentEvent>();
  const emit = (e: AgentEvent) => queue.push(e);

  const app = buildGraph({
    model: opts.model,
    tools: makeCoreTools({ cwd: opts.cwd }),
    policy: opts.policy ?? DEFAULT_POLICY,
    cwd: opts.cwd,
    emit,
    audit: opts.audit,
    checkpointer: opts.checkpointer,
    systemExtra: opts.systemExtra,
    maxSteps: opts.maxSteps,
  });

  const config = {
    configurable: { thread_id: opts.threadId ?? "oneshot" },
    recursionLimit: 150,
    signal: opts.signal,
  };

  void (async () => {
    try {
      const finalState = await app.invoke({ messages: [new HumanMessage(opts.prompt)] }, config);
      const last = finalState.messages.at(-1);
      const text =
        last !== undefined && isAIMessage(last) && typeof last.content === "string" ? last.content : "";
      queue.push({
        type: "final",
        text,
        steps: finalState.steps,
        usage: totalUsage(finalState.messages),
      });
      queue.close();
    } catch (err) {
      queue.push({ type: "error", message: err instanceof Error ? err.message : String(err) });
      queue.close();
    }
  })();

  return queue;
}
