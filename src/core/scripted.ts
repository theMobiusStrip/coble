import { readFile } from "node:fs/promises";
import {
  BaseChatModel,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";

export interface ScriptToolCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

/** One scripted model reply: plain content, tool calls, or both. */
export interface ScriptTurn {
  content?: string;
  toolCalls?: ScriptToolCall[];
  /** If set, the model throws with this message instead of replying — simulates a crash mid-run. */
  crash?: string;
}

/**
 * Deterministic stand-in for a chat model. Replays a fixed list of turns,
 * regardless of input. Powers unit tests and the free, deterministic CI eval
 * mode; it exercises the full graph/tool/approval machinery without an API key.
 */
export class ScriptedChatModel extends BaseChatModel {
  private readonly turns: ScriptTurn[];
  private cursor = 0;

  constructor(turns: ScriptTurn[], params: BaseChatModelParams = {}) {
    super(params);
    this.turns = turns;
  }

  _llmType(): string {
    return "scripted";
  }

  override bindTools(): this {
    return this;
  }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const turn = this.turns[this.cursor] ?? { content: "script exhausted — stopping." };
    this.cursor += 1;
    if (turn.crash) throw new Error(turn.crash);
    const content = turn.content ?? "";
    const message = new AIMessage({
      content,
      tool_calls: (turn.toolCalls ?? []).map((c, i) => ({
        name: c.name,
        args: c.args,
        id: c.id ?? `scripted_${this.cursor}_${i}`,
        type: "tool_call" as const,
      })),
      usage_metadata: {
        input_tokens: 100,
        output_tokens: 25,
        total_tokens: 125,
      },
    });
    return { generations: [{ message, text: content }] };
  }

  /**
   * Streaming variant: one chunk per turn. Needed because the agent node
   * consumes models via .stream(), and the default fallback would drop
   * tool_calls when converting AIMessage → AIMessageChunk.
   */
  override async *_streamResponseChunks(
    _messages: BaseMessage[],
  ): AsyncGenerator<ChatGenerationChunk> {
    const turn = this.turns[this.cursor] ?? { content: "script exhausted — stopping." };
    this.cursor += 1;
    if (turn.crash) throw new Error(turn.crash);
    const content = turn.content ?? "";
    const message = new AIMessageChunk({
      content,
      tool_call_chunks: (turn.toolCalls ?? []).map((c, i) => ({
        name: c.name,
        args: JSON.stringify(c.args),
        id: c.id ?? `scripted_${this.cursor}_${i}`,
        index: i,
        type: "tool_call_chunk" as const,
      })),
      usage_metadata: {
        input_tokens: 100,
        output_tokens: 25,
        total_tokens: 125,
      },
    });
    yield new ChatGenerationChunk({ message, text: content });
  }
}

export async function loadScript(filePath: string): Promise<ScriptTurn[]> {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`script file must be a JSON array of turns: ${filePath}`);
  return parsed as ScriptTurn[];
}
