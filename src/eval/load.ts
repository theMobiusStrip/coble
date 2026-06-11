import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type { EvalTask } from "./types.js";

export function loadTasks(dir: string): EvalTask[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
  const tasks = files.map((f) => parse(readFileSync(path.join(dir, f), "utf8")) as EvalTask);
  const ids = new Set<string>();
  for (const t of tasks) {
    if (!t.id) throw new Error(`task in missing id`);
    if (ids.has(t.id)) throw new Error(`duplicate task id: ${t.id}`);
    ids.add(t.id);
  }
  return tasks;
}
