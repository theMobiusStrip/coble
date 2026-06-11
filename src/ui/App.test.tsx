import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { DEFAULT_POLICY } from "../core/approval.js";
import type { AgentEvent } from "../core/events.js";
import { App } from "./App.js";

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function* fakeRun(): AsyncGenerator<AgentEvent> {
  yield { type: "tool_start", name: "bash", input: "ls", tier: "safe" };
  yield { type: "tool_end", name: "bash", ok: true, output: "x.txt", ms: 5 };
  yield { type: "token", text: "All done." };
  yield { type: "model_end", text: "All done.", toolCallCount: 0 };
  yield { type: "final", text: "All done.", steps: 2, usage: { inputTokens: 10, outputTokens: 5 } };
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
});
