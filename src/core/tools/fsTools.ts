import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

const MAX_READ_BYTES = 256 * 1024;

/** Resolve a workspace-relative path, refusing anything that escapes the root. */
export function resolveInWorkspace(cwd: string, p: string): string {
  const root = path.resolve(cwd);
  const abs = path.resolve(root, p);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`path escapes the workspace root: ${p}`);
  }
  return abs;
}

export interface ToolContext {
  cwd: string;
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
