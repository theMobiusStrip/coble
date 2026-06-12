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

const noSetup = { needsSetup: async () => false };

describe("App", () => {
  it("renders banner and input prompt", async () => {
    const { lastFrame, unmount } = render(<App cwd="/tmp" policy={DEFAULT_POLICY} setup={noSetup} />);
    await tick();
    expect(lastFrame()).toContain("coble");
    expect(lastFrame()).toContain(">");
    unmount();
  });

  it("runs a task through an injected engine and renders the transcript", async () => {
    const resolver = async () => ({ model: {} as never, label: "fake:model" });
    const { lastFrame, stdin, unmount } = render(
      <App cwd="/tmp" policy={DEFAULT_POLICY} engine={() => fakeRun()} resolver={resolver} setup={noSetup} />,
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
      <App cwd="/tmp" policy={DEFAULT_POLICY} engine={approvalEngine()} resolver={resolver} setup={noSetup} />,
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
      <App cwd="/tmp" policy={DEFAULT_POLICY} engine={approvalEngine()} resolver={resolver} setup={noSetup} />,
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

  it("first run: provider select → masked key → validate → save", async () => {
    const savedEntries: Record<string, string> = {};
    const validated: string[] = [];
    const setup = {
      needsSetup: async () => true,
      save: (e: Record<string, string>) => Object.assign(savedEntries, e),
      validate: async (spec: string) => {
        validated.push(spec);
      },
    };
    const { lastFrame, stdin, unmount } = render(<App cwd="/tmp" policy={DEFAULT_POLICY} setup={setup} />);
    await tick(50);
    expect(lastFrame()).toContain("first-run setup");

    stdin.write("1"); // OpenAI
    await tick(50);
    expect(lastFrame()).toContain("OPENAI_API_KEY");

    stdin.write("sk-test-123456789");
    await tick(30);
    expect(lastFrame()).not.toContain("sk-test-123456789"); // masked input
    stdin.write("\r");
    await tick(80);

    expect(validated).toEqual(["openai:gpt-5.5"]);
    expect(savedEntries).toMatchObject({ OPENAI_API_KEY: "sk-test-123456789", COBLE_MODEL: "openai:gpt-5.5" });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("saved globally");
    expect(frame).toContain(">"); // back to the normal input
    unmount();
  });

  it("first run: failed validation shows the error and allows retry", async () => {
    let calls = 0;
    const setup = {
      needsSetup: async () => true,
      save: () => {},
      validate: async () => {
        calls += 1;
        throw new Error("401 Incorrect API key provided");
      },
    };
    const { lastFrame, stdin, unmount } = render(<App cwd="/tmp" policy={DEFAULT_POLICY} setup={setup} />);
    await tick(50);
    stdin.write("2"); // Anthropic
    await tick(50);
    stdin.write("bad-key");
    await tick(30);
    stdin.write("\r");
    await tick(80);
    expect(calls).toBe(1);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("401");
    expect(frame).toContain("key>"); // still on the key step for retry
    unmount();
  });

  it("first run: q skips setup with a hint", async () => {
    const setup = { needsSetup: async () => true, save: () => {}, validate: async () => {} };
    const { lastFrame, stdin, unmount } = render(<App cwd="/tmp" policy={DEFAULT_POLICY} setup={setup} />);
    await tick(50);
    stdin.write("q");
    await tick(50);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("setup skipped");
    expect(frame).toContain("coble config set");
    unmount();
  });
});
