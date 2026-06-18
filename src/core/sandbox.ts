import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import {
  configuredAllowedDomains,
  presentProviderKeys,
  sandboxDenyReadPaths,
} from "./config.js";

/**
 * The OS-level isolation layer. It sits *under* the approval gate, not instead
 * of it: the deterministic classifier + `interrupt()` still decide whether a
 * call runs; the sandbox decides what an approved command can actually touch
 * (filesystem jail + network egress allowlist), and it binds the command's
 * whole subprocess tree the way an app-level check never can.
 *
 * The default implementation is a no-op passthrough (`noopSandbox`) so coble's
 * behavior is unchanged unless `--sandbox` is requested. `runtimeSandbox` backs
 * it with Anthropic's `@anthropic-ai/sandbox-runtime` (Seatbelt on macOS,
 * bubblewrap on Linux/WSL2), which also stands up the egress proxy.
 */
export interface Sandbox {
  /** Stand up the backend (proxies, dependency checks). Call once per run. */
  init(): Promise<void>;
  /** Wrap a shell command line so the OS confines it. Passthrough when inactive. */
  wrap(command: string): Promise<string>;
  /** Tear down the backend. Idempotent; safe to call when never initialized. */
  dispose(): Promise<void>;
  /** True once init() engaged a real OS boundary (wrap actually confines). */
  readonly active: boolean;
  /** One-line backend description for logs / `coble doctor`. */
  readonly status: string;
  /**
   * A copy of process.env with provider API keys removed, for sandboxed
   * subprocesses (so an approved command cannot `echo $OPENAI_API_KEY` out).
   * Returns undefined when there is nothing to scrub (use the inherited env).
   */
  scrubEnv(): NodeJS.ProcessEnv | undefined;
  /**
   * Absolute paths whose contents must never be read. The OS backend enforces
   * this for subprocesses (bash/git); coble's in-process fs tools consult the
   * same list so `read_file`/`edit_file` cannot surface a secret (e.g. the
   * workspace `.env`) that the subprocess deny-read + key scrub are meant to
   * keep out of reach. This is the static policy, returned whenever `--sandbox`
   * was requested — independent of whether the OS backend actually engaged, so
   * the in-process guard holds even where the backend is unavailable. Empty for
   * the no-op sandbox (no policy requested ⇒ no behavior change).
   */
  denyReadPaths(): string[];
}

export function noopSandbox(): Sandbox {
  return {
    init: async () => {},
    wrap: async (command) => command,
    dispose: async () => {},
    active: false,
    status: "off",
    scrubEnv: () => undefined,
    denyReadPaths: () => [],
  };
}

export interface RuntimeSandboxOptions {
  cwd: string;
  /** Hostnames a sandboxed subprocess may reach. `[]` = no network (default). */
  allowedDomains: string[];
  /** Absolute paths whose reads are denied (secrets: ~/.ssh, ~/.coble, …). */
  denyRead: string[];
  /** Env var names stripped from sandboxed subprocesses (provider keys). */
  envScrub: string[];
  /** Refuse to run (throw from init) rather than fall back when unavailable. */
  strict?: boolean;
  /** Diagnostics sink for fall-back / dependency warnings. */
  onWarn?: (message: string) => void;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Sandbox backed by `@anthropic-ai/sandbox-runtime`. The package is imported
 * dynamically inside init() so the dependency is only loaded when `--sandbox`
 * is actually requested, and so a missing/unsupported backend degrades to a
 * warning-and-passthrough (or a hard error under `strict`) instead of crashing.
 */
export function runtimeSandbox(opts: RuntimeSandboxOptions): Sandbox {
  type SandboxModule = typeof import("@anthropic-ai/sandbox-runtime");
  let mod: SandboxModule | undefined;
  let engaged = false;
  let status = "initializing";
  const warn = opts.onWarn ?? (() => {});

  const fallback = (reason: string): void => {
    status = reason;
    if (opts.strict) throw new Error(`--strict-sandbox: ${reason}`);
    warn(`sandbox inactive — ${reason}; running unsandboxed`);
  };

  return {
    get active() {
      return engaged;
    },
    get status() {
      return status;
    },
    scrubEnv() {
      if (!engaged || opts.envScrub.length === 0) return undefined;
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of opts.envScrub) delete env[key];
      return env;
    },
    denyReadPaths() {
      // Static policy: returned regardless of `engaged` so the in-process fs
      // guard stays on even when the OS backend fell back to passthrough.
      return opts.denyRead;
    },
    async init() {
      // Idempotent: in the interactive TUI the same instance is reused across
      // prompts; re-initializing would tear down and rebuild the (expensive)
      // egress proxy every turn. Skip if already engaged.
      if (engaged) return;
      try {
        mod = await import("@anthropic-ai/sandbox-runtime");
      } catch (err) {
        return fallback(`@anthropic-ai/sandbox-runtime not installed (${errMessage(err)})`);
      }
      const { SandboxManager, getDefaultWritePaths } = mod;
      if (!SandboxManager.isSupportedPlatform()) {
        return fallback(`platform ${process.platform} is unsupported`);
      }
      const deps = SandboxManager.checkDependencies();
      if (deps.errors.length > 0) {
        return fallback(`missing dependencies: ${deps.errors.join("; ")}`);
      }
      for (const w of deps.warnings) warn(`sandbox: ${w}`);

      // Writes confined to the workspace + temp + the backend's own required
      // system paths (e.g. /dev/null). Deny-read protects secrets; egress is
      // default-deny unless allowedDomains is non-empty.
      const allowWrite = Array.from(
        new Set([...getDefaultWritePaths(), path.resolve(opts.cwd), tmpdir()]),
      );
      const config: SandboxRuntimeConfig = {
        network: { allowedDomains: opts.allowedDomains, deniedDomains: [] },
        filesystem: { denyRead: opts.denyRead, allowWrite, denyWrite: [] },
      };
      try {
        await SandboxManager.initialize(config);
      } catch (err) {
        return fallback(`backend failed to start (${errMessage(err)})`);
      }
      engaged = true;
      status =
        opts.allowedDomains.length > 0
          ? `on · egress allowlist: ${opts.allowedDomains.join(", ")}`
          : "on · network denied";
    },
    async wrap(command) {
      if (!engaged || !mod) return command;
      return mod.SandboxManager.wrapWithSandbox(command);
    },
    async dispose() {
      if (mod && engaged) {
        try {
          await mod.SandboxManager.reset();
        } catch {
          // best-effort teardown; the library also resets on process exit.
        }
        engaged = false;
      }
    },
  };
}

/** Best-effort hostname of the `origin` git remote, so an approved push still
 *  reaches it under the egress allowlist. Returns undefined when unavailable. */
export async function gitOriginHost(cwd: string): Promise<string | undefined> {
  try {
    const res = await execa("git", ["-C", cwd, "remote", "get-url", "origin"], {
      reject: false,
      timeout: 3_000,
    });
    if (res.exitCode !== 0) return undefined;
    const url = res.stdout.trim();
    // SSH scp-style: git@github.com:owner/repo.git
    const scp = /^[^@/]+@([^:]+):/.exec(url);
    if (scp) return scp[1];
    try {
      return new URL(url).hostname || undefined;
    } catch {
      return undefined;
    }
  } catch {
    return undefined;
  }
}

export interface BuildSandboxOptions {
  cwd: string;
  /** Whether `--sandbox` was requested. When false, returns a no-op sandbox. */
  enabled: boolean;
  /** `--strict-sandbox`: refuse to run unsandboxed. */
  strict?: boolean;
  /** Extra hostnames from `--allow-domain`. */
  allowDomains?: string[];
  onWarn?: (message: string) => void;
}

/**
 * Resolve CLI/config options into a Sandbox. Off by default; when enabled it
 * derives a default-deny egress allowlist (git remote + explicit opt-ins),
 * the secret-protecting deny-read set, and the provider-key scrub list.
 */
export async function buildSandbox(opts: BuildSandboxOptions): Promise<Sandbox> {
  if (!opts.enabled) return noopSandbox();
  const originHost = await gitOriginHost(opts.cwd);
  const allowedDomains = configuredAllowedDomains([
    ...(opts.allowDomains ?? []),
    ...(originHost ? [originHost] : []),
  ]);
  // The project-local .env is a documented provider-key source (loadLayeredEnv),
  // so scrubbing keys from the env is pointless unless the file is also
  // unreadable — otherwise `cat .env` recovers them inside the sandbox. This
  // same list is exposed via Sandbox.denyReadPaths() and honored by the
  // in-process fs tools, so `read_file .env` cannot recover them either.
  const denyRead = [
    ...sandboxDenyReadPaths(),
    path.join(path.resolve(opts.cwd), ".env"),
    path.join(path.resolve(opts.cwd), ".env.local"),
  ];
  return runtimeSandbox({
    cwd: opts.cwd,
    allowedDomains,
    denyRead,
    envScrub: presentProviderKeys(),
    strict: opts.strict,
    onWarn: opts.onWarn,
  });
}
