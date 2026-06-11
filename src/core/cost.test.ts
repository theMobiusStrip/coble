import { describe, expect, it } from "vitest";
import { estimateCostUsd, formatUsage } from "./cost.js";

describe("cost estimation", () => {
  it("prices gpt-5.5 at $5/$30 per 1M", () => {
    const cost = estimateCostUsd("openai:gpt-5.5", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(35, 5);
  });

  it("prices claude sonnet at $3/$15 per 1M", () => {
    const cost = estimateCostUsd("anthropic:claude-sonnet-4-6", { inputTokens: 1_000_000, outputTokens: 0 });
    expect(cost).toBeCloseTo(3, 5);
  });

  it("returns undefined for unpriced models (e.g. local ollama)", () => {
    expect(estimateCostUsd("ollama:llama3.1", { inputTokens: 100, outputTokens: 100 })).toBeUndefined();
  });

  it("formats with and without a price", () => {
    expect(formatUsage("openai:gpt-5.5", { inputTokens: 100, outputTokens: 50 })).toContain("~$");
    expect(formatUsage("scripted:x", { inputTokens: 100, outputTokens: 50 })).not.toContain("~$");
  });
});
