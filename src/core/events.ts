export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface PendingCall {
  id: string;
  name: string;
  /** Human-readable one-line rendering of the call arguments. */
  summary: string;
  tier: DangerTier;
}

export type DangerTier = "safe" | "confirm" | "dangerous";

/** Events emitted by the engine while an agent run is in flight. */
export type AgentEvent =
  | { type: "token"; text: string }
  | { type: "model_end"; text: string; toolCallCount: number; usage?: TokenUsage }
  | { type: "tool_start"; name: string; input: string; tier: DangerTier }
  | { type: "tool_end"; name: string; ok: boolean; output: string; ms: number }
  | { type: "tool_denied"; name: string; input: string; reason: string }
  | { type: "approval_required"; calls: PendingCall[] }
  | { type: "final"; text: string; steps: number; usage: TokenUsage }
  | { type: "interrupted"; calls: PendingCall[] }
  | { type: "error"; message: string };
