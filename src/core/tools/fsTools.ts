import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import type { Sandbox } from "../sandbox.js";

const MAX_READ_BYTES = 256 * 1024;

/** True if the path itself exists, WITHOUT following a final symlink — so a
 *  dangling (broken) symlink counts as existing (lstat, not stat/existsSync). */
function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Real (symlink-resolved) location of `node`, which is known to exist via
 * lexists(). `realpathSync` resolves the whole chain when every component
 * exists; if `node` is a dangling symlink (its target is missing) realpathSync
 * throws, so we fall back to resolving the link's own target against the real
 * path of its parent directory. Either way we get the location a write/read
 * through `node` would actually land at.
 */
function realLocation(node: string): string {
  try {
    return realpathSync(node);
  } catch {
    try {
      const parentReal = realpathSync(path.dirname(node));
      return path.resolve(parentReal, readlinkSync(node));
    } catch {
      return node;
    }
  }
}

/**
 * Resolve a workspace-relative path, refusing anything that escapes the root —
 * both lexically and through symlinks.
 *
 * The lexical check rejects `..` traversal and prefix-collision (`/workspace-evil`
 * does not match `/workspace/`). It does NOT catch symlinks: a link inside the
 * workspace (shipped in a cloned repo, or created by an approved write/bash
 * step) such as `link -> /etc` makes `read_file`/`write_file` follow it out of
 * the jail. So we additionally resolve the real location of the deepest
 * component that exists — using lstat so a *dangling* symlink leaf is not
 * silently skipped (it would otherwise pass: the write/read syscall follows the
 * link even though `stat`/`existsSync` report it as missing) — and re-check the
 * prefix against the real workspace root.
 *
 * This closes the static symlink escape (existing-target and dangling-target
 * links, leaf or intermediate). It is not fully TOCTOU-proof — a link swapped
 * in between this check and the syscall could still slip through; the airtight
 * form is `openat2(RESOLVE_BENEATH)`/`O_NOFOLLOW`. It also only confines coble's
 * own fs tools — subprocesses spawned by `bash` are bounded only by the OS
 * sandbox (see sandbox.ts).
 */
export function resolveInWorkspace(cwd: string, p: string): string {
  const root = path.resolve(cwd);
  const abs = path.resolve(root, p);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`path escapes the workspace root: ${p}`);
  }
  const realRoot = realLocation(root);
  let node = abs;
  while (node !== path.dirname(node) && !lexists(node)) {
    node = path.dirname(node);
  }
  const realNode = realLocation(node);
  if (realNode !== realRoot && !realNode.startsWith(realRoot + path.sep)) {
    throw new Error(`path escapes the workspace root via symlink: ${p}`);
  }
  return abs;
}

export interface ToolContext {
  cwd: string;
  /** OS sandbox used to confine subprocesses (bash/git). Default: no-op. */
  sandbox?: Sandbox;
}

export function makeFsTools(ctx: ToolContext): StructuredToolInterface[] {
  const readFileTool = tool(
    async ({ path: p }: { path: string }) => {
      const abs = resolveInWorkspace(ctx.cwd, p);
      const info = await stat(abs);
      if (info.size > MAX_READ_BYTES) {
        const fh = await readFile(abs, { encoding: "utf8" });
        return `${fh.slice(0, MAX_READ_BYTES)}\n...[truncated: file is ${info.size} bytes]`;
      }
      return await readFile(abs, "utf8");
    },
    {
      name: "read_file",
      description:
        "Read a UTF-8 text file. Path is relative to the workspace root. Large files are truncated.",
      schema: z.object({ path: z.string().describe("workspace-relative file path") }),
    },
  );

  const writeFileTool = tool(
    async ({ path: p, content }: { path: string; content: string }) => {
      const abs = resolveInWorkspace(ctx.cwd, p);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
      return `wrote ${Buffer.byteLength(content)} bytes to ${p}`;
    },
    {
      name: "write_file",
      description:
        "Create or overwrite a UTF-8 text file (parent directories are created). Path is relative to the workspace root.",
      schema: z.object({
        path: z.string().describe("workspace-relative file path"),
        content: z.string().describe("full file content"),
      }),
    },
  );

  const editFileTool = tool(
    async ({
      path: p,
      old_string,
      new_string,
      replace_all,
    }: {
      path: string;
      old_string: string;
      new_string: string;
      replace_all?: boolean;
    }) => {
      const abs = resolveInWorkspace(ctx.cwd, p);
      const before = await readFile(abs, "utf8");
      const count = before.split(old_string).length - 1;
      if (count === 0) {
        throw new Error(`old_string not found in ${p}`);
      }
      if (count > 1 && !replace_all) {
        throw new Error(
          `old_string occurs ${count} times in ${p}; provide more context or set replace_all`,
        );
      }
      const after = replace_all
        ? before.split(old_string).join(new_string)
        : before.replace(old_string, new_string);
      await writeFile(abs, after, "utf8");
      return `replaced ${replace_all ? count : 1} occurrence(s) in ${p}`;
    },
    {
      name: "edit_file",
      description:
        "Exact string replacement in a text file. Fails if old_string is missing, or ambiguous without replace_all.",
      schema: z.object({
        path: z.string().describe("workspace-relative file path"),
        old_string: z.string().describe("exact text to replace"),
        new_string: z.string().describe("replacement text"),
        replace_all: z.boolean().optional().describe("replace every occurrence"),
      }),
    },
  );

  return [readFileTool, writeFileTool, editFileTool];
}
