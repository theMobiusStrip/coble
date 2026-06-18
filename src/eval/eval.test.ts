import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluate, type RunCapture } from "./assert.js";
import { loadTasks } from "./load.js";
import { renderMarkdown, summarize } from "./report.js";
import { runAll, scriptedModelFor } from "./run.js";

const TASKS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../evals/tasks");

describe("assertion evaluator", () => {
  const cap: RunCapture = {
    cwd: "/nonexistent",
    events: [
      { type: "tool_start", name: "write_file", input: "a.txt", tier: "confirm" },
      { type: "tool_denied", name: "bash", input: "rm -rf .", reason: "x" },
    ],
    audit: [{ ts: "t", tool: "bash", summary: "rm -rf .", tier: "dangerous", decision: "denied" }],
    finalText: "all done here",
  };

  it("passes satisfied assertions", async () => {
    const failures = await evaluate(
      [{ tool_called: "write_file" }, { tool_denied: "bash" }, { final_contains: "done" }, { audit_decision: { tool: "bash", decision: "denied" } }],
      cap,
    );
    expect(failures).toEqual([]);
  });

  it("reports unsatisfied assertions", async () => {
    const failures = await evaluate(
      [{ tool_called: "read_file" }, { final_contains: "nope" }, { tool_not_called: "write_file" }],
      cap,
    );
    expect(failures).toHaveLength(3);
  });
});

describe("report", () => {
  it("summarizes and renders a table", () => {
    const results = [
      { id: "a", description: "x", pass: true, failures: [], steps: 1, usage: { inputTokens: 1, outputTokens: 1 }, ms: 0 },
      { id: "b", description: "y", pass: false, failures: ["boom"], steps: 0, usage: { inputTokens: 0, outputTokens: 0 }, ms: 0 },
    ];
    expect(summarize(results)).toMatchObject({ passed: 1, total: 2 });
    const md = renderMarkdown(results, { model: "scripted", dateIso: "2026-06-11" });
    expect(md).toContain("Passed: **1/2**");
    expect(md).toContain("| `a` | ✅ pass");
    expect(md).toContain("boom");
  });
});

describe("full scripted suite", () => {
  it("loads 18 tasks and every one passes in scripted mode", async () => {
    const tasks = loadTasks(TASKS_DIR);
    expect(tasks).toHaveLength(18);
    const results = await runAll(tasks, scriptedModelFor, Date.now());
    const failed = results.filter((r) => !r.pass);
    expect(failed, JSON.stringify(failed, null, 2)).toHaveLength(0);
  }, 60_000);
});
