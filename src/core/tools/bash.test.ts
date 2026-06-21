import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bashFailed, makeBashTool } from "./bash.js";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "coble-bash-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("bash tool", () => {
  it("runs in the workspace cwd and captures output", async () => {
    await writeFile(path.join(cwd, "x.txt"), "one\ntwo\n", "utf8");
    const tool = makeBashTool({ cwd });
    const out = await tool.invoke({ command: "ls" });
    expect(out).toContain("x.txt");
  });

  it("reports non-zero exit codes instead of throwing", async () => {
    const tool = makeBashTool({ cwd });
    const out = await tool.invoke({ command: "ls definitely-not-here-404" });
    expect(out).toMatch(/exit code [1-9]/);
  });

  // Regression (D9): renderers use this to show ✗ for a failed/timed-out
  // command instead of a misleading green ✓.
  it("bashFailed flags a failed bash result but not success or other tools", async () => {
    const tool = makeBashTool({ cwd });
    const ok = await tool.invoke({ command: "echo hi" });
    const bad = await tool.invoke({ command: "ls definitely-not-here-404" });
    expect(bashFailed("bash", bad)).toBe(true);
    expect(bashFailed("bash", ok)).toBe(false);
    expect(bashFailed("bash", "exit code undefined\n(timed out)")).toBe(true); // timeout: exitCode is undefined
    expect(bashFailed("write_file", "exit code 1")).toBe(false); // predicate is bash-only
  });
});
