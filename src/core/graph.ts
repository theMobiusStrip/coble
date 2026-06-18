import {
  AIMessageChunk,
  SystemMessage,
  ToolMessage,
  isAIMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { concat } from "@langchain/core/utils/stream";
import {
  Annotation,
  END,
  MessagesAnnotation,
  START,
  StateGraph,
  interrupt,
  type BaseCheckpointSaver,
  type LangGraphRunnableConfig,
} from "@langchain/langgraph";
import {
  classifyToolCall,
  decideCall,
  summarizeCall,
  type ApprovalPolicy,
} from "./approval.js";
import { classifyAction } from "./autoMode.js";
import type { AgentEvent, PendingCall } from "./events.js";
import { systemPrompt, wrapUntrusted, wrapUntrustedError } from "./prompts.js";
import { capOutput } from "./tools/bash.js";

export const AgentState = Annotation.Root({
  ...MessagesAnnotation.spec,
  steps: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
});

export type AgentStateT = typeof AgentState.State;

export interface AuditEntry {
  ts: string;
  tool: string;
  summary: string;
  tier: string;
  decision: "auto" | "approved" | "denied" | "error";
  detail?: string;
}

/** Payload carried by interrupt() to the approval handler. */
export interface ApprovalRequest {
  calls: PendingCall[];
}

/** Resume value supplied back through Command({ resume }). */
export interface ApprovalResponse {
  /** Per-call-id approval decisions. Missing id ⇒ denied. */
  decisions: Record<string, boolean>;
}

export interface GraphDeps {
  model: BaseChatModel;
  tools: StructuredToolInterface[];
  policy: ApprovalPolicy;
  cwd: string;
  emit: (event: AgentEvent) => void;
  audit?: (entry: AuditEntry) => void;
  checkpointer?: BaseCheckpointSaver;
  /** When true, calls exceeding policy pause via interrupt() for human approval.
   *  When false, they are denied inline (headless default). */
  interactive?: boolean;
  /** Classifier model used by `auto` mode to judge would-prompt calls. */
  classifierModel?: BaseChatModel;
  systemExtra?: string;
  maxSteps?: number;
}

export const DEFAULT_MAX_STEPS = 40;

export function buildGraph(deps: GraphDeps) {
  const { model, tools, policy, cwd, emit, audit } = deps;
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const bound = typeof model.bindTools === "function" ? model.bindTools(tools) : model;

  const agentNode = async (state: AgentStateT, config: LangGraphRunnableConfig) => {
    const input = [new SystemMessage(systemPrompt(cwd, deps.systemExtra)), ...state.messages];
    // Stream so the UI gets tokens as they arrive; aggregate into one message.
    const stream = await bound.stream(input, config);
    let response: AIMessageChunk | undefined;
    for await (const chunk of stream) {
      if (typeof chunk.content === "string" && chunk.content.length > 0) {
        emit({ type: "token", text: chunk.content });
      }
      response = response === undefined ? chunk : concat(response, chunk);
    }
    if (response === undefined) throw new Error("model produced no output");
    const text = typeof response.content === "string" ? response.content : "";
    emit({
      type: "model_end",
      text,
      toolCallCount: response.tool_calls?.length ?? 0,
      usage: response.usage_metadata
        ? {
            inputTokens: response.usage_metadata.input_tokens ?? 0,
            outputTokens: response.usage_metadata.output_tokens ?? 0,
          }
        : undefined,
    });
    return { messages: [response], steps: state.steps + 1 };
  };

  const toolsNode = async (state: AgentStateT, config: LangGraphRunnableConfig) => {
    const last = state.messages.at(-1);
    if (last === undefined || !isAIMessage(last)) return { messages: [] };

    // Correlate each call by its array index (`key`) — always unique even if the
    // model emits duplicate tool-call ids — so a decision (approval/verdict) can
    // never leak across calls. The provider-facing `callId` is echoed back
    // UNCHANGED on the ToolMessage; rewriting it would reference an id absent from
    // the assistant message, which chat providers reject.
    const calls = (last.tool_calls ?? []).map((call, i) => ({
      call,
      key: String(i),
      callId: call.id ?? `call_${i}`,
      tier: classifyToolCall(call.name, call.args),
      summary: summarizeCall(call.name, call.args),
    }));

    // Phase 1 — decide each call (rules → mode). Only calls that need a HUMAN
    // pause the graph via interrupt() here, BEFORE any tool runs (the node
    // re-executes from the top on resume, so no tool side effect — and no
    // nondeterministic model call — may precede the interrupt). Headless denies
    // them. The `auto`-mode classifier is deliberately NOT run here: it runs in
    // Phase 2 (post-interrupt), so it executes exactly once and can't be
    // re-judged across a resume.
    type Resolved = { action: "run" | "deny"; reason: string; approved?: boolean };
    const decision = new Map<string, ReturnType<typeof decideCall>>();
    for (const c of calls) decision.set(c.key, decideCall(c.call.name, c.call.args, c.tier, policy));
    const askCalls = calls.filter((c) => decision.get(c.key)?.outcome === "ask");

    const humanApproved = new Map<string, boolean>();
    if (askCalls.length > 0) {
      if (deps.interactive) {
        const request: ApprovalRequest = {
          calls: askCalls.map<PendingCall>((c) => ({ id: c.key, name: c.call.name, summary: c.summary, tier: c.tier })),
        };
        const response = interrupt(request) as ApprovalResponse | undefined;
        for (const c of askCalls) humanApproved.set(c.key, response?.decisions?.[c.key] === true);
      } else {
        for (const c of askCalls) humanApproved.set(c.key, false);
      }
    }

    // Phase 2 — resolve + execute (runs once, post-approval). The classifier
    // runs here so its verdict isn't recomputed across an interrupt/resume.
    const results: ToolMessage[] = [];
    for (const { call, key, callId, tier, summary } of calls) {
      const dec = decision.get(key) ?? { outcome: "deny" as const, reason: "no decision" };
      let d: Resolved;
      if (dec.outcome === "auto") {
        d = { action: "run", reason: dec.reason };
      } else if (dec.outcome === "ask") {
        d = humanApproved.get(key)
          ? { action: "run", reason: "user approved", approved: true }
          : { action: "deny", reason: deps.interactive ? "user denied approval" : `"${tier}"-tier call requires approval (headless)` };
      } else if (dec.outcome === "classify") {
        const verdict = await classifyAction({
          model: deps.classifierModel,
          history: state.messages,
          call: { name: call.name, summary, args: call.args as Record<string, unknown> },
          signal: config.signal,
        });
        // Fail closed: a block OR any classifier error denies (the agent adapts).
        d = verdict.allow
          ? { action: "run", reason: `auto:allow ${verdict.reason}` }
          : { action: "deny", reason: `${verdict.errored ? "auto:error" : "auto:block"} ${verdict.reason}` };
      } else {
        d = { action: "deny", reason: dec.reason };
      }

      if (d.action === "deny") {
        emit({ type: "tool_denied", name: call.name, input: summary, reason: d.reason });
        audit?.({ ts: new Date().toISOString(), tool: call.name, summary, tier, decision: "denied", detail: d.reason });
        results.push(
          new ToolMessage({
            tool_call_id: callId,
            name: call.name,
            content: `DENIED (${d.reason}): this ${tier}-tier call was not executed. Do not retry the identical call; adapt your approach or finish with an explanation.`,
            status: "error",
          }),
        );
        continue;
      }

      const t = toolMap.get(call.name);
      if (t === undefined) {
        results.push(
          new ToolMessage({
            tool_call_id: callId,
            name: call.name,
            content: `ERROR: unknown tool "${call.name}"`,
            status: "error",
          }),
        );
        continue;
      }

      emit({ type: "tool_start", name: call.name, input: summary, tier });
      const startedAt = Date.now();
      try {
        const raw: unknown = await t.invoke(call.args as never, config);
        const text = typeof raw === "string" ? raw : JSON.stringify(raw);
        emit({ type: "tool_end", name: call.name, ok: true, output: text, ms: Date.now() - startedAt });
        audit?.({
          ts: new Date().toISOString(),
          tool: call.name,
          summary,
          tier,
          decision: d.approved ? "approved" : "auto",
          detail: d.reason,
        });
        results.push(
          new ToolMessage({
            tool_call_id: callId,
            name: call.name,
            content: wrapUntrusted(call.name, capOutput(text)),
          }),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit({ type: "tool_end", name: call.name, ok: false, output: message, ms: Date.now() - startedAt });
        audit?.({ ts: new Date().toISOString(), tool: call.name, summary, tier, decision: "error", detail: message });
        results.push(
          new ToolMessage({
            tool_call_id: callId,
            name: call.name,
            content: `ERROR: ${wrapUntrustedError(call.name, capOutput(message))}`,
            status: "error",
          }),
        );
      }
    }
    return { messages: results };
  };

  const route = (state: AgentStateT): "tools" | typeof END => {
    if (state.steps >= maxSteps) return END;
    const last = state.messages.at(-1);
    if (last !== undefined && isAIMessage(last) && (last.tool_calls?.length ?? 0) > 0) return "tools";
    return END;
  };

  return new StateGraph(AgentState)
    .addNode("agent", agentNode)
    .addNode("tools", toolsNode)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", route, ["tools", END])
    .addEdge("tools", "agent")
    .compile({ checkpointer: deps.checkpointer });
}
