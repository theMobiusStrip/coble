import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
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
  /** OS sandbox used to confine subprocesses (bash/git), and whose deny-read
   *  list the in-process read tools also honor. Default: no-op. */
  sandbox?: Sandbox;
}

/**
 * Is `target` a denied file — or nested under a denied directory? Evaluated live
 * on every read against the current filesystem, so no stale snapshot. Two checks
 * per denied path `d`:
 *  - identity (device, inode): `statSync` follows symlinks, so any other name for
 *    the same currently-existing denied file — hard link, symlink alias, case-fold
 *    — collapses to the same inode. Path strings can't catch these (`realpathSync`
 *    doesn't normalize case and can't resolve a hard link).
 *  - symlink-resolved path containment: the denied path itself, a file under a
 *    denied directory, and a not-yet-existing denied path (matched lexically, so
 *    the guard fires before revealing existence).
 *
 * Mirrors the OS backend's path-based deny-read. Like it, this does NOT catch a
 * denied file moved/copied out from under its own name (`mv .env x` then read `x`)
 * — the same bypass is open to a `bash` subprocess (`mv .env x && cat x`), so
 * confidentiality of the bytes rests on default-deny egress + the key-scrub. See
 * SECURITY.md "Honest limitations".
 */
function isDeniedRead(target: string, denied: string[]): boolean {
  if (denied.length === 0) return false;
  let targetId: { dev: number; ino: number } | undefined;
  try {
    const s = statSync(target);
    targetId = { dev: s.dev, ino: s.ino };
  } catch {
    // target absent/unreadable: identity is unavailable, the path leg still runs.
  }
  const tid = targetId;
  const real = realLocation(target);
  return denied.some((d) => {
    if (tid) {
      try {
        const ds = statSync(d);
        if (ds.dev === tid.dev && ds.ino === tid.ino) return true;
      } catch {
        // denied path absent: fall through to the path comparison.
      }
    }
    const rd = realLocation(d);
    return real === rd || real.startsWith(rd + path.sep);
  });
}

export function makeFsTools(ctx: ToolContext): StructuredToolInterface[] {
  /** Resolve a path for reading, applying the workspace jail AND the sandbox
   *  deny-read policy — so the in-process tools cannot surface a secret the OS
   *  sandbox keeps from subprocesses. The policy is consulted live on each read
   *  (not snapshotted at build), so it tracks files created mid-run. Used by
   *  every tool that reads contents. */
  const resolveForRead = (p: string): string => {
    const abs = resolveInWorkspace(ctx.cwd, p);
    if (isDeniedRead(abs, ctx.sandbox?.denyReadPaths() ?? [])) {
      throw new Error(`reading ${p} is blocked by the sandbox deny-read policy`);
    }
    return abs;
  };

  const readFileTool = tool(
    async ({ path: p }: { path: string }) => {
      const abs = resolveForRead(p);
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
      // edit reads the file first (and its match count is an extraction oracle),
      // so it is gated by the same deny-read policy as read_file.
      const abs = resolveForRead(p);
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
