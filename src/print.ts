import type { AgentEvent } from "./core/events.js";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

/**
 * Headless renderer: consume engine events, write plain lines to stdout.
 * Returns the process exit code.
 */
export async function renderPrint(
  events: AsyncIterable<AgentEvent>,
  opts: { modelLabel: string; formatUsage: (usage: { inputTokens: number; outputTokens: number }) => string },
): Promise<number> {
  let exitCode = 0;
  let streaming = false;

  const closeStream = () => {
    if (streaming) {
      process.stdout.write("\n");
      streaming = false;
    }
  };

  for await (const ev of events) {
    switch (ev.type) {
      case "token":
        process.stdout.write(ev.text);
        streaming = true;
        break;
      case "model_end":
        closeStream();
        break;
      case "tool_start":
        console.log(dim(`⚙ ${ev.name}(${ev.input})`));
        break;
      case "tool_end":
        console.log(dim(`${ev.ok ? "✓" : "✗"} ${ev.name} ${ev.ok ? "" : "failed "}(${ev.ms}ms)`));
        break;
      case "tool_denied":
        console.log(red(`✗ denied: ${ev.name}(${ev.input}) — ${ev.reason}`));
        break;
      case "approval_required":
        // Print mode cannot ask; the policy layer already denied or allowed.
        break;
      case "interrupted":
        closeStream();
        console.log(dim("(run paused awaiting approval — resume from the TUI or with --dangerously-allow)"));
        break;
      case "final":
        closeStream();
        if (ev.capped && ev.text.trim().length === 0) {
          console.log(red(`⚠ stopped at the ${ev.steps}-step limit without a final answer`));
          exitCode = 1;
        }
        console.log(dim(`— done: ${ev.steps} step(s), ${opts.formatUsage(ev.usage)} [${opts.modelLabel}]`));
        break;
      case "error":
        closeStream();
        console.error(red(`error: ${ev.message}`));
        exitCode = 1;
        break;
    }
  }
  return exitCode;
}
