import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { DEFAULT_POLICY } from "../core/approval.js";
import type { AgentEvent } from "../core/events.js";
import type { EngineOptions } from "../core/engine.js";
import { App } from "./App.js";

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function* fakeRun(): AsyncGenerator<AgentEvent> {
  yield { type: "tool_start", name: "bash", input: "ls", tier: "safe" };
  yield { type: "tool_end", name: "bash", ok: true, output: "x.txt", ms: 5 };
  yield { type: "token", text: "All done." };
  yield { type: "model_end", text: "All done.", toolCallCount: 0 };
  yield { type: "final", text: "All done.", steps: 2, usage: { inputTokens: 10, outputTokens: 5 } };
}

/** Engine that asks for approval of one dangerous call, then reports the verdict. */
function approvalEngine(): (opts: EngineOptions) => AsyncIterable<AgentEvent> {
  return (opts) => {
    async function* gen(): AsyncGenerator<AgentEvent> {
      const calls = [{ id: "d1", name: "bash", summary: "rm -rf x", tier: "dangerous" as const }];
      yield { type: "approval_required", calls };
      const decisions = await opts.onApproval!(calls);
      const approved = decisions.d1 === true;
      yield { type: approved ? "tool_end" : "tool_denied", ...(approved ? { name: "bash", ok: true, output: "", ms: 1 } : { name: "bash", input: "rm -rf x", reason: "user denied approval" }) } as AgentEvent;
      const verdict = approved ? "removed" : "kept it safe";
      yield { type: "model_end", text: verdict, toolCallCount: 0 };
      yield { type: "final", text: verdict, steps: 1, usage: { inputTokens: 1, outputTokens: 1 } };
    }
    return gen();
  };
}

describe("App", () => {
  it("renders banner and input prompt", () => {
    const { lastFrame, unmount } = render(<App cwd="/tmp" policy={DEFAULT_POLICY} />);
    expect(lastFrame()).toContain("coble");
    expect(lastFrame()).toContain(">");
    unmount();
  });

  it("runs a task through an injected engine and renders the transcript", async () => {
    const resolver = async () => ({ model: {} as never, label: "fake:model" });
    const { lastFrame, stdin, unmount } = render(
      <App cwd="/tmp" policy={DEFAULT_POLICY} engine={() => fakeRun()} resolver={resolver} />,
    );
    await tick();
    stdin.write("do the thing");
    await tick();
    stdin.write("\r");
    await tick(100);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("⚙ bash(ls)");
    expect(frame).toContain("All done.");
    expect(frame).toContain("— done: 2 step(s)");
    unmount();
  });

  it("shows an approval prompt and denies on 'n'", async () => {
    const resolver = async () => ({ model: {} as never, label: "fake:model" });
    const { lastFrame, stdin, unmount } = render(
      <App cwd="/tmp" policy={DEFAULT_POLICY} engine={approvalEngine()} resolver={resolver} />,
    );
    await tick();
    stdin.write("delete stuff");
    await tick();
    stdin.write("\r");
    await tick(80);
    expect(lastFrame() ?? "").toContain("approval required");
    expect(lastFrame() ?? "").toContain("[dangerous] bash(rm -rf x)");

    stdin.write("n"); // deny
    await tick(80);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✗ denied");
    expect(frame).toContain("kept it safe");
    unmount();
  });

  it("approves on 'y' and continues", async () => {
    const resolver = async () => ({ model: {} as never, label: "fake:model" });
    const { lastFrame, stdin, unmount } = render(
      <App cwd="/tmp" policy={DEFAULT_POLICY} engine={approvalEngine()} resolver={resolver} />,
    );
    await tick();
    stdin.write("do it");
    await tick();
    stdin.write("\r");
    await tick(80);
    expect(lastFrame() ?? "").toContain("approval required");
    stdin.write("y"); // approve
    await tick(80);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✓ approved");
    expect(frame).toContain("removed");
    unmount();
  });
});
