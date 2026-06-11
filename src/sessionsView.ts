import { estimateCostUsd } from "./core/cost.js";
import type { Session } from "./core/sessions.js";

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function ago(iso: string, nowMs: number): string {
  const diff = Math.max(0, nowMs - Date.parse(iso));
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const STATUS_GLYPH: Record<Session["status"], string> = {
  running: "•",
  done: "✓",
  error: "✗",
  paused: "⏸",
};

export function formatSessionsTable(sessions: Session[], nowMs: number): string {
  if (sessions.length === 0) {
    return "no sessions yet — run `coble \"<task>\"` to start one.";
  }
  const header = `${pad("ID", 9)}${pad("STATUS", 8)}${pad("STEPS", 6)}${pad("COST", 10)}${pad("WHEN", 10)}TASK`;
  const rows = sessions.map((s) => {
    const cost = estimateCostUsd(s.model, s.usage);
    const costStr = cost === undefined ? "—" : `$${cost.toFixed(4)}`;
    const status = `${STATUS_GLYPH[s.status]} ${s.status}`;
    const task = s.prompt.replace(/\s+/g, " ").slice(0, 48);
    return `${pad(s.id, 9)}${pad(status, 8)}${pad(String(s.steps), 6)}${pad(costStr, 10)}${pad(ago(s.updatedAt, nowMs), 10)}${task}`;
  });
  return [header, ...rows].join("\n");
}
