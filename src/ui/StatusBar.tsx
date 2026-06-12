import { Text } from "ink";
import { estimateCostUsd } from "../core/cost.js";
import type { TokenUsage } from "../core/events.js";
import { shortModel } from "./theme.js";

export interface StatusBarProps {
  model: string;
  usage: TokenUsage;
  autoApprove?: boolean;
  toolDetail?: string;
}

function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Dim one-line footer: model · token total · estimated cost. */
export function StatusBar({ model, usage, autoApprove, toolDetail }: StatusBarProps) {
  const total = usage.inputTokens + usage.outputTokens;
  const cost = estimateCostUsd(model, usage);
  const parts = [shortModel(model), `${tokens(total)} tok`];
  if (cost !== undefined && cost > 0) parts.push(`~$${cost.toFixed(4)}`);
  if (autoApprove) parts.push("auto-approve");
  if (toolDetail) parts.push(`tools: ${toolDetail}`);
  return <Text dimColor>{` ${parts.join(" · ")}`}</Text>;
}
