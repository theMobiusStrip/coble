import { existsSync, statSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { HumanMessage } from "@langchain/core/messages";
import { maskValue, sourceOf } from "./core/config.js";
import { resolveModel, type ResolvedModel } from "./core/models.js";
import { ensureHome, globalEnvPath } from "./core/store.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorOptions {
  /** Make live network calls (provider ping, ollama reachability). */
  ping: boolean;
  cwd?: string;
}

const PROVIDER_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;

async function checkBinary(name: string, args: string[]): Promise<string | null> {
  try {
    const res = await execa(name, args, { reject: false, timeout: 5_000 });
    return res.exitCode === 0 ? (res.stdout || res.stderr).split("\n")[0] ?? "" : null;
  } catch {
    return null;
  }
}

export async function runDoctor(opts: DoctorOptions): Promise<{ results: CheckResult[]; exitCode: number }> {
  const results: CheckResult[] = [];
  const cwd = opts.cwd ?? process.cwd();
  const push = (name: string, status: CheckStatus, detail: string) => results.push({ name, status, detail });

  // node version
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  push("node", major >= 22 ? "ok" : "fail", `v${process.versions.node}${major >= 22 ? "" : " (need ≥22)"}`);

  // coble home writable (created on demand, same as at runtime)
  let home = "";
  try {
    home = ensureHome();
    const probe = path.join(home, ".doctor-probe");
    writeFileSync(probe, "ok");
    rmSync(probe);
    push("state dir", "ok", `${home} (writable)`);
  } catch (err) {
    push("state dir", "fail", `${home} not writable: ${err instanceof Error ? err.message : String(err)}`);
  }

  // global config file + permissions
  const cfgPath = globalEnvPath();
  if (!existsSync(cfgPath)) {
    push("global config", "warn", `${cfgPath} not created yet — coble config set OPENAI_API_KEY <key>`);
  } else {
    const mode = statSync(cfgPath).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      push("global config", "warn", `${cfgPath} is mode ${mode.toString(8)} — expected 600 (chmod 600 to fix)`);
    } else {
      push("global config", "ok", cfgPath);
    }
  }

  // provider keys (masked, with provenance)
  let anyKey = false;
  for (const key of PROVIDER_KEYS) {
    const value = process.env[key];
    if (value === undefined) {
      push(key, "warn", "not set");
      continue;
    }
    anyKey = true;
    push(key, "ok", `${maskValue(value)} (from ${sourceOf(key, cwd) ?? "shell"})`);
  }

  // default model resolution (kept for the ping below — no second resolve)
  let resolved: ResolvedModel | undefined;
  try {
    resolved = await resolveModel(undefined);
    push("default model", "ok", resolved.label);
  } catch (err) {
    const first = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "unresolved";
    const usingOllama = (process.env.COBLE_MODEL ?? "").startsWith("ollama:");
    push("default model", anyKey || usingOllama ? "warn" : "fail", first);
  }

  // ollama reachability (free, fast) — only when pinging
  if (opts.ping) {
    const host = process.env.OLLAMA_HOST ?? "http://localhost:11434";
    try {
      const res = await fetch(`${host}/api/version`, { signal: AbortSignal.timeout(1_500) });
      push("ollama", res.ok ? "ok" : "warn", `${host} (${res.status})`);
    } catch {
      push("ollama", "warn", `${host} not reachable (fine unless you use -m ollama:…)`);
    }
  }

  // live provider ping (costs a fraction of a cent)
  if (opts.ping && resolved !== undefined && !resolved.label.startsWith("ollama:")) {
    try {
      const t0 = Date.now();
      await resolved.model.invoke([new HumanMessage("Reply with exactly: ok")], {
        signal: AbortSignal.timeout(20_000),
      });
      push("provider ping", "ok", `${resolved.label} responded in ${Date.now() - t0}ms`);
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";
      push("provider ping", "fail", msg.slice(0, 120));
    }
  }

  // git / gh
  const gitV = await checkBinary("git", ["--version"]);
  push("git", gitV !== null ? "ok" : "warn", gitV ?? "not found (needed for coble review)");
  const ghV = await checkBinary("gh", ["--version"]);
  if (ghV === null) {
    push("gh", "warn", "not found (only needed for live PRs: coble review --live-pr)");
  } else {
    const auth = await checkBinary("gh", ["auth", "status"]);
    push("gh", auth !== null ? "ok" : "warn", auth !== null ? `${ghV}, authenticated` : `${ghV}, not authenticated`);
  }

  const exitCode = results.some((r) => r.status === "fail") ? 1 : 0;
  return { results, exitCode };
}

const GLYPH: Record<CheckStatus, string> = { ok: "\x1b[32m✓\x1b[0m", warn: "\x1b[33m⚠\x1b[0m", fail: "\x1b[31m✗\x1b[0m" };

export function renderDoctor(results: CheckResult[]): string {
  const width = Math.max(...results.map((r) => r.name.length)) + 2;
  return results.map((r) => `${GLYPH[r.status]} ${r.name.padEnd(width)}${r.detail}`).join("\n");
}
