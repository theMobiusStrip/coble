import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryAuditLog } from "./audit.js";
import { runAgent, type ApprovalHandler } from "./engine.js";
import type { AgentEvent, PendingCall } from "./events.js";
import { ScriptedChatModel } from "./scripted.js";

let cwd: string;

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

const approveAll: ApprovalHandler = async (calls) =>
  Object.fromEntries(calls.map((c) => [c.id, true]));
const denyAll: ApprovalHandler = async (calls) =>
  Object.fromEntries(calls.map((c) => [c.id, false]));

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "coble-approve-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("human-in-the-loop approval", () => {
  it("pauses on a dangerous call, then executes it when approved", async () => {
    const model = new ScriptedChatModel([
      { toolCalls: [{ name: "bash", args: { command: "mkdir created-dir" } }] },
      { content: "Directory created." },
    ]);
    const audit = memoryAuditLog();
    const onApproval = vi.fn(approveAll);

    const events = await collect(
      runAgent({ prompt: "make a dir", cwd, model, onApproval, audit: audit.record }),
    );

    // approval was requested for exactly the dangerous call
    expect(onApproval).toHaveBeenCalledOnce();
    const requested = onApproval.mock.calls[0]?.[0] as PendingCall[];
    expect(requested.map((c) => c.name)).toEqual(["bash"]);
    expect(requested[0]?.tier).toBe("dangerous");

    const approvalEvent = events.find((e) => e.type === "approval_required");
    expect(approvalEvent).toBeDefined();

    // the call actually executed
    expect((await stat(path.join(cwd, "created-dir"))).isDirectory()).toBe(true);
    expect(events.some((e) => e.type === "tool_end" && e.ok)).toBe(true);

    // audit recorded an approved decision
    expect(audit.entries().some((e) => e.decision === "approved" && e.tool === "bash")).toBe(true);
  });

  it("denies on rejection and lets the agent adapt without re-running", async () => {
    const model = new ScriptedChatModel([
      { toolCalls: [{ name: "bash", args: { command: "rm -rf important" } }] },
      { content: "Understood — I won't delete anything." },
    ]);
    const audit = memoryAuditLog();

    const events = await collect(
      runAgent({ prompt: "delete things", cwd, model, onApproval: denyAll, audit: audit.record }),
    );

    expect(events.some((e) => e.type === "tool_denied")).toBe(true);
    expect(events.some((e) => e.type === "tool_start")).toBe(false); // nothing executed
    const final = events.at(-1);
    expect(final?.type).toBe("final");
    if (final?.type === "final") expect(final.text).toContain("won't delete");
    expect(audit.entries().some((e) => e.decision === "denied")).toBe(true);
  });

  it("does not pause for safe calls", async () => {
    const model = new ScriptedChatModel([
      { toolCalls: [{ name: "bash", args: { command: "ls" } }] },
      { content: "Listed." },
    ]);
    const onApproval = vi.fn(approveAll);
    await collect(runAgent({ prompt: "list", cwd, model, onApproval }));
    expect(onApproval).not.toHaveBeenCalled();
  });

  it("approves some and denies others in a mixed batch", async () => {
    const model = new ScriptedChatModel([
      {
        toolCalls: [
          { name: "bash", args: { command: "mkdir yes-dir" }, id: "ok" },
          { name: "bash", args: { command: "rm -rf no-dir" }, id: "no" },
        ],
      },
      { content: "Did the safe part." },
    ]);
    // Key by the id we're handed (an opaque per-call token), approving the mkdir
    // and denying the rm — don't assume the id equals the model's tool-call id.
    const onApproval: ApprovalHandler = async (calls) =>
      Object.fromEntries(calls.map((c) => [c.id, c.summary.startsWith("mkdir")]));
    const events = await collect(runAgent({ prompt: "mixed", cwd, model, onApproval }));

    expect((await stat(path.join(cwd, "yes-dir"))).isDirectory()).toBe(true);
    expect(events.some((e) => e.type === "tool_denied")).toBe(true);
  });

  it("survives a crash between approval and completion (durable HITL)", async () => {
    // Approve a dangerous call, the tool runs, then the model crashes before
    // finishing. Resuming must NOT re-run the approved tool.
    const checkpointer = SqliteSaver.fromConnString(":memory:");
    const threadId = "hitl-resume";

    const crashing = new ScriptedChatModel([
      { toolCalls: [{ name: "bash", args: { command: "printf Y >> once.txt" } }] },
      { crash: "boom after approval" },
    ]);
    const ev1 = await collect(
      runAgent({ prompt: "write once", cwd, model: crashing, onApproval: approveAll, checkpointer, threadId }),
    );
    expect(ev1.at(-1)?.type).toBe("error");
    expect(await readFile(path.join(cwd, "once.txt"), "utf8")).toBe("Y");

    const healthy = new ScriptedChatModel([{ content: "recovered" }]);
    const ev2 = await collect(
      runAgent({ resume: true, cwd, model: healthy, onApproval: approveAll, checkpointer, threadId }),
    );
    expect(ev2.at(-1)?.type).toBe("final");
    // tool did not run a second time
    expect(await readFile(path.join(cwd, "once.txt"), "utf8")).toBe("Y");
  });
});
