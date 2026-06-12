#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { render } from "ink";
import type { ApprovalPolicy } from "./core/approval.js";
import { openAuditLog } from "./core/audit.js";
import {
  KNOWN_KEYS,
  loadLayeredEnv,
  maskValue,
  readEnvFile,
  setGlobalConfig,
  unsetGlobalConfig,
} from "./core/config.js";

// Config precedence: shell env > <cwd>/.env > ~/.coble/env (see core/config.ts).
loadLayeredEnv();
import { openCheckpointer } from "./core/checkpointer.js";
import { formatUsage } from "./core/cost.js";
import { runAgent } from "./core/engine.js";
import { resolveModel } from "./core/models.js";
import { REVIEW_PROMPT } from "./core/prompts.js";
import { observeSession } from "./core/sessionRunner.js";
import { openSessionStore } from "./core/sessions.js";
import { auditLogPath, globalEnvPath } from "./core/store.js";
import { makeGitTools } from "./core/tools/gitTools.js";
import { renderDoctor, runDoctor } from "./doctor.js";
import { loadTasks } from "./eval/load.js";
import { renderConsole, renderMarkdown } from "./eval/report.js";
import { runAll, scriptedModelFor, type ModelForTask } from "./eval/run.js";
import { runHeadless } from "./headless.js";
import { renderPrint } from "./print.js";
import { formatSessionsTable } from "./sessionsView.js";
import { App } from "./ui/App.js";
import { VERSION } from "./version.js";

const TASKS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../evals/tasks");

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
      process.exitCode = await runHeadless({ prompt, cwd, model, modelLabel: label, policy });
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
  .command("review")
  .description("audit a repository → AUDIT.md → branch + pull request (dry-run)")
  .argument("[path]", "repo path", process.cwd())
  .option("-m, --model <spec>", "model as provider:name")
  .option("--live-pr", "actually open the PR via gh (default: dry-run)")
  .option("--dangerously-allow", "auto-approve git/PR actions (needed for headless runs)")
  .option("--paranoid", "also ask approval for workspace writes")
  .action(async function (this: Command, repoPath: string) {
    // -m collides with the root command's flag; merge globals to read it.
    const opts = this.optsWithGlobals() as {
      model?: string;
      livePr?: boolean;
      dangerouslyAllow?: boolean;
      paranoid?: boolean;
    };
    const cwd = path.resolve(repoPath);
    const { model, label } = await resolveModel(opts.model);
    const gitTools = makeGitTools({ cwd }, { dryRun: !opts.livePr });
    process.exitCode = await runHeadless({
      prompt: "Audit this repository and open a pull request with your findings.",
      cwd,
      model,
      modelLabel: label,
      policy: policyFrom(opts),
      extraTools: gitTools,
      systemExtra: REVIEW_PROMPT,
    });
  });

program
  .command("eval")
  .description("run the eval suite (scripted by default; --model for a real model)")
  .option("-m, --model <spec>", "run against a real model instead of the scripted fixtures")
  .option("-f, --filter <substr>", "only run tasks whose id includes this substring")
  .option("--write", "write evals/RESULTS.md")
  .option("--tasks <dir>", "tasks directory", TASKS_DIR)
  .action(async function (this: Command) {
    // -m collides with the root command's flag; merge globals to read it.
    const opts = this.optsWithGlobals() as { model?: string; filter?: string; write?: boolean; tasks: string };
    let tasks = loadTasks(opts.tasks);
    if (opts.filter) tasks = tasks.filter((t) => t.id.includes(opts.filter!));
    if (tasks.length === 0) {
      program.error("no tasks matched");
      return;
    }

    let modelFor: ModelForTask = scriptedModelFor;
    let label = "scripted";
    if (opts.model) {
      const resolved = await resolveModel(opts.model);
      label = resolved.label;
      modelFor = () => ({ model: resolved.model, label: resolved.label });
    }

    const results = await runAll(tasks, modelFor, Date.now());
    const { passed, total } = renderConsole(results, label);

    if (opts.write) {
      const md = renderMarkdown(results, { model: label, dateIso: new Date().toISOString().slice(0, 10) });
      const out = path.resolve(opts.tasks, "..", "RESULTS.md");
      writeFileSync(out, md, "utf8");
      console.log(`\nwrote ${path.relative(process.cwd(), out)}`);
    }
    process.exitCode = passed === total ? 0 : 1;
  });

program
  .command("doctor")
  .description("check your setup: node, state dir, keys, model, connectivity, git/gh")
  .option("--no-ping", "skip live network checks (provider ping, ollama)")
  .action(async (opts: { ping: boolean }) => {
    const { results, exitCode } = await runDoctor({ ping: opts.ping });
    console.log(renderDoctor(results));
    if (exitCode !== 0) {
      console.log("\n\x1b[31msome checks failed\x1b[0m — fix the ✗ items above and re-run.");
    }
    process.exitCode = exitCode;
  });

const config = program
  .command("config")
  .description("manage global config at ~/.coble/env (keys, default model)");

config
  .command("set <key> <value>")
  .description("save a key, e.g. coble config set OPENAI_API_KEY sk-...")
  .action((key: string, value: string) => {
    setGlobalConfig(key, value);
    if (!(KNOWN_KEYS as readonly string[]).includes(key)) {
      console.log(`note: "${key}" is not a key coble reads itself; saving anyway.`);
    }
    console.log(`saved ${key}=${maskValue(value)} → ${globalEnvPath()}`);
    console.log("effective for every coble run, in any directory.");
  });

config
  .command("get <key>")
  .description("show one value (masked unless --reveal)")
  .option("--reveal", "print the raw value")
  .action((key: string, opts: { reveal?: boolean }) => {
    const vars = readEnvFile(globalEnvPath());
    const value = vars[key];
    if (value === undefined) {
      console.log(`${key} is not set in ${globalEnvPath()}`);
      process.exitCode = 1;
      return;
    }
    console.log(opts.reveal ? value : maskValue(value));
  });

config
  .command("list")
  .description("show all saved keys (values masked unless --reveal)")
  .option("--reveal", "print raw values")
  .action((opts: { reveal?: boolean }) => {
    const vars = readEnvFile(globalEnvPath());
    const entries = Object.entries(vars);
    if (entries.length === 0) {
      console.log(`no config yet — try: coble config set OPENAI_API_KEY <key>`);
      return;
    }
    for (const [k, v] of entries) console.log(`${k}=${opts.reveal ? v : maskValue(v)}`);
  });

config
  .command("unset <key>")
  .description("remove a key from the global config")
  .action((key: string) => {
    const removed = unsetGlobalConfig(key);
    console.log(removed ? `removed ${key}` : `${key} was not set`);
    if (!removed) process.exitCode = 1;
  });

config
  .command("path")
  .description("print the global config file path")
  .action(() => {
    console.log(globalEnvPath());
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

try {
  await program.parseAsync();
} catch (err) {
  console.error(`\x1b[31m${err instanceof Error ? err.message : String(err)}\x1b[0m`);
  process.exitCode = 1;
}
