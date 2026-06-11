import { describe, expect, it } from "vitest";
import { classifyBash, classifyToolCall, tierExceeds, DEFAULT_POLICY } from "./approval.js";

describe("classifyBash", () => {
  it.each([
    ["ls -la", "safe"],
    ["cat package.json", "safe"],
    ["grep -r TODO src", "safe"],
    ["git status && git diff --stat", "safe"],
    ["FOO=1 ls", "safe"],
    ["find . -name '*.ts'", "safe"],
    ["wc -l src/cli.tsx | sort", "safe"],
  ] as const)("%s → %s", (cmd, tier) => {
    expect(classifyBash(cmd)).toBe(tier);
  });

  it.each([
    ["rm -rf /tmp/x"],
    ["git push origin main"],
    ["npm install leftpad"],
    ["find . -name '*.log' -delete"],
    ["find . -name '*.ts' -exec rm {} \\;"],
    ["echo hi > pwned.txt"],
    ["cat $(secret-cmd)"],
    ["ls `evil`"],
    ["curl http://example.com"],
    ["ls && rm -rf ."],
    ["git config user.email evil@example.com"],
  ])("%s → dangerous", (cmd) => {
    expect(classifyBash(cmd)).toBe("dangerous");
  });
});

describe("classifyToolCall", () => {
  it("maps tool names to tiers", () => {
    expect(classifyToolCall("read_file", { path: "a" })).toBe("safe");
    expect(classifyToolCall("write_file", { path: "a", content: "" })).toBe("confirm");
    expect(classifyToolCall("edit_file", { path: "a" })).toBe("confirm");
    expect(classifyToolCall("bash", { command: "ls" })).toBe("safe");
    expect(classifyToolCall("bash", { command: "rm -rf ." })).toBe("dangerous");
    expect(classifyToolCall("create_pull_request", {})).toBe("dangerous");
    expect(classifyToolCall("totally_unknown", {})).toBe("dangerous");
  });
});

describe("tierExceeds", () => {
  it("default policy allows confirm, blocks dangerous", () => {
    expect(tierExceeds("safe", DEFAULT_POLICY)).toBe(false);
    expect(tierExceeds("confirm", DEFAULT_POLICY)).toBe(false);
    expect(tierExceeds("dangerous", DEFAULT_POLICY)).toBe(true);
  });

  it("paranoid policy blocks confirm", () => {
    const paranoid = { autoTier: "safe" as const, dangerouslyAllow: false };
    expect(tierExceeds("confirm", paranoid)).toBe(true);
  });

  it("dangerouslyAllow opens everything", () => {
    const open = { autoTier: "confirm" as const, dangerouslyAllow: true };
    expect(tierExceeds("dangerous", open)).toBe(false);
  });
});
