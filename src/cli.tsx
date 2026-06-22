#!/usr/bin/env node
import { existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { Command } from "commander";
import { render } from "ink";
import { policyForMode, PERMISSION_MODES, type ApprovalPolicy, type PermissionMode } from "./core/approval.js";
import { openAuditLog } from "./core/audit.js";
import {
  KNOWN_KEYS,
  loadLayeredEnv,
  maskValue,
  readEnvFile,
  setGlobalConfig,
  unsetGlobalConfig,
} from "./core/config.js";

import { openCheckpointer } from "./core/checkpointer.js";
import { loadContextFile } from "./core/context.js";
import { formatUsage } from "./core/cost.js";
import { runAgent } from "./core/engine.js";
import { resolveModel } from "./core/models.js";
import { assertHumanInvocation, installPolicy, policyStatus, uninstallPolicy } from "./core/policyInstall.js";
import { REVIEW_PROMPT } from "./core/prompts.js";
import { buildSandbox, type Sandbox } from "./core/sandbox.js";
import { loadSettings } from "./core/settings.js";
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

const warnStderr = (m: string) => console.error(`\x1b[33m⚠ ${m}\x1b[0m`);

interface RunOpts {
  permissionMode?: string;
  dangerouslyAllow?: boolean;
  paranoid?: boolean;
  sandbox?: boolean;
  strictSandbox?: boolean;
  allowDomain?: string[];
}

/** Resolve the permission policy from flags + layered settings. Precedence:
 *  --permission-mode > legacy --paranoid/--dangerously-allow > settings.defaultMode. */
function resolvePermissions(opts: RunOpts, cwd: string): { policy: ApprovalPolicy; autoModel?: string } {
  const settings = loadSettings({ cwd, onWarn: warnStderr });
  if (opts.dangerouslyAllow && opts.paranoid) {
    program.error("--paranoid and --dangerously-allow are mutually exclusive (opposite safety intent)");
  }
  let mode: PermissionMode;
  if (opts.permissionMode !== undefined) {
    if (!(PERMISSION_MODES as readonly string[]).includes(opts.permissionMode)) {
      program.error(`invalid --permission-mode "${opts.permissionMode}" (expected: ${PERMISSION_MODES.join(", ")})`);
    }
    mode = opts.permissionMode as PermissionMode;
  } else if (opts.dangerouslyAllow) mode = "bypass";
  else if (opts.paranoid) mode = "careful";
  else mode = settings.defaultMode ?? "default";
  return { policy: policyForMode(mode, settings.rules), autoModel: settings.autoModel };
}

/**
 * Resolve a separate classifier model for `auto` mode (settings.autoMode.model
 * or COBLE_AUTO_MODEL). Returns `configured` so the caller can tell apart:
 *  - not configured     → fall back to the agent model (the convenient default)
 *  - configured + ok    → use it
 *  - configured + failed → `model` undefined ⇒ caller must NOT fall back to the
 *    agent model; auto mode then fails closed (the configured judge is gone).
 */
async function resolveAutoModel(spec?: string): Promise<{ configured: boolean; model?: BaseChatModel }> {
  const s = spec ?? process.env.COBLE_AUTO_MODEL;
  if (!s) return { configured: false };
  try {
    return { configured: true, model: (await resolveModel(s)).model };
  } catch (err) {
    warnStderr(
      `auto-mode classifier "${s}" unavailable: ${err instanceof Error ? err.message : String(err)} — auto mode will deny would-prompt actions`,
    );
    return { configured: true };
  }
}

/** Pick the classifier model for auto mode: the configured one (or undefined,
 *  which fails closed, if it failed to resolve), else the agent model. */
function classifierFor(auto: { configured: boolean; model?: BaseChatModel }, agent: BaseChatModel): BaseChatModel | undefined {
  return auto.configured ? auto.model : agent;
}

/** Build the OS sandbox from CLI flags. Off (no-op) unless --sandbox is set. */
function sandboxFrom(opts: RunOpts, cwd: string): Promise<Sandbox> {
  warnIfAllowDomainWithoutSandbox(opts);
  return buildSandbox({
    cwd,
    enabled: opts.sandbox === true || opts.strictSandbox === true,
    strict: opts.strictSandbox === true,
    allowDomains: opts.allowDomain,
    onWarn: warnStderr,
  });
}

const collectDomain = (v: string, acc: string[]): string[] => acc.concat(v);

/** Fail fast on a typo'd workspace root rather than running against a bad cwd
 *  and emitting opaque per-tool failures. */
function assertWorkspace(cwd: string): void {
  if (!existsSync(cwd)) program.error(`workspace root not found: ${cwd}`);
  if (!statSync(cwd).isDirectory()) program.error(`workspace root is not a directory: ${cwd}`);
}

/** --allow-domain only does anything under --sandbox; warn rather than silently
 *  discard it (the user likely believes egress is being scoped). */
function warnIfAllowDomainWithoutSandbox(opts: RunOpts): void {
  if ((opts.allowDomain?.length ?? 0) > 0 && opts.sandbox !== true && opts.strictSandbox !== true) {
    warnStderr("--allow-domain has no effect without --sandbox; egress is unrestricted");
  }
}

/** Permission + sandbox flags shared by the run-capable commands. */
function withRunFlags(cmd: Command): Command {
  return cmd
    .option("--permission-mode <mode>", `permission mode: ${PERMISSION_MODES.join(" | ")}`)
    .option("--paranoid", "alias for --permission-mode careful")
    .option("--dangerously-allow", "alias for --permission-mode bypass")
    .option("--sandbox", "confine bash/git in an OS sandbox (fs jail + egress allowlist)")
    .option("--strict-sandbox", "refuse to run if the sandbox is unavailable (implies --sandbox)")
    .option("--allow-domain <host>", "permit a hostname under --sandbox (repeatable)", collectDomain, []);
}

const program = new Command();

program
  .name("coble")
  .description("Local, provider-agnostic agent CLI — LangGraph.js core, Ink TUI")
  .version(VERSION);

withRunFlags(
  program
    .argument("[prompt...]", "task for the agent")
    .option("-p, --print", "non-interactive: run one task, print events, exit")
    .option("-m, --model <spec>", "provider:name (openai:gpt-5.5 | anthropic:claude-sonnet-4-6 | google:gemini-3.5-flash | ollama:llama3.1 | scripted:file.json)")
    .option("-C, --cwd <dir>", "workspace root", process.cwd()),
)
  .action(async (promptWords: string[], opts: { print?: boolean; model?: string; cwd: string } & RunOpts) => {
    const prompt = promptWords.join(" ").trim();
    const cwd = path.resolve(opts.cwd);
    assertWorkspace(cwd);
    loadLayeredEnv({ cwd }); // load env for the workspace: shell > <cwd>/.env > ~/.coble/env
    const { policy, autoModel } = resolvePermissions(opts, cwd);
    const context = loadContextFile(cwd); // user-level + workspace AGENTS.md → system prompt (trusted)

    if (opts.print) {
      if (prompt.length === 0) program.error('print mode needs a prompt: coble -p "do something"');
      const { model, label } = await resolveModel(opts.model);
      const sandbox = await sandboxFrom(opts, cwd);
      const classifierModel = policy.mode === "auto" ? classifierFor(await resolveAutoModel(autoModel), model) : undefined;
      process.exitCode = await runHeadless({ prompt, cwd, model, modelLabel: label, policy, systemExtra: context, sandbox, classifierModel });
      return;
    }

    // The interactive TUI needs a real terminal (Ink requires raw-mode stdin).
    // Without one — piped stdin, or a typo'd subcommand that lands here as a
    // prompt — fail with guidance instead of a raw framework stack trace.
    if (!process.stdin.isTTY) {
      program.error('no interactive terminal detected — use `coble -p "<task>"` for non-interactive runs');
    }
    warnIfAllowDomainWithoutSandbox(opts);

    // TUI: suppress sandbox warnings to stderr (they would corrupt the Ink
    // render); `coble doctor` reports backend status instead.
    const sandbox = await buildSandbox({
      cwd,
      enabled: opts.sandbox === true || opts.strictSandbox === true,
      strict: opts.strictSandbox === true,
      allowDomains: opts.allowDomain,
    });
    const auto = await resolveAutoModel(autoModel); // explicit classifier (if any); App falls back to its model only when none is configured
    const audit = openAuditLog(auditLogPath()); // interactive sessions are auditable too
    render(
      <App
        cwd={cwd}
        modelSpec={opts.model}
        policy={policy}
        initialPrompt={prompt.length > 0 ? prompt : undefined}
        systemExtra={context}
        sandbox={sandbox}
        classifierModel={auto.model}
        autoClassifierConfigured={auto.configured}
        audit={audit.record}
      />,
    );
  });

program
  .command("sessions")
  .description("list past and active sessions")
  .action(() => {
    const store = openSessionStore();
    console.log(formatSessionsTable(store.list(), Date.now()));
  });

withRunFlags(
  program
    .command("review")
    .description("audit a repository → AUDIT.md → branch pushed to origin → PR (opened only with --live-pr)")
    .argument("[path]", "repo path", process.cwd())
    .option("-m, --model <spec>", "model as provider:name")
    .option("--live-pr", "open the PR via gh (default: push the audit branch but stop short of opening a PR)"),
)
  .action(async function (this: Command, repoPath: string) {
    // -m collides with the root command's flag; merge globals to read it.
    const opts = this.optsWithGlobals() as { model?: string; livePr?: boolean } & RunOpts;
    const cwd = path.resolve(repoPath);
    assertWorkspace(cwd);
    loadLayeredEnv({ cwd }); // load env for the repo path
    const { model, label } = await resolveModel(opts.model);
    const { policy, autoModel } = resolvePermissions(opts, cwd);
    const sandbox = await sandboxFrom(opts, cwd);
    const gitTools = makeGitTools({ cwd, sandbox }, { dryRun: !opts.livePr });
    const classifierModel = policy.mode === "auto" ? classifierFor(await resolveAutoModel(autoModel), model) : undefined;
    // SECURITY: `review` deliberately does NOT load the target repo's AGENTS.md.
    // Unlike `coble`/`coble -p` (which run in the user's OWN workspace, where
    // AGENTS.md is user-authored and trusted), `review`'s target is an UNTRUSTED
    // repo by definition — promoting its AGENTS.md into the trusted system prompt
    // would let a hostile repo inject trusted instructions (and review attaches
    // push/PR tools). Use only coble's own trusted review playbook.
    process.exitCode = await runHeadless({
      prompt: "Audit this repository and open a pull request with your findings.",
      cwd,
      model,
      modelLabel: label,
      policy,
      extraTools: gitTools,
      systemExtra: REVIEW_PROMPT,
      sandbox,
      classifierModel,
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
    loadLayeredEnv(); // --model resolution may need keys from the global config
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
    loadLayeredEnv(); // pull global ~/.coble/env (keys, model) into process.env
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
  .description("save a key, e.g. coble config set GOOGLE_API_KEY <key>")
  .action((key: string, value: string) => {
    if (key === "COBLE_HOME") {
      console.error(
        "COBLE_HOME can't live in the global config — the config file is located *via* COBLE_HOME.\n" +
          "set it in your shell instead: export COBLE_HOME=/path/to/state",
      );
      process.exitCode = 1;
      return;
    }
    if (value.trim() === "") {
      console.error(`value for ${key} is empty — nothing saved (use \`coble config unset ${key}\` to remove it)`);
      process.exitCode = 1;
      return;
    }
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
      console.log(`no config yet — try: coble config set GOOGLE_API_KEY <key>`);
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

const policy = program
  .command("policy")
  .description("install the agent-security policy block into your AGENTS.md (user-level by default, --project for this repo)");

const scopeWord = (project: boolean) => (project ? "project (this workspace)" : "user-level (every workspace)");

policy
  .command("install <rendered-policy-file>")
  .description("write a rendered policy block into AGENTS.md (run this yourself; the full playbook is rejected)")
  .option("--project", "install into <cwd>/AGENTS.md instead of the user-level ~/.coble/AGENTS.md")
  .action((file: string, opts: { project?: boolean }) => {
    try {
      assertHumanInvocation();
      const r = installPolicy({ file, project: opts.project, cwd: process.cwd() });
      console.log(`${r.path}: ${r.status} (v${r.version}) — ${scopeWord(r.project)}`);
      if (r.status === "refused-downgrade") {
        console.error("target already holds a newer policy version — refusing to downgrade.");
        process.exitCode = 1;
      } else if (r.status === "malformed-target") {
        console.error("existing markers in the target are malformed — not modified; fix or remove them by hand.");
        process.exitCode = 1;
      } else {
        console.log("loaded into the system prompt on your next coble run.");
        // Informational only (override is a valid pattern, not an error): flag a
        // project install that shadows or duplicates an existing user-level block.
        if (r.project) {
          const u = policyStatus({ project: false });
          if (u.installed && u.version === r.version) {
            console.log("note: a user-level block (same version) already applies everywhere — this project copy is redundant.");
          } else if (u.installed) {
            console.log(`note: this project block overrides the user-level policy here (global v${u.version} → project v${r.version}).`);
          }
        }
      }
    } catch (err) {
      program.error(err instanceof Error ? err.message : String(err)); // exits; AgentBlockedError.message included
    }
  });

const statusLine = (s: ReturnType<typeof policyStatus>) =>
  s.malformed ? "malformed markers" : s.installed ? `installed (v${s.version})` : "not installed";

policy
  .command("status")
  .description("show whether the policy block is installed (both scopes)")
  .action(() => {
    try {
      assertHumanInvocation();
      const user = policyStatus({ project: false });
      const proj = policyStatus({ project: true, cwd: process.cwd() });
      console.log(`user-level  ${user.path}: ${statusLine(user)}`);
      console.log(`project     ${proj.path}: ${statusLine(proj)}`);
      if (user.installed && proj.installed) {
        console.log("note: project loads last, overrides global.");
      }
      // Non-zero only when nothing is installed in either scope.
      if (!user.installed && !proj.installed) process.exitCode = 1;
    } catch (err) {
      program.error(err instanceof Error ? err.message : String(err));
    }
  });

policy
  .command("uninstall")
  .description("remove the policy block, preserving the rest of the file (human-only)")
  .option("--project", "remove from <cwd>/AGENTS.md instead of the user-level file")
  .action((opts: { project?: boolean }) => {
    // Guard and mutation in ONE try so the gate fails closed regardless of
    // whether program.error exits (e.g. if exitOverride is ever added).
    try {
      assertHumanInvocation();
      const r = uninstallPolicy({ project: opts.project, cwd: process.cwd() });
      console.log(`${r.path}: ${r.status} — ${scopeWord(r.project)}`);
      if (r.status !== "removed") process.exitCode = 1;
    } catch (err) {
      program.error(err instanceof Error ? err.message : String(err));
    }
  });

program
  .command("audit")
  .description("show the tool-call audit log")
  .option("-n, --tail <count>", "show only the last N entries", (v) => {
    const t = v.trim();
    if (!/^\d+$/.test(t) || Number(t) < 1) program.error(`--tail must be a positive integer (got "${v}")`);
    return Number(t);
  })
  .action((opts: { tail?: number }) => {
    const entries = openAuditLog(auditLogPath()).entries();
    const shown = opts.tail === undefined ? entries : entries.slice(-opts.tail);
    if (shown.length === 0) {
      console.log("audit log is empty.");
      return;
    }
    for (const e of shown) {
      console.log(`${e.ts}  ${e.decision.toUpperCase().padEnd(8)} ${e.tier.padEnd(9)} ${e.tool}(${e.summary})`);
    }
  });

withRunFlags(
  program
    .command("resume")
    .description("continue a session from its last checkpoint")
    .argument("<id>", "session id (or unique prefix)"),
)
  .action(async (id: string, opts: RunOpts) => {
    const store = openSessionStore();
    const session = store.resolve(id);
    if (session === undefined) {
      program.error(`no session matching "${id}"`);
      return;
    }
    // A completed/errored thread has nothing left to run; resuming it would
    // re-print the old step/token counts as if work just happened. Only
    // running/paused sessions reach the agent.
    if (session.status === "done" || session.status === "error") {
      console.log(`session ${session.id} is already ${session.status} — nothing to resume`);
      return;
    }
    loadLayeredEnv({ cwd: session.cwd }); // load env for the session's workspace
    const { model, label } = await resolveModel(session.model.includes(":") ? session.model : undefined);
    const audit = openAuditLog(auditLogPath());
    const { policy, autoModel } = resolvePermissions(opts, session.cwd);
    const sandbox = await sandboxFrom(opts, session.cwd);
    const classifierModel = policy.mode === "auto" ? classifierFor(await resolveAutoModel(autoModel), model) : undefined;
    const events = observeSession(
      runAgent({
        resume: true,
        cwd: session.cwd,
        model,
        policy,
        checkpointer: openCheckpointer(),
        threadId: session.id,
        audit: audit.record,
        sandbox,
        classifierModel,
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
