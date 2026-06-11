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
  type BaseCheckpointSaver,
  type LangGraphRunnableConfig,
} from "@langchain/langgraph";
import {
  classifyToolCall,
  summarizeCall,
  tierExceeds,
  type ApprovalPolicy,
} from "./approval.js";
import type { AgentEvent } from "./events.js";
import { systemPrompt } from "./prompts.js";
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

export interface GraphDeps {
  model: BaseChatModel;
  tools: StructuredToolInterface[];
  policy: ApprovalPolicy;
  cwd: string;
  emit: (event: AgentEvent) => void;
  audit?: (entry: AuditEntry) => void;
  checkpointer?: BaseCheckpointSaver;
  systemExtra?: string;
  maxSteps?: number;
}

const DEFAULT_MAX_STEPS = 40;

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
    const results: ToolMessage[] = [];
    for (const call of last.tool_calls ?? []) {
      const callId = call.id ?? `call_${results.length}`;
      const tier = classifyToolCall(call.name, call.args);
      const summary = summarizeCall(call.name, call.args);

      if (tierExceeds(tier, policy)) {
        const reason = `"${tier}"-tier call requires user approval`;
        emit({ type: "tool_denied", name: call.name, input: summary, reason });
        audit?.({ ts: new Date().toISOString(), tool: call.name, summary, tier, decision: "denied" });
        results.push(
          new ToolMessage({
            tool_call_id: callId,
            name: call.name,
            content: `DENIED: this ${tier}-tier call requires user approval and was not executed. Do not retry the identical call; adapt your approach or finish with an explanation.`,
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
        audit?.({ ts: new Date().toISOString(), tool: call.name, summary, tier, decision: "auto" });
        results.push(new ToolMessage({ tool_call_id: callId, name: call.name, content: capOutput(text) }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit({ type: "tool_end", name: call.name, ok: false, output: message, ms: Date.now() - startedAt });
        audit?.({ ts: new Date().toISOString(), tool: call.name, summary, tier, decision: "error", detail: message });
        results.push(
          new ToolMessage({
            tool_call_id: callId,
            name: call.name,
            content: `ERROR: ${capOutput(message)}`,
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
