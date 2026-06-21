import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { observeSession } from "./sessionRunner.js";
import { openSessionStore } from "./sessions.js";
import type { AgentEvent } from "./events.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "coble-sess-"));
  file = path.join(dir, "sessions.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("session store", () => {
  it("creates, retrieves, updates and lists newest-first", () => {
    const store = openSessionStore(file);
    const a = store.create({ cwd: "/w", model: "scripted:x", prompt: "first task", nowIso: "2026-06-11T00:00:00Z" });
    const b = store.create({ cwd: "/w", model: "scripted:x", prompt: "second task", nowIso: "2026-06-11T00:01:00Z" });
    expect(a.id).not.toBe(b.id);
    expect(store.get(a.id)?.status).toBe("running");

    store.update(a.id, { status: "done", steps: 4, usage: { inputTokens: 200, outputTokens: 50 } });
    expect(store.get(a.id)?.status).toBe("done");
    expect(store.get(a.id)?.steps).toBe(4);

    const list = store.list();
    expect(list[0]?.id).toBe(b.id); // newest first
    expect(list).toHaveLength(2);
  });

  it("resolves by unique prefix and rejects ambiguity", () => {
    const store = openSessionStore(file);
    const s = store.create({ cwd: "/w", model: "m", prompt: "p", nowIso: "2026-06-11T00:00:00Z" });
    expect(store.resolve(s.id.slice(0, 4))?.id).toBe(s.id);
    expect(store.resolve("zzzznope")).toBeUndefined();
  });

  it("persists across store re-opens", () => {
    const s = openSessionStore(file).create({ cwd: "/w", model: "m", prompt: "p", nowIso: "2026-06-11T00:00:00Z" });
    expect(openSessionStore(file).get(s.id)?.prompt).toBe("p");
  });
});

describe("observeSession", () => {
  async function* stream(...evs: AgentEvent[]): AsyncIterable<AgentEvent> {
    for (const e of evs) yield e;
  }

  it("records terminal status from the final event", async () => {
    const store = openSessionStore(file);
    const s = store.create({ cwd: "/w", model: "m", prompt: "p", nowIso: "2026-06-11T00:00:00Z" });
    const observed = observeSession(
      stream(
        { type: "tool_start", name: "bash", input: "ls", tier: "safe" },
        { type: "final", text: "ok", steps: 2, usage: { inputTokens: 10, outputTokens: 3 } },
      ),
      store,
      s.id,
    );
    const seen: AgentEvent[] = [];
    for await (const e of observed) seen.push(e);
    expect(seen).toHaveLength(2); // passthrough preserved
    expect(store.get(s.id)?.status).toBe("done");
    expect(store.get(s.id)?.usage.inputTokens).toBe(10);
  });

  it("records error and paused statuses", async () => {
    const store = openSessionStore(file);
    const e = store.create({ cwd: "/w", model: "m", prompt: "p", nowIso: "2026-06-11T00:00:00Z" });
    for await (const _ of observeSession(stream({ type: "error", message: "boom" }), store, e.id)) void _;
    expect(store.get(e.id)?.status).toBe("error");

    const p = store.create({ cwd: "/w", model: "m", prompt: "p", nowIso: "2026-06-11T00:00:00Z" });
    for await (const _ of observeSession(stream({ type: "interrupted", calls: [] }), store, p.id)) void _;
    expect(store.get(p.id)?.status).toBe("paused");
  });

  // Regression (D10): a session that errored/paused after doing work must
  // persist the steps + token usage accumulated up to that point, not 0 / none.
  it("persists steps + usage carried on error and interrupted events", async () => {
    const store = openSessionStore(file);
    const e = store.create({ cwd: "/w", model: "m", prompt: "p", nowIso: "2026-06-11T00:00:00Z" });
    for await (const _ of observeSession(
      stream({ type: "error", message: "boom mid-run", steps: 1, usage: { inputTokens: 100, outputTokens: 25 } }),
      store,
      e.id,
    ))
      void _;
    expect(store.get(e.id)?.status).toBe("error");
    expect(store.get(e.id)?.steps).toBe(1);
    expect(store.get(e.id)?.usage).toEqual({ inputTokens: 100, outputTokens: 25 });

    const p = store.create({ cwd: "/w", model: "m", prompt: "p", nowIso: "2026-06-11T00:00:00Z" });
    for await (const _ of observeSession(
      stream({ type: "interrupted", calls: [], steps: 3, usage: { inputTokens: 7, outputTokens: 2 } }),
      store,
      p.id,
    ))
      void _;
    expect(store.get(p.id)?.steps).toBe(3);
    expect(store.get(p.id)?.usage.outputTokens).toBe(2);
  });
});
