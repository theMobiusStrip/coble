import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type { EvalTask } from "./types.js";

export function loadTasks(dir: string): EvalTask[] {
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
      .sort();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`tasks directory not found: ${dir}`);
    if (code === "ENOTDIR") throw new Error(`tasks path is not a directory: ${dir}`);
    throw err;
  }

  const tasks: EvalTask[] = [];
  const ids = new Set<string>();
  for (const f of files) {
    const parsed = parse(readFileSync(path.join(dir, f), "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`task file ${f} is empty or not a single YAML task mapping`);
    }
    const t = parsed as EvalTask;
    if (!t.id) throw new Error(`task file ${f} is missing 'id'`);
    if (ids.has(t.id)) throw new Error(`duplicate task id '${t.id}' (in ${f})`);
    ids.add(t.id);
    tasks.push(t);
  }
  return tasks;
}
