#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import { render } from "ink";
import type { ApprovalPolicy } from "./core/approval.js";
import { openAuditLog } from "./core/audit.js";
import { openCheckpointer } from "./core/checkpointer.js";
import { formatUsage } from "./core/cost.js";
import { runAgent } from "./core/engine.js";
import { resolveModel } from "./core/models.js";
import { observeSession } from "./core/sessionRunner.js";
import { openSessionStore } from "./core/sessions.js";
import { auditLogPath } from "./core/store.js";
import { renderPrint } from "./print.js";
import { formatSessionsTable } from "./sessionsView.js";
import { App } from "./ui/App.js";
import { VERSION } from "./version.js";

function policyFrom(opts: { dangerouslyAllow?: boolean; paranoid?: boolean }): ApprovalPolicy {
  return {
    autoTier: opts.paranoid ? "safe" : "confirm",
    dangerouslyAllow: opts.dangerouslyAllow ?? false,
  };
}

const program = new Command();

program
  .name("coble")
  .description("Local, provider-agnostic agent CLI — LangGraph.js core, Ink TUI")
  .version(VERSION);

program
  .argument("[prompt...]", "task for the agent")
  .option("-p, --print", "non-interactive: run one task, print events, exit")
  .option("-m, --model <spec>", "provider:name (openai:gpt-5.5 | anthropic:claude-sonnet-4-6 | ollama:llama3.1 | scripted:file.json)")
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
    const policy = policyFrom(opts);

    if (opts.print) {
      if (prompt.length === 0) program.error('print mode needs a prompt: coble -p "do something"');
      const { model, label } = await resolveModel(opts.model);
      const store = openSessionStore();
      const audit = openAuditLog(auditLogPath());
      const session = store.create({ cwd, model: label, prompt, nowIso: new Date().toISOString() });
      const events = observeSession(
        runAgent({ prompt, cwd, model, policy, checkpointer: openCheckpointer(), threadId: session.id, audit: audit.record }),
        store,
        session.id,
      );
      console.log(`\x1b[2msession ${session.id}\x1b[0m`);
      process.exitCode = await renderPrint(events, { modelLabel: label, formatUsage: (u) => formatUsage(label, u) });
      return;
    }

    render(
      <App cwd={cwd} modelSpec={opts.model} policy={policy} initialPrompt={prompt.length > 0 ? prompt : undefined} />,
    );
  });

program
  .command("sessions")
  .description("list past and active sessions")
  .action(() => {
    const store = openSessionStore();
    console.log(formatSessionsTable(store.list(), Date.now()));
  });

program
  .command("audit")
  .description("show the tool-call audit log")
  .option("-n, --tail <count>", "show only the last N entries", (v) => Number.parseInt(v, 10))
  .action((opts: { tail?: number }) => {
    const entries = openAuditLog(auditLogPath()).entries();
    const shown = opts.tail ? entries.slice(-opts.tail) : entries;
    if (shown.length === 0) {
      console.log("audit log is empty.");
      return;
    }
    for (const e of shown) {
      console.log(`${e.ts}  ${e.decision.toUpperCase().padEnd(8)} ${e.tier.padEnd(9)} ${e.tool}(${e.summary})`);
    }
  });

program
  .command("resume")
  .description("continue a session from its last checkpoint")
  .argument("<id>", "session id (or unique prefix)")
  .option("--dangerously-allow", "auto-approve dangerous tool calls")
  .option("--paranoid", "also ask approval for workspace writes")
  .action(async (id: string, opts: { dangerouslyAllow?: boolean; paranoid?: boolean }) => {
    const store = openSessionStore();
    const session = store.resolve(id);
    if (session === undefined) {
      program.error(`no session matching "${id}"`);
      return;
    }
    const { model, label } = await resolveModel(session.model.includes(":") ? session.model : undefined);
    const audit = openAuditLog(auditLogPath());
    const events = observeSession(
      runAgent({
        resume: true,
        cwd: session.cwd,
        model,
        policy: policyFrom(opts),
        checkpointer: openCheckpointer(),
        threadId: session.id,
        audit: audit.record,
      }),
      store,
      session.id,
    );
    console.log(`\x1b[2mresuming session ${session.id}\x1b[0m`);
    process.exitCode = await renderPrint(events, { modelLabel: label, formatUsage: (u) => formatUsage(label, u) });
  });

await program.parseAsync();
