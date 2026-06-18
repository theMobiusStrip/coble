import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BaseMessage, ToolMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { policyForMode } from "./approval.js";
import { memoryAuditLog } from "./audit.js";
import { runAgent } from "./engine.js";
import type { AgentEvent } from "./events.js";
import { compileRuleList, emptyRules } from "./permissionRules.js";
import { ScriptedChatModel } from "./scripted.js";

let cwd: string;

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}
const exists = async (p: string) => stat(path.join(cwd, p)).then(() => true, () => false);

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "coble-perm-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("permission rules + modes (end-to-end, headless)", () => {
  it("a deny rule blocks a matching command even before the gate", async () => {
    const model = new ScriptedChatModel([
      { toolCalls: [{ name: "bash", args: { command: "rm -rf important" } }] },
      { content: "ok, won't." },
    ]);
    const audit = memoryAuditLog();
    const policy = policyForMode("bypass", { allow: [], ask: [], deny: compileRuleList(["Bash(rm:*)"]) });
    const events = await collect(runAgent({ prompt: "clean", cwd, model, policy, audit: audit.record }));

    expect(events.some((e) => e.type === "tool_denied")).toBe(true);
    expect(events.some((e) => e.type === "tool_start")).toBe(false); // never executed (even under bypass)
    expect(audit.entries().some((e) => e.decision === "denied" && /rule:deny/.test(e.detail ?? ""))).toBe(true);
  });

  it("an allow rule auto-runs a dangerous command without approval", async () => {
    const model = new ScriptedChatModel([
      { toolCalls: [{ name: "bash", args: { command: "mkdir made-by-allow" } }] },
      { content: "done." },
    ]);
    const audit = memoryAuditLog();
    // mkdir is "dangerous" → would be denied headless; the allow rule runs it.
    const policy = policyForMode("default", { allow: compileRuleList(["Bash(mkdir:*)"]), ask: [], deny: [] });
    await collect(runAgent({ prompt: "make dir", cwd, model, policy, audit: audit.record }));

    expect(await exists("made-by-allow")).toBe(true);
    expect(audit.entries().some((e) => e.decision === "auto" && /rule:allow/.test(e.detail ?? ""))).toBe(true);
  });

  it("echoes the original tool_call_id back even when the model emits duplicate ids", async () => {
    // Two calls sharing one id: decisions must not leak across them (both run),
    // and each ToolMessage must carry the ORIGINAL id — a rewritten "dup#1" would
    // reference a tool call absent from the assistant message, which providers reject.
    const model = new ScriptedChatModel([
      {
        toolCalls: [
          { name: "bash", args: { command: "mkdir dup-a" }, id: "dup" },
          { name: "bash", args: { command: "mkdir dup-b" }, id: "dup" },
        ],
      },
      { content: "done." },
    ]);
    const checkpointer = new MemorySaver();
    const threadId = "dup-ids";
    await collect(runAgent({ prompt: "two dirs", cwd, model, policy: policyForMode("bypass"), checkpointer, threadId }));

    expect(await exists("dup-a")).toBe(true);
    expect(await exists("dup-b")).toBe(true);

    const tuple = await checkpointer.getTuple({ configurable: { thread_id: threadId } });
    const messages = (tuple?.checkpoint.channel_values.messages ?? []) as BaseMessage[];
    const toolIds = messages.filter((m) => m.getType() === "tool").map((m) => (m as ToolMessage).tool_call_id);
    expect(toolIds).toEqual(["dup", "dup"]);
  });

  it("plan mode blocks writes (read-only)", async () => {
    const model = new ScriptedChatModel([
      { toolCalls: [{ name: "write_file", args: { path: "out.txt", content: "x" } }] },
      { content: "planned only." },
    ]);
    const events = await collect(
      runAgent({ prompt: "write", cwd, model, policy: policyForMode("plan", emptyRules()) }),
    );
    expect(events.some((e) => e.type === "tool_denied")).toBe(true);
    expect(await exists("out.txt")).toBe(false);
  });

  describe("auto mode (model-judged)", () => {
    const policy = policyForMode("auto", emptyRules());

    it("runs a command the classifier ALLOWs", async () => {
      const model = new ScriptedChatModel([
        { toolCalls: [{ name: "bash", args: { command: "mkdir allowed-dir" } }] },
        { content: "done." },
      ]);
      const classifierModel = new ScriptedChatModel([{ content: "ALLOW" }]);
      await collect(runAgent({ prompt: "make dir", cwd, model, policy, classifierModel }));
      expect(await exists("allowed-dir")).toBe(true);
    });

    it("blocks a command the classifier BLOCKs, and the agent adapts", async () => {
      const model = new ScriptedChatModel([
        { toolCalls: [{ name: "bash", args: { command: "mkdir blocked-dir" } }] },
        { content: "ok, I'll do something else." },
      ]);
      const classifierModel = new ScriptedChatModel([{ content: "BLOCK: out of scope" }]);
      const audit = memoryAuditLog();
      const events = await collect(
        runAgent({ prompt: "make dir", cwd, model, policy, classifierModel, audit: audit.record }),
      );
      expect(events.some((e) => e.type === "tool_denied")).toBe(true);
      expect(await exists("blocked-dir")).toBe(false);
      expect(audit.entries().some((e) => /auto:block/.test(e.detail ?? ""))).toBe(true);
    });

    it("fails closed: a classifier error denies (does not auto-run)", async () => {
      const model = new ScriptedChatModel([
        { toolCalls: [{ name: "bash", args: { command: "mkdir errdir" } }] },
        { content: "ok." },
      ]);
      const classifierModel = new ScriptedChatModel([{ crash: "classifier down" }]);
      const events = await collect(runAgent({ prompt: "make dir", cwd, model, policy, classifierModel }));
      expect(events.some((e) => e.type === "tool_denied")).toBe(true);
      expect(await exists("errdir")).toBe(false);
    });

    it("push/PR still require a human even in auto mode (classifier not consulted)", async () => {
      const model = new ScriptedChatModel([
        { toolCalls: [{ name: "git_push", args: { branch: "main" } }] },
        { content: "won't push." },
      ]);
      // classifier would ALLOW, but git_push is a hard-prompt → denied headless.
      const classifierModel = new ScriptedChatModel([{ content: "ALLOW" }]);
      const events = await collect(runAgent({ prompt: "push", cwd, model, policy, classifierModel }));
      expect(events.some((e) => e.type === "tool_denied")).toBe(true);
      expect(events.some((e) => e.type === "tool_start")).toBe(false);
    });
  });
});
