import { isAIMessage, type BaseMessage } from "@langchain/core/messages";
import type { TokenUsage } from "./events.js";

export function totalUsage(messages: BaseMessage[]): TokenUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const m of messages) {
    if (isAIMessage(m) && m.usage_metadata) {
      inputTokens += m.usage_metadata.input_tokens ?? 0;
      outputTokens += m.usage_metadata.output_tokens ?? 0;
    }
  }
  return { inputTokens, outputTokens };
}

/** USD per 1M tokens, [input, output]. Approximate published prices; used for display only. */
const PRICES: Array<[RegExp, [number, number]]> = [
  [/gpt-5\.5/i, [5, 30]],
  [/gpt-5/i, [1.25, 10]],
  [/claude.*(opus)/i, [15, 75]],
  [/claude.*(sonnet)/i, [3, 15]],
  [/claude.*(haiku)/i, [1, 5]],
];

export function estimateCostUsd(modelLabel: string, usage: TokenUsage): number | undefined {
  for (const [re, [inP, outP]] of PRICES) {
    if (re.test(modelLabel)) {
      return (usage.inputTokens * inP + usage.outputTokens * outP) / 1_000_000;
    }
  }
  return undefined;
}

export function formatUsage(modelLabel: string, usage: TokenUsage): string {
  const cost = estimateCostUsd(modelLabel, usage);
  const base = `tokens: ${usage.inputTokens} in / ${usage.outputTokens} out`;
  return cost === undefined ? base : `${base} (~$${cost.toFixed(4)})`;
}
