import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadLayeredEnv,
  maskValue,
  readEnvFile,
  setGlobalConfig,
  sourceOf,
  unsetGlobalConfig,
  writeEnvFile,
} from "./config.js";

let dir: string;
const TOUCHED = ["CFG_FOO", "CFG_BAR", "CFG_SHELL", "COBLE_HOME"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "coble-cfg-"));
  for (const k of TOUCHED) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("env file io", () => {
  it("round-trips values, quoting awkward ones", () => {
    const file = path.join(dir, "env");
    writeEnvFile(file, { CFG_FOO: "plain", CFG_BAR: "has space # and quote\"" });
    const back = readEnvFile(file);
    expect(back.CFG_FOO).toBe("plain");
    expect(back.CFG_BAR).toBe('has space # and quote"');
  });

  it("creates the file with 0600 permissions and keeps them on rewrite", () => {
    const file = path.join(dir, "deep", "env");
    setGlobalConfig("CFG_FOO", "secret-value-123", file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    setGlobalConfig("CFG_BAR", "two", file); // rewrite
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readEnvFile(file)).toMatchObject({ CFG_FOO: "secret-value-123", CFG_BAR: "two" });
  });

  it("unset removes a key and reports absence", () => {
    const file = path.join(dir, "env");
    setGlobalConfig("CFG_FOO", "x", file);
    expect(unsetGlobalConfig("CFG_FOO", file)).toBe(true);
    expect(unsetGlobalConfig("CFG_FOO", file)).toBe(false);
    expect(readEnvFile(file)).toEqual({});
  });

  it("rejects invalid keys and multiline values", () => {
    const file = path.join(dir, "env");
    expect(() => setGlobalConfig("BAD KEY", "v", file)).toThrow(/invalid/);
    expect(() => setGlobalConfig("CFG_FOO", "a\nb", file)).toThrow(/single-line/);
  });
});

describe("maskValue", () => {
  it("masks short values fully and long ones partially", () => {
    expect(maskValue("abc")).toBe("••••");
    const m = maskValue("sk-proj-abcdefghijklmnop");
    expect(m).toBe("sk-p…mnop");
    expect(m).not.toContain("abcdefgh");
  });
});

describe("layered precedence", () => {
  it("shell > project .env > global config", async () => {
    // global config lives in COBLE_HOME/env
    const home = path.join(dir, "home");
    process.env.COBLE_HOME = home;
    writeEnvFile(path.join(home, "env"), { CFG_FOO: "global", CFG_BAR: "global", CFG_SHELL: "global" });

    // project .env
    const project = path.join(dir, "project");
    await writeFile(path.join(dir, "project.keep"), ""); // ensure parent exists via mkdtemp root
    await rm(project, { recursive: true, force: true });
    const { mkdir, writeFile: wf } = await import("node:fs/promises");
    await mkdir(project, { recursive: true });
    await wf(path.join(project, ".env"), "CFG_FOO=project\nCFG_SHELL=project\n");

    // shell wins over everything
    process.env.CFG_SHELL = "shell";

    const { applied } = loadLayeredEnv({ cwd: project });

    expect(process.env.CFG_SHELL).toBe("shell"); // untouched
    expect(process.env.CFG_FOO).toBe("project"); // project beats global
    expect(process.env.CFG_BAR).toBe("global"); // global fills the gap
    expect(applied.CFG_FOO).toBe("project");
    expect(applied.CFG_BAR).toBe("global");
    expect(applied.CFG_SHELL).toBeUndefined();

    // provenance helper agrees
    expect(sourceOf("CFG_SHELL", project)).toBe("shell");
    expect(sourceOf("CFG_FOO", project)).toBe("project");
    expect(sourceOf("CFG_BAR", project)).toBe("global");
    expect(sourceOf("CFG_NOPE", project)).toBeUndefined();
  });
});
