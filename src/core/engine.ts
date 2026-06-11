import { HumanMessage, isAIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { Command, MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph";
import { DEFAULT_POLICY, type ApprovalPolicy } from "./approval.js";
import { totalUsage } from "./cost.js";
import type { AgentEvent, PendingCall } from "./events.js";
import { buildGraph, type ApprovalRequest, type ApprovalResponse, type AuditEntry } from "./graph.js";
import { AsyncQueue } from "./queue.js";
import { makeCoreTools } from "./tools/index.js";

/** Called when the run pauses for human approval; resolves to per-call decisions. */
export type ApprovalHandler = (calls: PendingCall[]) => Promise<Record<string, boolean>>;

export interface EngineOptions {
  /** Task text for a fresh run. Ignored when `resume` is true. */
  prompt?: string;
  cwd: string;
  model: BaseChatModel;
  policy?: ApprovalPolicy;
  checkpointer?: BaseCheckpointSaver;
  threadId?: string;
  /** Continue an existing thread from its last checkpoint instead of starting fresh. */
  resume?: boolean;
  /** Provide to enable human-in-the-loop approval of policy-exceeding calls. */
  onApproval?: ApprovalHandler;
  systemExtra?: string;
  maxSteps?: number;
  audit?: (entry: AuditEntry) => void;
  signal?: AbortSignal;
}

interface InterruptEnvelope {
  __interrupt__?: Array<{ id: string; value: ApprovalRequest }>;
}

function extractApproval(out: unknown): { calls: PendingCall[] } | undefined {
  const env = out as InterruptEnvelope;
  const first = env.__interrupt__?.[0];
  return first ? { calls: first.value.calls } : undefined;
}

/**
 * Run one agent task, yielding UI-agnostic events. The graph executes in the
 * background; on each interrupt (approval pause) we surface the pending calls,
 * await the handler's decision, and resume with a Command — looping until the
 * graph finishes.
 */
export function runAgent(opts: EngineOptions): AsyncIterable<AgentEvent> {
  const queue = new AsyncQueue<AgentEvent>();
  const emit = (e: AgentEvent) => queue.push(e);

  const interactive = opts.onApproval !== undefined;
  // interrupt() needs a checkpointer; supply an ephemeral one for interactive
  // runs that didn't bring their own.
  const checkpointer = opts.checkpointer ?? (interactive ? new MemorySaver() : undefined);

  const app = buildGraph({
    model: opts.model,
    tools: makeCoreTools({ cwd: opts.cwd }),
    policy: opts.policy ?? DEFAULT_POLICY,
    cwd: opts.cwd,
    emit,
    audit: opts.audit,
    checkpointer,
    interactive,
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
      let input: unknown = opts.resume ? null : { messages: [new HumanMessage(opts.prompt ?? "")] };
      let out = await app.invoke(input as never, config);

      // Drive the approval loop: pause → ask → resume, until no interrupt remains.
      for (let pending = extractApproval(out); pending !== undefined; pending = extractApproval(out)) {
        emit({ type: "approval_required", calls: pending.calls });
        const decisions = opts.onApproval
          ? await opts.onApproval(pending.calls)
          : Object.fromEntries(pending.calls.map((c) => [c.id, false]));
        const response: ApprovalResponse = { decisions };
        out = await app.invoke(new Command({ resume: response }) as never, config);
      }

      const last = out.messages.at(-1);
      const text =
        last !== undefined && isAIMessage(last) && typeof last.content === "string" ? last.content : "";
      queue.push({ type: "final", text, steps: out.steps, usage: totalUsage(out.messages) });
      queue.close();
    } catch (err) {
      if (opts.signal?.aborted) {
        queue.push({ type: "interrupted", calls: [] });
      } else {
        queue.push({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
      queue.close();
    }
  })();

  return queue;
}
