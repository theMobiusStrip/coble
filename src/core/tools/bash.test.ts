import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeBashTool } from "./bash.js";

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
});
