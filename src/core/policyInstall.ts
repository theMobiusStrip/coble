import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { COBLE_AGENT_CHILD } from "./childEnv.js";
import { CONTEXT_FILENAME, userContextPath } from "./context.js";

/**
 * Deterministic installer for the agent-security policy block into a context
 * file — user-level `$COBLE_HOME/AGENTS.md` (default) or, with `--project`, the
 * workspace `<cwd>/AGENTS.md`.
 *
 * WHO RUNS THIS (the human, not the agent): the bytes come from a human-named
 * local file, written by deterministic code, never chosen by a model, no
 * network. The user-level `~/.coble/AGENTS.md` is outside every workspace and on
 * the deny-read list, so the agent's fs tools already cannot write it; an agent
 * could still try via `bash` (e.g. `coble policy install` or a bare `cp`), but
 * that is a `dangerous`-tier call gated by the normal approval prompt, and
 * `--sandbox` blocks the out-of-workspace write at the OS layer. The project
 * file is in-workspace and already agent-writable, so `--project` grants no new
 * capability. assertHumanInvocation is a best-effort deterrent on top of those
 * real gates (see its doc + childEnv.ts) — not a boundary.
 *
 * The block is delimited by column-zero markers so re-runs replace it in place:
 *
 *     <!-- BEGIN agentic-security-playbooks v1 -->
 *     ...
 *     <!-- END agentic-security-playbooks v1 -->
 *
 * Everything outside the markers in the TARGET is preserved verbatim. The SOURCE
 * file must be the *rendered policy* (essentially just the block) — the full
 * playbook doc is rejected (loadRenderedPolicy) so we never paste the whole
 * playbook into a context file.
 */

// `\r?$` so a CRLF-saved target's markers still match (else a re-install would
// append a duplicate block instead of replacing in place). Lines are split on
// "\n", so a CRLF line carries a trailing "\r" the regex must tolerate.
const BEGIN_RE = /^<!-- BEGIN agentic-security-playbooks v(\d+) -->\r?$/;
const END_RE = /^<!-- END agentic-security-playbooks v(\d+) -->\r?$/;

interface BlockSpan {
  /** First/last line index (inclusive) of the BEGIN..END run. */
  beginLine: number;
  endLine: number;
  version: number;
}

/**
 * Locate the managed block in `text` by exact, column-zero marker lines.
 * Returns the span, `"malformed"` (markers present but not a single clean pair),
 * or `null` (no markers at all). Indented / fenced example markers — e.g. the
 * sample inside the playbook's own Install section — are NOT column-zero and so
 * never match.
 */
function findBlockSpan(text: string): BlockSpan | "malformed" | null {
  const lines = text.split("\n");
  const begins: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (BEGIN_RE.test(lines[i]!)) begins.push(i);
    if (END_RE.test(lines[i]!)) ends.push(i);
  }
  if (begins.length === 0 && ends.length === 0) return null;
  const begin = begins[0];
  const end = ends[0];
  // Exactly one BEGIN before one END, with matching version numbers, or it is
  // malformed and we refuse to touch it (overwriting could lose user content).
  if (begins.length !== 1 || ends.length !== 1 || begin === undefined || end === undefined || end <= begin) {
    return "malformed";
  }
  const beginVer = Number.parseInt(BEGIN_RE.exec(lines[begin]!)![1]!, 10);
  const endVer = Number.parseInt(END_RE.exec(lines[end]!)![1]!, 10);
  if (beginVer !== endVer) return "malformed";
  return { beginLine: begin, endLine: end, version: beginVer };
}

function spanText(text: string, span: BlockSpan): string {
  return text.split("\n").slice(span.beginLine, span.endLine + 1).join("\n");
}

export interface RenderedPolicy {
  block: string;
  version: number;
}

/**
 * Strictly load a RENDERED policy file: it must contain exactly one clean
 * column-zero block AND nothing but blank lines outside it. The full playbook
 * doc (prose + an example block) is rejected with a pointer to the rendered
 * artifact — installing it would dump the whole playbook into the context file.
 */
export function loadRenderedPolicy(file: string): RenderedPolicy {
  const text = readFileSync(file, "utf8"); // throws ENOENT etc. → caller reports
  const span = findBlockSpan(text);
  if (span === null) {
    throw new Error(
      `${file} has no agentic-security-playbooks block — install the rendered policy (e.g. dist/agent-security-policy.md), not arbitrary markdown.`,
    );
  }
  if (span === "malformed") {
    throw new Error(`malformed agentic-security-playbooks markers in ${file} (need exactly one BEGIN/END pair with matching versions).`);
  }
  const lines = text.split("\n");
  const outside = [...lines.slice(0, span.beginLine), ...lines.slice(span.endLine + 1)];
  if (outside.some((l) => l.trim().length > 0)) {
    throw new Error(`${file} looks like the full playbook, not the rendered policy; install dist/agent-security-policy.md.`);
  }
  return { block: spanText(text, span), version: span.version };
}

export interface PolicyTarget {
  /** Project scope writes <cwd>/AGENTS.md; default is user-level $COBLE_HOME/AGENTS.md. */
  project?: boolean;
  cwd?: string;
}

/** Resolve the context file for the chosen scope. */
export function policyTargetPath(target: PolicyTarget = {}): string {
  return target.project ? path.join(path.resolve(target.cwd ?? process.cwd()), CONTEXT_FILENAME) : userContextPath();
}

export type InstallStatus = "inserted" | "replaced" | "unchanged" | "refused-downgrade" | "malformed-target";

export interface InstallResult {
  status: InstallStatus;
  /** Absolute path of the context file written (or left untouched). */
  path: string;
  /** Canonical block version from the source. */
  version: number;
  /** True for the project scope (workspace AGENTS.md), false for user-level. */
  project: boolean;
}

export interface InstallOptions extends PolicyTarget {
  /** Path to the rendered policy file to install. */
  file: string;
}

/**
 * Install (or update) the policy block from `file` into the chosen context file.
 * Reads only the named local file — no network, no agent. Content outside the
 * managed markers in the target is preserved.
 */
export function installPolicy(opts: InstallOptions): InstallResult {
  const { block, version } = loadRenderedPolicy(opts.file);
  const project = Boolean(opts.project);
  const target = policyTargetPath(opts);
  const base = { path: target, version, project };
  mkdirSync(path.dirname(target), { recursive: true });

  if (!existsSync(target)) {
    writeFileSync(target, `${block}\n`, "utf8");
    return { status: "inserted", ...base };
  }

  const existing = readFileSync(target, "utf8");
  const span = findBlockSpan(existing);

  if (span === "malformed") return { status: "malformed-target", ...base };

  if (span === null) {
    // No managed block yet: append after the user's existing content, one blank
    // line between. Trailing newlines are normalized (writers differ); user
    // content above is untouched.
    const head = existing.replace(/\n*$/, "");
    const next = head.length === 0 ? `${block}\n` : `${head}\n\n${block}\n`;
    writeFileSync(target, next, "utf8");
    return { status: "inserted", ...base };
  }

  // A block already exists. Never downgrade a newer install.
  if (span.version > version) return { status: "refused-downgrade", ...base };

  // Compare ONLY the span, byte-for-byte — surrounding whitespace differs
  // harmlessly between writers and must not force a rewrite.
  if (span.version === version && spanText(existing, span) === block) {
    return { status: "unchanged", ...base };
  }

  const lines = existing.split("\n");
  const next = [...lines.slice(0, span.beginLine), ...block.split("\n"), ...lines.slice(span.endLine + 1)].join("\n");
  writeFileSync(target, next, "utf8");
  return { status: "replaced", ...base };
}

export type UninstallStatus = "removed" | "not-present" | "malformed-target";

export interface UninstallResult {
  status: UninstallStatus;
  path: string;
  project: boolean;
}

/** Remove the managed block from the chosen context file, preserving the rest. */
export function uninstallPolicy(target: PolicyTarget = {}): UninstallResult {
  const file = policyTargetPath(target);
  const project = Boolean(target.project);
  if (!existsSync(file)) return { status: "not-present", path: file, project };
  const existing = readFileSync(file, "utf8");
  const span = findBlockSpan(existing);
  if (span === null) return { status: "not-present", path: file, project };
  if (span === "malformed") return { status: "malformed-target", path: file, project };

  const lines = existing.split("\n");
  // Drop the span plus a single trailing blank separator, so repeated
  // install/uninstall cycles do not accumulate blank lines.
  let end = span.endLine;
  if (lines[end + 1] === "") end += 1;
  const kept = [...lines.slice(0, span.beginLine), ...lines.slice(end + 1)];
  const next = kept.join("\n").replace(/\n*$/, "");
  writeFileSync(file, next.length === 0 ? "" : `${next}\n`, "utf8");
  return { status: "removed", path: file, project };
}

export interface PolicyStatusResult {
  installed: boolean;
  malformed: boolean;
  version?: number;
  path: string;
  project: boolean;
}

/** Report whether the managed block is present in the chosen context file. */
export function policyStatus(target: PolicyTarget = {}): PolicyStatusResult {
  const file = policyTargetPath(target);
  const project = Boolean(target.project);
  if (!existsSync(file)) return { installed: false, malformed: false, path: file, project };
  const span = findBlockSpan(readFileSync(file, "utf8"));
  if (span === null) return { installed: false, malformed: false, path: file, project };
  if (span === "malformed") return { installed: false, malformed: true, path: file, project };
  return { installed: true, malformed: false, version: span.version, path: file, project };
}

/** Thrown when `coble policy install/uninstall` is invoked by the agent, not a human. */
export class AgentBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentBlockedError";
  }
}

/**
 * Best-effort guard so the mutating policy commands lean toward a human at a
 * terminal: refuses if (a) the coble-spawned-subprocess marker is set — the
 * agent shelled out to us — or (b) there is no controlling TTY (also covers
 * headless/CI). NOT a security boundary: an agent that controls its shell can
 * `unset` the marker AND allocate a PTY to fake a TTY, defeating both. The real
 * protections are the `bash` approval gate in front of any agent-issued
 * `coble policy …` call and `--sandbox` (which blocks the `~/.coble` write at the
 * OS layer); this guard only stops the naive case. See childEnv.ts + SECURITY.md.
 * Pure for testing: inject `env`/`isTTY`; the CLI passes the live process values.
 */
export function assertHumanInvocation(opts: { env?: NodeJS.ProcessEnv; isTTY?: boolean } = {}): void {
  const env = opts.env ?? process.env;
  const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY);
  if (env[COBLE_AGENT_CHILD] !== undefined) {
    throw new AgentBlockedError(
      "refusing: `coble policy` cannot be run by the agent (detected a coble-spawned subprocess). Run it yourself in a terminal.",
    );
  }
  if (!isTTY) {
    throw new AgentBlockedError("refusing: `coble policy` must be run interactively in a terminal (no TTY detected).");
  }
}
