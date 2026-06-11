import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "./approval.js";
import { runAgent } from "./engine.js";
import type { AgentEvent } from "./events.js";
import { ScriptedChatModel } from "./scripted.js";

let cwd: string;

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "coble-persist-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("durable resume", () => {
  it("continues from the last checkpoint without re-running completed tool calls", async () => {
    // One checkpointer instance shared across both runs (the on-disk DB in prod).
    const checkpointer = SqliteSaver.fromConnString(":memory:");
    const threadId = "thread-resume";

    // Run 1: append a marker via a side-effecting tool, then crash before finishing.
    const crashing = new ScriptedChatModel([
      { toolCalls: [{ name: "bash", args: { command: "printf X >> marker.txt" } }] },
      { crash: "simulated process death" },
    ]);
    const firstEvents = await collect(
      runAgent({
        prompt: "append a marker then continue",
        cwd,
        model: crashing,
        policy: { autoTier: "confirm", dangerouslyAllow: true },
        checkpointer,
        threadId,
      }),
    );
    expect(firstEvents.at(-1)?.type).toBe("error");
    // The side effect happened exactly once and was checkpointed.
    expect(await readFile(path.join(cwd, "marker.txt"), "utf8")).toBe("X");

    // Run 2: resume the same thread with a fresh, healthy model.
    const healthy = new ScriptedChatModel([{ content: "Recovered and finished." }]);
    const resumeEvents = await collect(
      runAgent({
        resume: true,
        cwd,
        model: healthy,
        policy: { autoTier: "confirm", dangerouslyAllow: true },
        checkpointer,
        threadId,
      }),
    );

    const final = resumeEvents.at(-1);
    expect(final?.type).toBe("final");
    if (final?.type === "final") expect(final.text).toContain("Recovered");

    // Crucial assertion: the marker tool did NOT run again on resume.
    expect(await readFile(path.join(cwd, "marker.txt"), "utf8")).toBe("X");
    // And resume executed no new tool calls.
    expect(resumeEvents.some((e) => e.type === "tool_start")).toBe(false);
  });

  it("isolates threads — a different thread id starts fresh", async () => {
    const checkpointer = SqliteSaver.fromConnString(":memory:");
    const model = new ScriptedChatModel([{ content: "hi" }]);
    await collect(runAgent({ prompt: "a", cwd, model, policy: DEFAULT_POLICY, checkpointer, threadId: "t-a" }));
    // resume of an unrelated empty thread just ends without error
    const model2 = new ScriptedChatModel([{ content: "fresh" }]);
    const ev = await collect(
      runAgent({ prompt: "b", cwd, model: model2, policy: DEFAULT_POLICY, checkpointer, threadId: "t-b" }),
    );
    expect(ev.at(-1)?.type).toBe("final");
  });
});
