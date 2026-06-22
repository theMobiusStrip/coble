import { describe, expect, it } from "vitest";
import { textFromContent } from "./content.js";

describe("textFromContent", () => {
  it("returns a string unchanged (OpenAI/Ollama shape)", () => {
    expect(textFromContent("hello world")).toBe("hello world");
    expect(textFromContent("")).toBe("");
  });

  it("joins text blocks from an array (Anthropic shape)", () => {
    expect(textFromContent([{ type: "text", text: "foo " }, { type: "text", text: "bar" }])).toBe("foo bar");
  });

  it("ignores non-text blocks (tool_use, thinking, image)", () => {
    const content = [
      { type: "thinking", thinking: "secret reasoning" },
      { type: "text", text: "the answer" },
      { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
    ];
    expect(textFromContent(content)).toBe("the answer");
  });

  it("handles bare-string array entries", () => {
    expect(textFromContent(["a", "b"])).toBe("ab");
  });

  it("returns empty string for null/undefined/object", () => {
    expect(textFromContent(undefined)).toBe("");
    expect(textFromContent(null)).toBe("");
    expect(textFromContent({ text: "x" })).toBe("");
  });

  it("returns empty for an array with no text blocks (tool-only turn)", () => {
    expect(textFromContent([{ type: "tool_use", id: "t1", name: "bash", input: {} }])).toBe("");
  });
});
