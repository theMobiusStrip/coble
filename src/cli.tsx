#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import { render } from "ink";
import type { ApprovalPolicy } from "./core/approval.js";
import { formatUsage } from "./core/cost.js";
import { runAgent } from "./core/engine.js";
import { resolveModel } from "./core/models.js";
import { renderPrint } from "./print.js";
import { App } from "./ui/App.js";
import { VERSION } from "./version.js";

const program = new Command();

program
  .name("coble")
  .description("Local, provider-agnostic agent CLI — LangGraph.js core, Ink TUI")
  .version(VERSION)
  .argument("[prompt...]", "task for the agent")
  .option("-p, --print", "non-interactive: run one task, print events, exit")
  .option("-m, --model <spec>", "model as provider:name (openai:gpt-5.5 | anthropic:claude-sonnet-4-6 | ollama:llama3.1 | scripted:file.json)")
  .option("-C, --cwd <dir>", "workspace root", process.cwd())
  .option("--dangerously-allow", "auto-approve dangerous tool calls (shell, push, ...)")
  .option("--paranoid", "also ask approval for workspace writes")
  .action(async (promptWords: string[], opts: {
    print?: boolean;
    model?: string;
    cwd: string;
    dangerouslyAllow?: boolean;
    paranoid?: boolean;
  }) => {
    const prompt = promptWords.join(" ").trim();
    const cwd = path.resolve(opts.cwd);
    const policy: ApprovalPolicy = {
      autoTier: opts.paranoid ? "safe" : "confirm",
      dangerouslyAllow: opts.dangerouslyAllow ?? false,
    };

    if (opts.print) {
      if (prompt.length === 0) program.error("print mode needs a prompt: coble -p \"do something\"");
      const { model, label } = await resolveModel(opts.model);
      const events = runAgent({ prompt, cwd, model, policy });
      process.exitCode = await renderPrint(events, {
        modelLabel: label,
        formatUsage: (u) => formatUsage(label, u),
      });
      return;
    }

    render(
      <App cwd={cwd} modelSpec={opts.model} policy={policy} initialPrompt={prompt.length > 0 ? prompt : undefined} />,
    );
  });

await program.parseAsync();
