import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgent } from "./engine.js";
import type { AgentEvent } from "./events.js";
import { REVIEW_PROMPT } from "./prompts.js";
import { ScriptedChatModel } from "./scripted.js";
import { makeGitTools, type PullRequest } from "./tools/gitTools.js";

let root: string;
let repo: string;

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await execa("git", args, { cwd, all: true });
  return (r.all ?? "").trim();
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "coble-review-"));
  repo = path.join(root, "repo");
  // a small repo with one TODO and a dependency
  await execa("git", ["init", "-q", "-b", "main", repo]);
  await git(repo, "config", "user.email", "test@coble.dev");
  await git(repo, "config", "user.name", "coble test");
  await git(repo, "config", "commit.gpgsign", "false");
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "demo", dependencies: { leftpad: "0.0.1" } }, null, 2));
  await writeFile(path.join(repo, "index.js"), "// TODO: add tests\nmodule.exports = 1;\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "initial");
  // local bare remote so push works offline
  const remote = path.join(root, "origin.git");
  await execa("git", ["init", "-q", "--bare", remote]);
  await git(repo, "remote", "add", "origin", remote);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("repo review vertical", () => {
  it("audits the repo, writes AUDIT.md, branches, commits, pushes and opens a dry-run PR", async () => {
    const createdPrs: PullRequest[] = [];
    const gitTools = makeGitTools(
      { cwd: repo },
      { dryRun: true, createPr: async (pr) => (createdPrs.push(pr), "stub://never-called") },
    );

    const auditBody = "# Audit\n\n## Summary\nFound 2 issues.\n\n## Findings\n- High: `package.json` pins `leftpad@0.0.1` (known-risky dependency)\n- Medium: `index.js` has a TODO and no tests\n\n## Recommendations\nReplace leftpad; add a test suite.\n";

    const model = new ScriptedChatModel([
      { content: "Reading the manifest.", toolCalls: [{ name: "read_file", args: { path: "package.json" } }] },
      { toolCalls: [{ name: "bash", args: { command: "grep -rn TODO . --include=*.js" } }] },
      { toolCalls: [{ name: "write_file", args: { path: "AUDIT.md", content: auditBody } }] },
      { toolCalls: [{ name: "git_branch", args: { name: "coble/audit" } }] },
      { toolCalls: [{ name: "git_commit", args: { message: "docs: add coble repo audit", paths: ["AUDIT.md"] } }] },
      { toolCalls: [{ name: "git_push", args: { branch: "coble/audit" } }] },
      {
        toolCalls: [
          { name: "create_pull_request", args: { title: "Repo audit by coble", body: "Found 2 issues. See AUDIT.md.", base: "main" } },
        ],
      },
      { content: "Audit complete: flagged a risky dependency and missing tests; opened a PR." },
    ]);

    const events = await collect(
      runAgent({
        prompt: "Audit this repository and open a pull request with your findings.",
        cwd: repo,
        model,
        policy: { autoTier: "confirm", dangerouslyAllow: true },
        extraTools: gitTools,
        systemExtra: REVIEW_PROMPT,
      }),
    );

    // AUDIT.md exists with our content
    expect(await readFile(path.join(repo, "AUDIT.md"), "utf8")).toContain("Found 2 issues");

    // branch exists and is current
    expect(await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("coble/audit");

    // commit landed on the branch and touches AUDIT.md
    const show = await git(repo, "show", "--stat", "--oneline", "HEAD");
    expect(show).toContain("AUDIT.md");
    expect(show).toContain("coble repo audit");

    // branch was pushed to origin
    const remoteBranches = await git(repo, "ls-remote", "--heads", "origin");
    expect(remoteBranches).toContain("refs/heads/coble/audit");

    // PR was dry-run: our injected creator was NOT called, and the tool reported a dry run
    expect(createdPrs).toHaveLength(0);
    const prToolEnd = events.find((e) => e.type === "tool_end" && e.name === "create_pull_request");
    expect(prToolEnd?.type === "tool_end" && prToolEnd.output).toContain("DRY RUN");

    // every tool call succeeded
    expect(events.filter((e) => e.type === "tool_end").every((e) => e.type === "tool_end" && e.ok)).toBe(true);

    const final = events.at(-1);
    expect(final?.type).toBe("final");
    if (final?.type === "final") expect(final.text).toContain("Audit complete");
  });

  it("create_pull_request calls the injected creator when not a dry run", async () => {
    const created: PullRequest[] = [];
    const tools = makeGitTools(
      { cwd: repo },
      { dryRun: false, createPr: async (pr) => (created.push(pr), "https://example/pr/1") },
    );
    const prTool = tools.find((t) => t.name === "create_pull_request");
    await git(repo, "checkout", "-B", "feature");
    const out = await prTool!.invoke({ title: "T", body: "B", base: "main" });
    expect(String(out)).toContain("https://example/pr/1");
    expect(created[0]).toMatchObject({ title: "T", base: "main", head: "feature" });
  });
});
