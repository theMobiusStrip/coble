import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "./approval.js";
import { runAgent } from "./engine.js";
import type { AgentEvent } from "./events.js";
import { ScriptedChatModel } from "./scripted.js";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "coble-engine-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

describe("runAgent end-to-end (scripted model)", () => {
  it("executes a write → verify → summarize task", async () => {
    const model = new ScriptedChatModel([
      {
        content: "Creating the file now.",
        toolCalls: [{ name: "write_file", args: { path: "hello.txt", content: "hi from coble\n" } }],
      },
      { toolCalls: [{ name: "bash", args: { command: "cat hello.txt" } }] },
      { content: "Done: created hello.txt and verified its content." },
    ]);

    const events = await collect(runAgent({ prompt: "create hello.txt", cwd, model, policy: DEFAULT_POLICY }));

    expect(await readFile(path.join(cwd, "hello.txt"), "utf8")).toBe("hi from coble\n");

    const toolStarts = events.filter((e) => e.type === "tool_start");
    expect(toolStarts.map((e) => e.type === "tool_start" && e.name)).toEqual(["write_file", "bash"]);

    const toolEnds = events.filter((e) => e.type === "tool_end");
    expect(toolEnds.every((e) => e.type === "tool_end" && e.ok)).toBe(true);

    const final = events.at(-1);
    expect(final?.type).toBe("final");
    if (final?.type === "final") {
      expect(final.text).toContain("Done");
      expect(final.steps).toBe(3);
      // 3 scripted turns × (100 in / 25 out)
      expect(final.usage).toEqual({ inputTokens: 300, outputTokens: 75 });
    }

    // streaming path: content turns surface as token events too
    expect(events.some((e) => e.type === "token" && e.text.includes("Creating"))).toBe(true);
  });

  it("denies dangerous calls under the default policy and lets the agent adapt", async () => {
    const model = new ScriptedChatModel([
      { toolCalls: [{ name: "bash", args: { command: "rm -rf ./everything" } }] },
      { content: "The destructive command was denied, so I stopped." },
    ]);

    const events = await collect(runAgent({ prompt: "wipe it", cwd, model, policy: DEFAULT_POLICY }));

    const denied = events.find((e) => e.type === "tool_denied");
    expect(denied).toBeDefined();
    if (denied?.type === "tool_denied") {
      expect(denied.name).toBe("bash");
      expect(denied.reason).toContain("dangerous");
    }
    // nothing was executed
    expect(events.some((e) => e.type === "tool_start")).toBe(false);
    expect(events.at(-1)?.type).toBe("final");
  });

  it("allows dangerous calls when dangerouslyAllow is set", async () => {
    const model = new ScriptedChatModel([
      { toolCalls: [{ name: "bash", args: { command: "mkdir made-it" } }] },
      { content: "done" },
    ]);
    const events = await collect(
      runAgent({ prompt: "mkdir", cwd, model, policy: { autoTier: "confirm", dangerouslyAllow: true } }),
    );
    expect(events.some((e) => e.type === "tool_end" && e.ok)).toBe(true);
    expect((await stat(path.join(cwd, "made-it"))).isDirectory()).toBe(true);
  });

  it("stops at maxSteps even if the model keeps calling tools", async () => {
    const turns = Array.from({ length: 20 }, () => ({
      toolCalls: [{ name: "bash", args: { command: "echo loop" } }],
    }));
    const model = new ScriptedChatModel(turns);
    const events = await collect(
      runAgent({ prompt: "loop forever", cwd, model, policy: DEFAULT_POLICY, maxSteps: 3 }),
    );
    const final = events.at(-1);
    expect(final?.type).toBe("final");
    if (final?.type === "final") expect(final.steps).toBe(3);
  });

  it("reports unknown tools as errors to the model, not crashes", async () => {
    const model = new ScriptedChatModel([
      { toolCalls: [{ name: "launch_missiles", args: {} }] },
      { content: "that tool does not exist; stopping." },
    ]);
    const events = await collect(runAgent({ prompt: "x", cwd, model, policy: DEFAULT_POLICY }));
    expect(events.at(-1)?.type).toBe("final");
  });
});
