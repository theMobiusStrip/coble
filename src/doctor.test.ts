import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setGlobalConfig } from "./core/config.js";
import { renderDoctor, runDoctor } from "./doctor.js";

const TOUCHED = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "COBLE_MODEL", "COBLE_HOME", "OLLAMA_HOST"] as const;
const saved: Record<string, string | undefined> = {};
let home: string;
let cwd: string;

beforeEach(async () => {
  for (const k of TOUCHED) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  home = await mkdtemp(path.join(tmpdir(), "coble-doctor-home-"));
  cwd = await mkdtemp(path.join(tmpdir(), "coble-doctor-cwd-"));
  process.env.COBLE_HOME = home;
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("doctor", () => {
  it("passes with a key configured (no ping) and masks the key", async () => {
    process.env.OPENAI_API_KEY = "sk-test-abcdefghijklmnopqrst";
    const { results, exitCode } = await runDoctor({ ping: false, cwd });

    expect(exitCode).toBe(0);
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));
    expect(byName.node?.status).toBe("ok");
    expect(byName["state dir"]?.status).toBe("ok");
    expect(byName.OPENAI_API_KEY?.status).toBe("ok");
    expect(byName.OPENAI_API_KEY?.detail).toContain("shell");
    expect(byName.OPENAI_API_KEY?.detail).not.toContain("abcdefghijklmnop"); // masked
    expect(byName["default model"]?.detail).toBe("openai:gpt-5.5");
    // no live checks ran
    expect(byName["provider ping"]).toBeUndefined();
    expect(byName.ollama).toBeUndefined();
  });

  it("reports provenance from the global config file", async () => {
    setGlobalConfig("ANTHROPIC_API_KEY", "sk-ant-test-0123456789abcdef");
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-0123456789abcdef"; // as loadLayeredEnv would
    const { results } = await runDoctor({ ping: false, cwd });
    const key = results.find((r) => r.name === "ANTHROPIC_API_KEY");
    expect(key?.detail).toContain("global");
  });

  it("fails with no provider configured, pointing at config set", async () => {
    const { results, exitCode } = await runDoctor({ ping: false, cwd });
    expect(exitCode).toBe(1);
    const model = results.find((r) => r.name === "default model");
    expect(model?.status).toBe("fail");
    expect(model?.detail).toContain("no model configured");
  });

  it("warns (not fails) when keys are absent but COBLE_MODEL pins ollama", async () => {
    process.env.COBLE_MODEL = "ollama:llama3.1";
    const { results, exitCode } = await runDoctor({ ping: false, cwd });
    expect(exitCode).toBe(0);
    expect(results.find((r) => r.name === "default model")?.detail).toBe("ollama:llama3.1");
  });

  it("renders aligned glyph lines", async () => {
    process.env.OPENAI_API_KEY = "sk-test-abcdefghijklmnopqrst";
    const { results } = await runDoctor({ ping: false, cwd });
    const text = renderDoctor(results);
    expect(text).toContain("✓");
    expect(text.split("\n").length).toBe(results.length);
  });
});
