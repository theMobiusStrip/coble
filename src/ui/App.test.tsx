import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { DEFAULT_POLICY } from "../core/approval.js";
import { readEnvFile } from "../core/config.js";
import type { AgentEvent } from "../core/events.js";
import type { EngineOptions } from "../core/engine.js";
import { globalEnvPath } from "../core/store.js";
import { App, defaultSetupDeps } from "./App.js";

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
    expect(lastFrame()).toContain("›"); // bordered input prompt
    unmount();
  });

  it("opens a slash-command menu on '/' and tab-completes the selection", async () => {
    const { lastFrame, stdin, unmount } = render(<App cwd="/tmp" policy={DEFAULT_POLICY} setup={noSetup} />);
    await tick();
    stdin.write("/");
    await tick();
    let frame = lastFrame() ?? "";
    expect(frame).toContain("/exit");
    expect(frame).toContain("/quit");
    stdin.write("\t"); // complete the highlighted command into the input
    await tick();
    frame = lastFrame() ?? "";
    expect(frame).toContain("› /exit");
    unmount();
  });

  it("narrows the menu as you type and reports an unknown slash command", async () => {
    const { lastFrame, stdin, unmount } = render(<App cwd="/tmp" policy={DEFAULT_POLICY} setup={noSetup} />);
    await tick();
    stdin.write("/e");
    await tick();
    expect(lastFrame() ?? "").toContain("/exit");
    expect(lastFrame() ?? "").not.toContain("/quit"); // narrowed
    stdin.write("".repeat(2) + "/nope"); // clear + type an unknown command
    await tick();
    stdin.write("\r");
    await tick();
    expect(lastFrame() ?? "").toContain("unknown command");
    unmount();
  });

  it("highlights inline `code` commands in assistant output (strips backticks)", async () => {
    const text = "run `coble policy install` now";
    const engine = () =>
      (async function* () {
        yield { type: "token", text } as AgentEvent;
        yield { type: "model_end", text, toolCallCount: 0 } as AgentEvent;
        yield { type: "final", text, steps: 1, usage: { inputTokens: 1, outputTokens: 1 } } as AgentEvent;
      })();
    const resolver = async () => ({ model: {} as never, label: "fake:model" });
    const { lastFrame, stdin, unmount } = render(
      <App cwd="/tmp" policy={DEFAULT_POLICY} engine={engine} resolver={resolver} setup={noSetup} />,
    );
    await tick();
    stdin.write("go");
    await tick();
    stdin.write("\r");
    await tick(100);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("coble policy install"); // command shown
    expect(frame).not.toContain("`coble policy install`"); // backticks dropped (highlighted span)
    unmount();
  });

  it("reuses one checkpointer + thread id across turns (conversation memory)", async () => {
    const seen: EngineOptions[] = [];
    const resolver = async () => ({ model: {} as never, label: "fake:model" });
    const { stdin, unmount } = render(
      <App cwd="/tmp" policy={DEFAULT_POLICY} engine={(o) => { seen.push(o); return fakeRun(); }} resolver={resolver} setup={noSetup} />,
    );
    await tick();
    stdin.write("first");
    await tick();
    stdin.write("\r");
    await tick(80);
    stdin.write("second");
    await tick();
    stdin.write("\r");
    await tick(80);
    expect(seen.length).toBe(2);
    expect(seen[0]?.threadId).toBeTruthy(); // a stable thread, not the "oneshot" default
    expect(seen[0]?.checkpointer).toBeDefined();
    expect(seen[1]?.threadId).toBe(seen[0]?.threadId); // same thread across turns → memory
    expect(seen[1]?.checkpointer).toBe(seen[0]?.checkpointer); // same checkpointer instance
    unmount();
  });

  it("'/exit' tears down the sandbox and quits without running a task", async () => {
    const dispose = vi.fn(async () => {});
    const sandbox = {
      init: async () => {},
      wrap: async (c: string) => c,
      dispose,
      active: false,
      status: "",
      scrubEnv: () => undefined,
      denyReadPaths: () => [],
      egressPolicy: () => ({ restricted: false, allowedDomains: [] }),
    };
    const engine = vi.fn(() => fakeRun());
    const { stdin, unmount } = render(
      <App cwd="/tmp" policy={DEFAULT_POLICY} engine={engine} sandbox={sandbox as never} setup={noSetup} />,
    );
    await tick();
    stdin.write("/exit");
    await tick();
    stdin.write("\r");
    await tick(50);
    expect(dispose).toHaveBeenCalled(); // quit path ran
    expect(engine).not.toHaveBeenCalled(); // not forwarded to the agent as a task
    unmount();
  });

  it("shows the resolved configured model before first submit", async () => {
    const resolver = async () => ({ model: {} as never, label: "fake:model" });
    const { lastFrame, unmount } = render(
      <App cwd="/tmp" policy={DEFAULT_POLICY} resolver={resolver} setup={noSetup} />,
    );
    await tick(50);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("fake:model");
    expect(frame).not.toContain("no model");
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
    let frame = lastFrame() ?? "";
    expect(frame).not.toContain("Bash(ls)"); // tool trail hidden by default
    expect(frame).toContain("All done.");
    expect(frame).toContain("fake:model"); // status bar
    expect(frame).toContain("15 tok"); // accumulated usage (10 in + 5 out)

    stdin.write("\t"); // → compact: tool tree visible
    await tick(50);
    frame = lastFrame() ?? "";
    expect(frame).toContain("Bash(ls)"); // tool tree, prettified name
    expect(frame).toContain("x.txt"); // tool result under ⎿
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
    expect(lastFrame() ?? "").toContain("dangerous");
    expect(lastFrame() ?? "").toContain("Bash(rm -rf x)");

    stdin.write("n"); // deny
    await tick(80);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✗ denied");
    expect(frame).toContain("user denied approval");
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

  it("forwards the audit sink to the engine (interactive runs get recorded)", async () => {
    let seen: EngineOptions | undefined;
    const auditSink: EngineOptions["audit"] = () => {};
    const resolver = async () => ({ model: {} as never, label: "fake:model" });
    const { stdin, unmount } = render(
      <App cwd="/tmp" policy={DEFAULT_POLICY} audit={auditSink} engine={(o) => { seen = o; return fakeRun(); }} resolver={resolver} setup={noSetup} />,
    );
    await tick();
    stdin.write("go");
    await tick();
    stdin.write("\r");
    await tick(50);
    expect(seen?.audit).toBe(auditSink); // the TUI must thread its audit sink through to the engine
    unmount();
  });

  it("forwards systemExtra (workspace AGENTS.md) to the engine", async () => {
    let seen: EngineOptions | undefined;
    const resolver = async () => ({ model: {} as never, label: "fake:model" });
    const { stdin, unmount } = render(
      <App cwd="/tmp" policy={DEFAULT_POLICY} systemExtra="PROJECT RULES" engine={(o) => { seen = o; return fakeRun(); }} resolver={resolver} setup={noSetup} />,
    );
    await tick();
    stdin.write("go");
    await tick();
    stdin.write("\r");
    await tick(50);
    expect(seen?.systemExtra).toBe("PROJECT RULES"); // interactive runs must carry the workspace context
    unmount();
  });

  it("tab cycles the tool trail: hidden (default) → compact → full → hidden", async () => {
    async function* run(): AsyncGenerator<AgentEvent> {
      yield { type: "tool_start", name: "bash", input: "python3 -c '\nimport os\nprint(1)'", tier: "safe" };
      yield { type: "tool_end", name: "bash", ok: true, output: "l1\nl2\nl3\nl4\nl5\nl6", ms: 5 };
      yield { type: "model_end", text: "Listed.", toolCallCount: 0 };
      yield { type: "final", text: "Listed.", steps: 1, usage: { inputTokens: 1, outputTokens: 1 } };
    }
    const resolver = async () => ({ model: {} as never, label: "fake:model" });
    const { lastFrame, stdin, unmount } = render(
      <App cwd="/tmp" policy={DEFAULT_POLICY} engine={() => run()} resolver={resolver} setup={noSetup} />,
    );
    await tick();
    stdin.write("list");
    await tick();
    stdin.write("\r");
    await tick(100);

    // hidden (default): clean conversation, no tool trail at all
    let frame = lastFrame() ?? "";
    expect(frame).toContain("Listed.");
    expect(frame).not.toContain("Bash(");
    expect(frame).toContain("tools: hidden"); // status bar shows the mode

    stdin.write("\t"); // → compact
    await tick(50);
    frame = lastFrame() ?? "";
    expect(frame).toContain("tools: compact"); // status label matches the state (not "collapsed")
    expect(frame).toContain("6 lines (tab to expand)");
    expect(frame).not.toContain("l3");
    expect(frame).toContain("python3 -c ' …"); // multi-line command → first line + ellipsis
    expect(frame).not.toContain("import os");

    stdin.write("\t"); // → full
    await tick(50);
    frame = lastFrame() ?? "";
    expect(frame).toContain("l3");
    expect(frame).toContain("l6");
    expect(frame).toContain("import os"); // full command while expanded

    stdin.write("\t"); // → hidden again
    await tick(50);
    expect(lastFrame() ?? "").not.toContain("Bash(");
    unmount();
  });

  it("'a' approves all remaining calls this session without further prompts", async () => {
    const engine = (opts: EngineOptions) => {
      async function* gen(): AsyncGenerator<AgentEvent> {
        const b1 = [{ id: "c1", name: "bash", summary: "curl a", tier: "dangerous" as const }];
        yield { type: "approval_required", calls: b1 };
        const d1 = await opts.onApproval!(b1);
        yield { type: "tool_end", name: "bash", ok: true, output: "a", ms: 1 };

        const b2 = [{ id: "c2", name: "bash", summary: "curl b", tier: "dangerous" as const }];
        yield { type: "approval_required", calls: b2 };
        const d2 = await opts.onApproval!(b2); // resolves instantly once approve-all is on

        const b3 = [{ id: "c3", name: "write_file", summary: "out.md", tier: "confirm" as const }];
        yield { type: "approval_required", calls: b3 };
        const d3 = await opts.onApproval!(b3);

        const verdict = `decisions: ${d1.c1}/${d2.c2}/${d3.c3}`;
        yield { type: "model_end", text: verdict, toolCallCount: 0 };
        yield { type: "final", text: verdict, steps: 3, usage: { inputTokens: 1, outputTokens: 1 } };
      }
      return gen();
    };
    const resolver = async () => ({ model: {} as never, label: "fake:model" });
    const { lastFrame, stdin, unmount } = render(
      <App cwd="/tmp" policy={DEFAULT_POLICY} engine={engine} resolver={resolver} setup={noSetup} />,
    );
    await tick();
    stdin.write("do things");
    await tick();
    stdin.write("\r");
    await tick(80);
    expect(lastFrame() ?? "").toContain("approval required");
    expect(lastFrame() ?? "").toContain("approve all");

    stdin.write("a"); // approve batch 1 + enable approve-all
    await tick(120);
    let frame = lastFrame() ?? "";
    expect(frame).toContain("auto-approving the rest of this session");
    // batches 2 and 3 resolved without a prompt — straight to the final verdict
    expect(frame).toContain("decisions: true/true/true");
    expect(frame).toContain("auto-approve"); // status bar flag
    expect(frame).not.toContain("✓ auto-approved"); // tool noise hidden by default

    stdin.write("\t"); // → compact: auto-approval trail becomes visible
    await tick(50);
    frame = lastFrame() ?? "";
    expect((frame.match(/✓ auto-approved/g) ?? []).length).toBe(2);
    unmount();
  });

  it("surfaces a run that hit the step cap with no answer, even with tools hidden", async () => {
    async function* run(): AsyncGenerator<AgentEvent> {
      yield { type: "tool_start", name: "bash", input: "curl …", tier: "safe" };
      yield { type: "tool_end", name: "bash", ok: true, output: "html…", ms: 5 };
      yield { type: "final", text: "", steps: 40, usage: { inputTokens: 9, outputTokens: 1 }, capped: true };
    }
    const resolver = async () => ({ model: {} as never, label: "fake:model" });
    const { lastFrame, stdin, unmount } = render(
      <App cwd="/tmp" policy={DEFAULT_POLICY} engine={() => run()} resolver={resolver} setup={noSetup} />,
    );
    await tick();
    stdin.write("research something");
    await tick();
    stdin.write("\r");
    await tick(100);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("stopped at the 40-step limit without a final answer");
    expect(frame).toContain("tab to inspect");
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
    expect(frame).toContain("openai:gpt-5.5");
    expect(frame).toContain("›"); // back to the normal input
    unmount();
  });

  it("first run: can configure Google AI", async () => {
    const previous = process.env.GOOGLE_API_KEY;
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
    stdin.write("3"); // Google AI
    await tick(50);
    expect(lastFrame()).toContain("GOOGLE_API_KEY");

    stdin.write("google-test-123456789");
    await tick(30);
    expect(lastFrame()).not.toContain("google-test-123456789");
    stdin.write("\r");
    await tick(80);

    expect(validated).toEqual(["google:gemini-3.5-flash"]);
    expect(savedEntries).toMatchObject({
      GOOGLE_API_KEY: "google-test-123456789",
      COBLE_MODEL: "google:gemini-3.5-flash",
    });
    if (previous === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = previous;
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

// The TUI tests above exercise the seams with fakes; this block covers the
// real default implementations (resolution, validation, persistence).
describe("defaultSetupDeps", () => {
  const TOUCHED = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "COBLE_MODEL", "COBLE_HOME", "ONBOARD_TEST_KEY"] as const;
  const saved: Record<string, string | undefined> = {};
  let home: string;

  beforeEach(async () => {
    for (const k of TOUCHED) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    home = await mkdtemp(path.join(tmpdir(), "coble-onboard-"));
    process.env.COBLE_HOME = home;
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    for (const k of TOUCHED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("needsSetup: true with nothing configured; false with -m or COBLE_MODEL", async () => {
    expect(await defaultSetupDeps.needsSetup(undefined)).toBe(true);
    expect(await defaultSetupDeps.needsSetup("scripted:whatever.json")).toBe(false);
    process.env.COBLE_MODEL = "ollama:llama3.1";
    expect(await defaultSetupDeps.needsSetup(undefined)).toBe(false);
  });

  it("validate: drives a real model invoke (scripted, offline)", async () => {
    const script = path.join(home, "ping.json");
    await writeFile(script, JSON.stringify([{ content: "ok" }]), "utf8");
    await expect(defaultSetupDeps.validate(`scripted:${script}`)).resolves.toBeUndefined();
    await expect(defaultSetupDeps.validate("scripted:/nonexistent.json")).rejects.toThrow();
  });

  it("save: persists to the global config file and the live process env", async () => {
    defaultSetupDeps.save({ ONBOARD_TEST_KEY: "sk-saved-123", COBLE_MODEL: "openai:gpt-5.5" });
    expect(process.env.ONBOARD_TEST_KEY).toBe("sk-saved-123");
    expect(readEnvFile(globalEnvPath())).toMatchObject({
      ONBOARD_TEST_KEY: "sk-saved-123",
      COBLE_MODEL: "openai:gpt-5.5",
    });
  });
});
