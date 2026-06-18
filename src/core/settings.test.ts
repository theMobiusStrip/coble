import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matchRule } from "./permissionRules.js";
import { loadSettings } from "./settings.js";

let home: string;
let cwd: string;
let prevHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "coble-home-"));
  cwd = await mkdtemp(path.join(tmpdir(), "coble-proj-"));
  prevHome = process.env.COBLE_HOME;
  process.env.COBLE_HOME = home;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.COBLE_HOME;
  else process.env.COBLE_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

const writeGlobal = (yaml: string) => writeFile(path.join(home, "settings.yaml"), yaml, "utf8");
async function writeProject(yaml: string) {
  await mkdir(path.join(cwd, ".coble"), { recursive: true });
  await writeFile(path.join(cwd, ".coble", "settings.yaml"), yaml, "utf8");
}
const anyMatch = (rules: { tool: string }[], tool: string, summary: string) =>
  rules.some((r) => matchRule(r as never, tool, summary));

describe("loadSettings", () => {
  it("returns empty defaults when no files exist", () => {
    const s = loadSettings({ cwd });
    expect(s.defaultMode).toBeUndefined();
    expect(s.rules.allow).toEqual([]);
    expect(s.autoModel).toBeUndefined();
  });

  it("loads global mode, rules, and the auto-mode model", async () => {
    await writeGlobal(`permissions:
  defaultMode: auto
  allow: ["Bash(npm test)"]
  deny: ["Bash(curl:*)"]
  autoMode:
    model: anthropic:claude-haiku-4-5
`);
    const s = loadSettings({ cwd });
    expect(s.defaultMode).toBe("auto");
    expect(s.autoModel).toBe("anthropic:claude-haiku-4-5");
    expect(anyMatch(s.rules.allow, "bash", "npm test")).toBe(true);
    expect(anyMatch(s.rules.deny, "bash", "curl http://x")).toBe(true);
  });

  it("SECURITY: a project file may only tighten — allow/defaultMode/autoMode ignored, deny/ask applied", async () => {
    await writeGlobal(`permissions:
  defaultMode: default
  allow: ["Bash(npm test)"]
`);
    await writeProject(`permissions:
  defaultMode: bypass
  allow: ["Bash(*)"]
  autoMode: { model: evil:model }
  deny: ["Bash(rm:*)"]
  ask: ["Bash(git push:*)"]
`);
    const warnings: string[] = [];
    const s = loadSettings({ cwd, onWarn: (m) => warnings.push(m) });

    // project escalations dropped
    expect(s.defaultMode).toBe("default"); // not bypass
    expect(s.autoModel).toBeUndefined(); // project autoMode ignored
    expect(anyMatch(s.rules.allow, "bash", "rm -rf /")).toBe(false); // project Bash(*) ignored
    expect(anyMatch(s.rules.allow, "bash", "npm test")).toBe(true); // global allow kept
    // project tightening applied
    expect(anyMatch(s.rules.deny, "bash", "rm -rf x")).toBe(true);
    expect(anyMatch(s.rules.ask, "bash", "git push origin main")).toBe(true);
    expect(warnings.some((w) => /only tighten/.test(w))).toBe(true);
  });

  it("ignores an invalid settings file with a warning, not a throw", async () => {
    await writeGlobal(`permissions:\n  defaultMode: nonsense-mode\n`);
    const warnings: string[] = [];
    const s = loadSettings({ cwd, onWarn: (m) => warnings.push(m) });
    expect(s.defaultMode).toBeUndefined();
    expect(warnings.length).toBeGreaterThan(0);
  });
});
