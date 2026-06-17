import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runtimeSandbox, type Sandbox } from "./sandbox.js";
import { makeBashTool } from "./tools/bash.js";
import { makeGitTools } from "./tools/gitTools.js";

// These tests stand up the REAL OS sandbox (Seatbelt / bubblewrap). They run
// only where the backend is actually available; elsewhere (e.g. native Windows,
// or Linux CI without bubblewrap) the whole suite skips instead of failing.
const SANDBOX_AVAILABLE =
  SandboxManager.isSupportedPlatform() && SandboxManager.checkDependencies().errors.length === 0;

describe.skipIf(!SANDBOX_AVAILABLE)("runtime sandbox — OS-enforced (engaged)", () => {
  let cwd: string;
  let outside: string;
  let sandbox: Sandbox;

  beforeAll(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "coble-sbx-cwd-"));
    outside = await mkdtemp(path.join(tmpdir(), "coble-sbx-out-"));
    await writeFile(path.join(outside, "secret.txt"), "TOPSECRET", "utf8");
    sandbox = runtimeSandbox({
      cwd,
      allowedDomains: [], // default-deny network
      denyRead: [outside], // stand-in for ~/.ssh etc.
      envScrub: ["COBLE_IT_SECRET"],
    });
    await sandbox.init();
  }, 30_000);

  afterAll(async () => {
    await sandbox?.dispose();
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("engages the OS backend", () => {
    expect(sandbox.active).toBe(true);
  });

  it("allows writes within the workspace", async () => {
    const bash = makeBashTool({ cwd, sandbox });
    const out = String(await bash.invoke({ command: "echo hi > inside.txt && cat inside.txt" }));
    expect(out).toContain("hi");
    expect(existsSync(path.join(cwd, "inside.txt"))).toBe(true);
  });

  it("blocks writes outside the workspace (the OS enforces it, not the classifier)", async () => {
    const bash = makeBashTool({ cwd, sandbox });
    // Home root is outside allowWrite (cwd + temp + device nodes); writing here
    // must be denied by the OS. Clean up in case the sandbox ever regresses.
    const target = path.join(homedir(), ".coble-sbx-write-escape-probe");
    try {
      await bash.invoke({ command: `echo x > ${target}` });
      expect(existsSync(target)).toBe(false);
    } finally {
      await rm(target, { force: true });
    }
  });

  it("blocks reads of a deny-read path even for a classifier-safe `cat`", async () => {
    const bash = makeBashTool({ cwd, sandbox });
    const out = String(await bash.invoke({ command: `cat ${path.join(outside, "secret.txt")}` }));
    expect(out).not.toContain("TOPSECRET");
    expect(out).toMatch(/not permitted|denied|operation/i);
  });

  it("scrubs provider keys from the subprocess environment", async () => {
    process.env.COBLE_IT_SECRET = "leaked-value";
    try {
      const bash = makeBashTool({ cwd, sandbox });
      const out = String(await bash.invoke({ command: 'printf "[%s]" "$COBLE_IT_SECRET"' }));
      expect(out).toContain("[]");
      expect(out).not.toContain("leaked-value");
    } finally {
      delete process.env.COBLE_IT_SECRET;
    }
  });

  it("binds child processes spawned by the command", async () => {
    const bash = makeBashTool({ cwd, sandbox });
    const out = String(await bash.invoke({ command: `sh -c 'cat ${path.join(outside, "secret.txt")}'` }));
    expect(out).not.toContain("TOPSECRET");
  });

  it("runs git through the sandbox with correct argument quoting", async () => {
    // Repo + config are created OUTSIDE the sandbox: the sandbox denies writes to
    // .git/config by design, but `git commit` only needs to read it.
    await execa("git", ["init", "-q", "-b", "main"], { cwd });
    await execa("git", ["config", "user.email", "it@coble.dev"], { cwd });
    await execa("git", ["config", "user.name", "coble it"], { cwd });
    await execa("git", ["config", "commit.gpgsign", "false"], { cwd });
    await writeFile(path.join(cwd, "tracked.txt"), "data\n", "utf8");

    const tools = makeGitTools({ cwd, sandbox }, { dryRun: true, createPr: async () => "dry://pr" });
    const gitCommit = tools.find((t) => t.name === "git_commit");
    if (!gitCommit) throw new Error("git_commit tool missing");

    // Single quotes, double quotes and a newline stress shQuote through the shell.
    const message = `fix: it's a "tricky" message\n\nwith a body line`;
    const res = String(await gitCommit.invoke({ message, paths: ["tracked.txt"] }));
    expect(res).toMatch(/committed/);

    const log = await execa("git", ["log", "-1", "--pretty=%B"], { cwd });
    expect(log.stdout).toContain(`it's a "tricky" message`);
    expect(log.stdout).toContain("with a body line");
  }, 30_000);
});
