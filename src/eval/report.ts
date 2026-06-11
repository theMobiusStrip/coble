import type { EvalResult } from "./types.js";

export interface ReportMeta {
  model: string;
  dateIso: string;
}

export function summarize(results: EvalResult[]): { passed: number; total: number; costUsd: number } {
  const passed = results.filter((r) => r.pass).length;
  const costUsd = results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  return { passed, total: results.length, costUsd };
}

/** Render a markdown results table plus a summary line. */
export function renderMarkdown(results: EvalResult[], meta: ReportMeta): string {
  const { passed, total, costUsd } = summarize(results);
  const lines: string[] = [];
  lines.push(`# coble eval results`);
  lines.push("");
  lines.push(`- Model: \`${meta.model}\``);
  lines.push(`- Date: ${meta.dateIso}`);
  lines.push(`- Passed: **${passed}/${total}** (${Math.round((passed / total) * 100)}%)`);
  if (costUsd > 0) lines.push(`- Estimated cost: $${costUsd.toFixed(4)}`);
  lines.push("");
  lines.push("| Task | Result | Steps | Notes |");
  lines.push("| --- | --- | --- | --- |");
  for (const r of results) {
    const result = r.pass ? "✅ pass" : "❌ fail";
    const notes = r.pass ? r.description : r.failures.join("; ").replace(/\|/g, "\\|");
    lines.push(`| \`${r.id}\` | ${result} | ${r.steps} | ${notes} |`);
  }
  lines.push("");
  return lines.join("\n");
}

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Render colored console output; returns the summary for exit-code decisions. */
export function renderConsole(results: EvalResult[], model: string): { passed: number; total: number } {
  const { passed, total, costUsd } = summarize(results);
  for (const r of results) {
    const mark = r.pass ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    console.log(`${mark} ${r.id} ${DIM}(${r.steps} steps)${RESET}`);
    if (!r.pass) for (const f of r.failures) console.log(`    ${RED}- ${f}${RESET}`);
  }
  const costStr = costUsd > 0 ? ` ${DIM}~$${costUsd.toFixed(4)}${RESET}` : "";
  const color = passed === total ? GREEN : RED;
  console.log(`\n${color}${passed}/${total} passed${RESET} ${DIM}[${model}]${RESET}${costStr}`);
  return { passed, total };
}
