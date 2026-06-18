import { HumanMessage, isAIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { Command, MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { DEFAULT_POLICY, type ApprovalPolicy } from "./approval.js";
import { totalUsage } from "./cost.js";
import type { AgentEvent, PendingCall } from "./events.js";
import { buildGraph, DEFAULT_MAX_STEPS, type ApprovalRequest, type ApprovalResponse, type AuditEntry } from "./graph.js";
import { AsyncQueue } from "./queue.js";
import { noopSandbox, type Sandbox } from "./sandbox.js";
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
  /** Additional tools (e.g. git/PR) appended to the core toolset. */
  extraTools?: StructuredToolInterface[];
  systemExtra?: string;
  maxSteps?: number;
  audit?: (entry: AuditEntry) => void;
  signal?: AbortSignal;
  /** OS sandbox confining bash/git subprocesses. Default: no-op passthrough.
   *  Lifecycle (init/dispose) is owned here, once per run. */
  sandbox?: Sandbox;
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
 * Bare greetings get an instant reply without an API round-trip — exact
 * normalized match only. Topic routing deliberately does NOT live here:
 * prompt-text matching can't tell a question that needs live external data
 * from a workspace task that happens to use the same words, so every other
 * input goes to the model.
 */
function quickDirectResponse(prompt: string | undefined): string | undefined {
  const normalized = (prompt ?? "")
    .trim()
    .toLowerCase()
    .replace(/[.!?。！？]+$/u, "")
    .replace(/\s+/g, " ");
  const greetings = new Set(["hi", "hello", "hey", "hi there", "hello there", "hey there", "你好", "您好", "嗨", "哈喽"]);
  if (greetings.has(normalized)) return "Hi. What would you like to work on?";

  return undefined;
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
  const sandbox = opts.sandbox ?? noopSandbox();

  const app = buildGraph({
    model: opts.model,
    tools: [...makeCoreTools({ cwd: opts.cwd, sandbox }), ...(opts.extraTools ?? [])],
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
      const quick = opts.resume ? undefined : quickDirectResponse(opts.prompt);
      if (quick !== undefined) {
        emit({ type: "token", text: quick });
        emit({ type: "model_end", text: quick, toolCallCount: 0, usage: { inputTokens: 0, outputTokens: 0 } });
        queue.push({ type: "final", text: quick, steps: 0, usage: { inputTokens: 0, outputTokens: 0 } });
        queue.close();
        return;
      }

      // Stand up the OS boundary once for the whole run (the egress proxy is
      // expensive to start, so never per-call). dispose() runs in finally.
      await sandbox.init();

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
      const capped = out.steps >= (opts.maxSteps ?? DEFAULT_MAX_STEPS);
      queue.push({ type: "final", text, steps: out.steps, usage: totalUsage(out.messages), capped });
      queue.close();
    } catch (err) {
      if (opts.signal?.aborted) {
        queue.push({ type: "interrupted", calls: [] });
      } else {
        queue.push({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
      queue.close();
    } finally {
      // Headless runs are one-shot, so tear down here. Interactive sessions
      // reuse the sandbox across prompts (init() is idempotent); the caller
      // (the TUI) disposes it once on exit, avoiding per-turn proxy churn.
      if (!interactive) await sandbox.dispose();
    }
  })();

  return queue;
}
