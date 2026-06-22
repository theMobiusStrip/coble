import { execa } from "execa";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { COBLE_AGENT_CHILD } from "../childEnv.js";
import type { ToolContext } from "./fsTools.js";

const MAX_OUTPUT_CHARS = 16_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export function capOutput(s: string, max = MAX_OUTPUT_CHARS): string {
  return s.length > max ? `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]` : s;
}

/** The bash tool never throws — it reports a failed/timed-out command by
 *  prefixing its result with "exit code …" (a successful run returns early).
 *  Renderers use this to show ✗ instead of a misleading ✓ for such results. */
export function bashFailed(name: string, output: string): boolean {
  return name === "bash" && output.startsWith("exit code ");
}

export function makeBashTool(ctx: ToolContext) {
  return tool(
    async ({ command, timeout_ms }: { command: string; timeout_ms?: number }) => {
      // When a sandbox is active, run the command inside the OS boundary and
      // strip provider API keys from its environment. Passthrough otherwise.
      const sandbox = ctx.sandbox;
      const toRun = sandbox?.active ? await sandbox.wrap(command) : command;
      const scrubbed = sandbox?.active ? sandbox.scrubEnv() : undefined;
      // Mark every agent-spawned subprocess so trusted human-only commands
      // (`coble policy …`) can refuse when shelled out to by the agent. Set in
      // both modes: scrubbed env is a full replacement (extendEnv:false), so add
      // it there too, not just the inherited-env path.
      const res = await execa(toRun, {
        shell: true,
        cwd: ctx.cwd,
        timeout: timeout_ms ?? DEFAULT_TIMEOUT_MS,
        reject: false,
        all: true,
        stripFinalNewline: false,
        ...(scrubbed
          ? { env: { ...scrubbed, [COBLE_AGENT_CHILD]: "1" }, extendEnv: false }
          : { env: { [COBLE_AGENT_CHILD]: "1" } }),
      });
      const out = capOutput(res.all ?? "");
      if (res.exitCode === 0) return out.length > 0 ? out : "(no output)";
      return `exit code ${res.exitCode}\n${out}`;
    },
    {
      name: "bash",
      description:
        "Run a shell command in the workspace root. Read-only commands run freely; anything mutating requires user approval and may be denied — adapt if so.",
      schema: z.object({
        command: z.string().describe("shell command line"),
        timeout_ms: z.number().optional().describe("timeout in milliseconds (default 30000)"),
      }),
    },
  );
}
