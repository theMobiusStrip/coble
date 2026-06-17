import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { cobleHome, globalEnvPath } from "./store.js";

/** Keys coble understands. Others are accepted with a warning.
 *  COBLE_HOME is deliberately absent: the global config file lives at
 *  $COBLE_HOME/env, so storing COBLE_HOME inside it is circular — it must
 *  come from the shell (or a project .env). */
export const KNOWN_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "COBLE_MODEL",
  "OLLAMA_HOST",
] as const;

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function maskValue(value: string): string {
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** Parse a dotenv-format file into a plain object. Missing file ⇒ {}. */
export function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  return { ...parseEnv(readFileSync(file, "utf8")) } as Record<string, string>;
}

function serializeValue(value: string): string {
  if (value.includes("\n")) throw new Error("config values must be single-line");
  if (/^[A-Za-z0-9_@:./+=,-]*$/.test(value)) return value; // plain token (API keys land here)
  // util.parseEnv does not unescape \" — so quote with whichever delimiter is unused.
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  throw new Error("config values may not mix single and double quotes");
}

/** Write a dotenv file owner-read/write only (0600). */
export function writeEnvFile(file: string, vars: Record<string, string>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const body = Object.entries(vars)
    .map(([k, v]) => `${k}=${serializeValue(v)}`)
    .join("\n");
  const header = "# coble global config — managed by `coble config`. Loaded for every run.\n";
  writeFileSync(file, header + body + (body.length > 0 ? "\n" : ""), { encoding: "utf8", mode: 0o600 });
  chmodSync(file, 0o600); // writeFileSync mode only applies on create; enforce on rewrite
}

export function setGlobalConfig(key: string, value: string, file: string = globalEnvPath()): void {
  if (!KEY_RE.test(key)) throw new Error(`invalid config key: ${key}`);
  const vars = readEnvFile(file);
  vars[key] = value;
  writeEnvFile(file, vars);
}

export function unsetGlobalConfig(key: string, file: string = globalEnvPath()): boolean {
  const vars = readEnvFile(file);
  if (!(key in vars)) return false;
  delete vars[key];
  writeEnvFile(file, vars);
  return true;
}

export type EnvSource = "shell" | "project" | "global";

/**
 * Load configuration into process.env with precedence:
 *   shell env  >  <cwd>/.env  >  ~/.coble/env
 * Earlier sources win — a file never overrides what is already set.
 * The project .env is loaded first so it may set COBLE_HOME and thereby
 * relocate the global file. Provenance, when needed (doctor), is derived
 * by sourceOf() rather than tracked here.
 */
export function loadLayeredEnv(opts: { cwd?: string } = {}): void {
  const apply = (vars: Record<string, string>) => {
    for (const [k, v] of Object.entries(vars)) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  };
  apply(readEnvFile(path.join(opts.cwd ?? process.cwd(), ".env")));
  apply(readEnvFile(globalEnvPath()));
}

/** Provider API-key env vars — scrubbed from sandboxed subprocesses so an
 *  approved command cannot exfiltrate them. */
export const PROVIDER_ENV_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY"] as const;

/**
 * Absolute paths a sandboxed subprocess must not be able to read. Covers
 * coble's own state (stored API keys + the append-only audit log) and the
 * usual local-credential stores.
 */
export function sandboxDenyReadPaths(): string[] {
  const home = homedir();
  return [
    cobleHome(),
    path.join(home, ".ssh"),
    path.join(home, ".aws"),
    path.join(home, ".gnupg"),
    path.join(home, ".netrc"),
    path.join(home, ".npmrc"),
    path.join(home, ".git-credentials"),
    path.join(home, ".config", "gcloud"),
    path.join(home, ".config", "gh"), // GitHub CLI OAuth token (gh pr create)
    path.join(home, ".docker", "config.json"),
    path.join(home, ".kube"),
  ];
}

/** Provider keys that are actually present in the environment (to scrub). */
export function presentProviderKeys(): string[] {
  return PROVIDER_ENV_KEYS.filter((k) => process.env[k] !== undefined);
}

/**
 * Hostnames a sandboxed subprocess may reach. Default-deny: the list is empty
 * unless the user opts in via `COBLE_ALLOWED_DOMAINS` (comma-separated) or
 * `--allow-domain`. The git remote host is added by the caller when known so
 * an approved `git push` still works. coble's own model API calls are made by
 * the parent process and bypass the sandbox, so the provider host is NOT
 * required here.
 */
export function configuredAllowedDomains(extra: string[] = []): string[] {
  const fromEnv = (process.env.COBLE_ALLOWED_DOMAINS ?? "").split(",");
  // Trim/filter the merged list so the --allow-domain channel behaves like the
  // env channel (no whitespace-padded entries that silently never match).
  return Array.from(
    new Set([...fromEnv, ...extra].map((s) => s.trim()).filter(Boolean)),
  );
}

/** Where an effective env key comes from (for doctor / diagnostics). */
export function sourceOf(key: string, cwd: string = process.cwd()): EnvSource | undefined {
  const value = process.env[key];
  if (value === undefined) return undefined;
  if (readEnvFile(path.join(cwd, ".env"))[key] === value) return "project";
  if (readEnvFile(globalEnvPath())[key] === value) return "global";
  return "shell";
}
