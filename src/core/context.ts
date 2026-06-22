import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { cobleHome } from "./store.js";

/**
 * Context file auto-loaded at bootstrap — the cross-agent standard Codex already
 * uses. Following the Claude (`CLAUDE.md`) / Codex (`AGENTS.md`) pattern: it is
 * the user's own policy, promoted into the system prompt (the TRUSTED channel),
 * never routed through the `read_file` tool (which wraps content as
 * `<untrusted-data>` the agent must not obey).
 *
 * Two layers, both user-authored and trusted, loaded in this order:
 *   1. user-level   — `$COBLE_HOME/AGENTS.md` (global, applies to every workspace)
 *   2. project-level — `<cwd>/AGENTS.md`       (this workspace only)
 *
 * The user-level file lives inside `$COBLE_HOME` (`~/.coble` by default), which
 * is OUTSIDE every workspace and on the sandbox deny-read list, so the agent —
 * even when prompt-injected — can neither read it nor (via `resolveInWorkspace`,
 * which confines writes to the workspace) overwrite it. `COBLE_HOME` is on the
 * project-env denylist, so an untrusted repo cannot redirect it to a file it
 * controls. The project-level file is in-workspace and therefore agent-writable;
 * that is unchanged from before and matches the CLAUDE.md / repo-policy model.
 */
export const CONTEXT_FILENAME = "AGENTS.md";

/** Absolute path to the user-level (global) context file: `$COBLE_HOME/AGENTS.md`. */
export function userContextPath(): string {
  return path.join(cobleHome(), CONTEXT_FILENAME);
}

/** Read a context file if present and non-empty; any error is a clean no-op. */
function readIfPresent(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const text = readFileSync(file, "utf8").trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined; // unreadable (perms, race) → no-op, never fatal
  }
}

/**
 * Load and merge the user-level and project-level context files for use as
 * `systemExtra`. Project-level is appended after user-level so workspace rules
 * are read last (and can build on / locally override the global ones). Returns
 * undefined when neither exists — a clean no-op, exactly as before.
 */
export function loadContextFile(cwd: string): string | undefined {
  const parts = [readIfPresent(userContextPath()), readIfPresent(path.join(cwd, CONTEXT_FILENAME))].filter(
    (p): p is string => p !== undefined,
  );
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
