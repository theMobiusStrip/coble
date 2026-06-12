import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Root for all coble state. Override with COBLE_HOME (tests use a temp dir). */
export function cobleHome(): string {
  return process.env.COBLE_HOME ?? path.join(homedir(), ".coble");
}

export function ensureHome(): string {
  const home = cobleHome();
  mkdirSync(home, { recursive: true });
  return home;
}

export function checkpointDbPath(): string {
  return path.join(ensureHome(), "checkpoints.db");
}

export function sessionsPath(): string {
  return path.join(ensureHome(), "sessions.json");
}

export function auditLogPath(): string {
  return path.join(ensureHome(), "audit.jsonl");
}

/** Global config file (dotenv format). Read lazily — do not create on read. */
export function globalEnvPath(): string {
  return path.join(cobleHome(), "env");
}
