import { execa } from "execa";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { ToolContext } from "./fsTools.js";

const MAX_OUTPUT_CHARS = 16_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export function capOutput(s: string, max = MAX_OUTPUT_CHARS): string {
  return s.length > max ? `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]` : s;
}

export function makeBashTool(ctx: ToolContext) {
  return tool(
    async ({ command, timeout_ms }: { command: string; timeout_ms?: number }) => {
      const res = await execa(command, {
        shell: true,
        cwd: ctx.cwd,
        timeout: timeout_ms ?? DEFAULT_TIMEOUT_MS,
        reject: false,
        all: true,
        stripFinalNewline: false,
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
