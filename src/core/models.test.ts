import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveModel } from "./models.js";

const TOUCHED = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "COBLE_MODEL", "OLLAMA_HOST"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of TOUCHED) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("resolveModel", () => {
  it("with nothing configured, fails with copy-pasteable fixes", async () => {
    await expect(resolveModel(undefined)).rejects.toThrow(/coble config set OPENAI_API_KEY/);
    await expect(resolveModel(undefined)).rejects.toThrow(/ollama:llama3\.1/);
  });

  it("COBLE_MODEL pins the default", async () => {
    process.env.COBLE_MODEL = "ollama:llama3.1";
    const { label } = await resolveModel(undefined);
    expect(label).toBe("ollama:llama3.1");
  });

  it("honors OLLAMA_HOST for the ollama provider", async () => {
    process.env.OLLAMA_HOST = "http://10.1.2.3:11434";
    const { model } = await resolveModel("ollama:llama3.1");
    expect((model as unknown as { baseUrl: string }).baseUrl).toBe("http://10.1.2.3:11434");
  });

  it("rejects unknown providers with the expected list", async () => {
    await expect(resolveModel("watsonx:foo")).rejects.toThrow(/openai:.*anthropic:.*ollama:.*scripted:/s);
  });
});
