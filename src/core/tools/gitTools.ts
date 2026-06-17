import { execa, type Options } from "execa";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import type { ToolContext } from "./fsTools.js";

export interface PullRequest {
  title: string;
  body: string;
  base: string;
  head: string;
}

export interface GitOptions {
  /** When false, create_pull_request shells out to `gh`; otherwise it is simulated. */
  dryRun: boolean;
  /** Injectable PR creator (defaults to `gh pr create`). Tests stub this. */
  createPr?: (pr: PullRequest, cwd: string) => Promise<string>;
}

/** POSIX single-quote escaping for building a sandbox-wrapped shell string. */
function shQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Run `file args…` under the sandbox when one is active, otherwise exactly as
 * before (argv form, no shell). The sandboxed path quotes every argument and
 * runs the wrapped command through a shell, with provider keys scrubbed; the
 * default path is unchanged so non-sandboxed behavior is byte-for-byte stable.
 */
async function execFile(
  ctx: ToolContext,
  file: string,
  args: string[],
  options: Options,
): Promise<{ exitCode: number | undefined; all: string }> {
  const sandbox = ctx.sandbox;
  const res = sandbox?.active
    ? await (async () => {
        const wrapped = await sandbox.wrap([file, ...args].map(shQuote).join(" "));
        const scrubbed = sandbox.scrubEnv();
        return execa(wrapped, {
          ...options,
          shell: true,
          ...(scrubbed ? { env: scrubbed, extendEnv: false } : {}),
        });
      })()
    : await execa(file, args, options);
  return { exitCode: res.exitCode, all: typeof res.all === "string" ? res.all : "" };
}

async function git(ctx: ToolContext, args: string[]): Promise<string> {
  const res = await execFile(ctx, "git", args, { cwd: ctx.cwd, reject: false, all: true });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.all}`);
  return res.all.trim();
}

async function currentBranch(ctx: ToolContext): Promise<string> {
  return git(ctx, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

async function ghCreatePr(ctx: ToolContext, pr: PullRequest): Promise<string> {
  const res = await execFile(
    ctx,
    "gh",
    ["pr", "create", "--title", pr.title, "--body", pr.body, "--base", pr.base, "--head", pr.head],
    { cwd: ctx.cwd, reject: false, all: true },
  );
  if (res.exitCode !== 0) throw new Error(`gh pr create failed: ${res.all}`);
  return res.all.trim();
}

export function makeGitTools(ctx: ToolContext, opts: GitOptions): StructuredToolInterface[] {
  const createPr = opts.createPr ?? ((pr: PullRequest, _cwd: string) => ghCreatePr(ctx, pr));

  const gitBranch = tool(
    async ({ name }: { name: string }) => {
      await git(ctx, ["checkout", "-B", name]);
      return `on branch ${name}`;
    },
    {
      name: "git_branch",
      description: "Create (or reset) and switch to a git branch in the workspace.",
      schema: z.object({ name: z.string().describe("branch name, e.g. coble/audit") }),
    },
  );

  const gitCommit = tool(
    async ({ message, paths }: { message: string; paths?: string[] }) => {
      if (paths && paths.length > 0) await git(ctx, ["add", "--", ...paths]);
      else await git(ctx, ["add", "-A"]);
      const status = await git(ctx, ["status", "--porcelain"]);
      if (status.length === 0) return "nothing to commit";
      await git(ctx, ["commit", "-m", message]);
      const sha = await git(ctx, ["rev-parse", "--short", "HEAD"]);
      return `committed ${sha}: ${message}`;
    },
    {
      name: "git_commit",
      description: "Stage changes (all, or specific paths) and create a commit.",
      schema: z.object({
        message: z.string().describe("commit message"),
        paths: z.array(z.string()).optional().describe("specific paths to stage; omit to stage everything"),
      }),
    },
  );

  const gitPush = tool(
    async ({ branch, set_upstream }: { branch?: string; set_upstream?: boolean }) => {
      const b = branch ?? (await currentBranch(ctx));
      const args = ["push"];
      if (set_upstream !== false) args.push("--set-upstream");
      args.push("origin", b);
      await git(ctx, args);
      return `pushed ${b} to origin`;
    },
    {
      name: "git_push",
      description: "Push a branch to origin (sets upstream by default).",
      schema: z.object({
        branch: z.string().optional().describe("branch to push; defaults to current"),
        set_upstream: z.boolean().optional(),
      }),
    },
  );

  const createPullRequest = tool(
    async ({ title, body, base }: { title: string; body: string; base?: string }) => {
      const head = await currentBranch(ctx);
      const pr: PullRequest = { title, body, base: base ?? "main", head };
      if (opts.dryRun) {
        return [
          "DRY RUN — pull request not actually created.",
          `Would open PR: ${pr.head} → ${pr.base}`,
          `Title: ${pr.title}`,
          "Body:",
          pr.body,
        ].join("\n");
      }
      const url = await createPr(pr, ctx.cwd);
      return `opened pull request: ${url}`;
    },
    {
      name: "create_pull_request",
      description:
        "Open a pull request for the current branch. Dry-run by default — prints the PR that would be created without contacting GitHub.",
      schema: z.object({
        title: z.string(),
        body: z.string(),
        base: z.string().optional().describe("base branch, default main"),
      }),
    },
  );

  return [gitBranch, gitCommit, gitPush, createPullRequest];
}
