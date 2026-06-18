import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configuredAllowedDomains,
  presentProviderKeys,
  sandboxDenyReadPaths,
} from "./config.js";
import { buildSandbox, gitOriginHost, noopSandbox, runtimeSandbox } from "./sandbox.js";

describe("noopSandbox", () => {
  it("is inactive and passes commands through unchanged", async () => {
    const s = noopSandbox();
    expect(s.active).toBe(false);
    expect(await s.wrap("rm -rf /")).toBe("rm -rf /");
    expect(s.scrubEnv()).toBeUndefined();
    await expect(s.init()).resolves.toBeUndefined();
    await expect(s.dispose()).resolves.toBeUndefined();
  });
});

describe("runtimeSandbox (pre-init, no backend side effects)", () => {
  it("is inactive and passthrough until init() engages it", async () => {
    const s = runtimeSandbox({ cwd: process.cwd(), allowedDomains: [], denyRead: [], envScrub: ["X"] });
    expect(s.active).toBe(false);
    expect(await s.wrap("echo hi")).toBe("echo hi");
    expect(s.scrubEnv()).toBeUndefined(); // nothing scrubbed while inactive
  });
});

describe("buildSandbox", () => {
  it("returns a no-op when --sandbox is not set", async () => {
    const s = await buildSandbox({ cwd: process.cwd(), enabled: false });
    expect(s.active).toBe(false);
    expect(s.status).toBe("off");
  });
});

describe("config-derived sandbox policy", () => {
  it("deny-read protects coble state and credential stores", () => {
    const paths = sandboxDenyReadPaths();
    expect(paths.some((p) => p.endsWith(".ssh"))).toBe(true);
    expect(paths.some((p) => p.endsWith(".aws"))).toBe(true);
    // GitHub CLI token store — used by `gh pr create`, must be deny-read
    expect(paths.some((p) => p.endsWith(path.join(".config", "gh")))).toBe(true);
    expect(paths.some((p) => p.endsWith(".git-credentials"))).toBe(true);
    // coble home (stored API keys + audit log)
    expect(paths.length).toBeGreaterThan(0);
  });

  it("allowed domains: default-deny, env + extra merged, trimmed and de-duped", () => {
    const prev = process.env.COBLE_ALLOWED_DOMAINS;
    try {
      delete process.env.COBLE_ALLOWED_DOMAINS;
      expect(configuredAllowedDomains()).toEqual([]);
      process.env.COBLE_ALLOWED_DOMAINS = "a.com, b.com";
      // the --allow-domain channel (extra) is trimmed/filtered like the env one
      expect(configuredAllowedDomains([" b.com ", "c.com", "  "])).toEqual([
        "a.com",
        "b.com",
        "c.com",
      ]);
    } finally {
      if (prev === undefined) delete process.env.COBLE_ALLOWED_DOMAINS;
      else process.env.COBLE_ALLOWED_DOMAINS = prev;
    }
  });

  it("present provider keys reflects the environment", () => {
    const prev = process.env.OPENAI_API_KEY;
    try {
      process.env.OPENAI_API_KEY = "sk-test";
      expect(presentProviderKeys()).toContain("OPENAI_API_KEY");
      delete process.env.OPENAI_API_KEY;
      expect(presentProviderKeys()).not.toContain("OPENAI_API_KEY");
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });
});

describe("gitOriginHost", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "coble-git-"));
    await execa("git", ["init", "-q"], { cwd });
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("parses an scp-style remote", async () => {
    await execa("git", ["remote", "add", "origin", "git@github.com:owner/repo.git"], { cwd });
    expect(await gitOriginHost(cwd)).toBe("github.com");
  });

  it("parses an https remote", async () => {
    await execa("git", ["remote", "add", "origin", "https://gitlab.com/owner/repo.git"], { cwd });
    expect(await gitOriginHost(cwd)).toBe("gitlab.com");
  });

  it("returns undefined when there is no origin remote", async () => {
    expect(await gitOriginHost(cwd)).toBeUndefined();
  });
});
