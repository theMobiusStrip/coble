import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONTEXT_FILENAME, loadContextFile, userContextPath } from "./context.js";

let cwd: string;
let home: string;
let savedHome: string | undefined;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "coble-context-"));
  home = await mkdtemp(path.join(tmpdir(), "coble-home-"));
  savedHome = process.env.COBLE_HOME;
  process.env.COBLE_HOME = home; // isolate from the real ~/.coble/AGENTS.md
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.COBLE_HOME;
  else process.env.COBLE_HOME = savedHome;
  await rm(cwd, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("loadContextFile", () => {
  it("returns the workspace-root AGENTS.md text when present", async () => {
    await writeFile(path.join(cwd, CONTEXT_FILENAME), "# Project rules\n- be careful\n", "utf8");
    expect(loadContextFile(cwd)).toBe("# Project rules\n- be careful");
  });

  it("returns the user-level $COBLE_HOME/AGENTS.md text when present", async () => {
    await writeFile(userContextPath(), "# Global rules\n- always test\n", "utf8");
    expect(loadContextFile(cwd)).toBe("# Global rules\n- always test");
  });

  it("merges user-level and project-level, user first", async () => {
    await writeFile(userContextPath(), "GLOBAL", "utf8");
    await writeFile(path.join(cwd, CONTEXT_FILENAME), "PROJECT", "utf8");
    expect(loadContextFile(cwd)).toBe("GLOBAL\n\nPROJECT");
  });

  it("returns undefined when absent (clean no-op)", () => {
    expect(loadContextFile(cwd)).toBeUndefined();
  });

  it("returns undefined for an empty / whitespace-only file", async () => {
    await writeFile(path.join(cwd, CONTEXT_FILENAME), "   \n\t\n", "utf8");
    expect(loadContextFile(cwd)).toBeUndefined();
  });

  it("loads AGENTS.md specifically (not other markdown)", async () => {
    await writeFile(path.join(cwd, "README.md"), "not this one", "utf8");
    expect(loadContextFile(cwd)).toBeUndefined();
    expect(CONTEXT_FILENAME).toBe("AGENTS.md");
  });

  it("userContextPath lives under $COBLE_HOME", () => {
    expect(userContextPath()).toBe(path.join(home, CONTEXT_FILENAME));
  });
});
