import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AuditEntry } from "./graph.js";

export interface AuditLog {
  record(entry: AuditEntry): void;
  /** Read back all entries (for inspection / tests). */
  entries(): AuditEntry[];
}

/** Append-only JSONL audit log. One line per tool decision. */
export function openAuditLog(filePath: string): AuditLog {
  mkdirSync(path.dirname(filePath), { recursive: true });
  return {
    record(entry) {
      appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
    },
    entries() {
      let raw: string;
      try {
        raw = readFileSync(filePath, "utf8");
      } catch {
        return []; // no log file yet
      }
      // Skip only the unparseable line(s) — a partial last line left by a
      // crash/disk-full/kill must not discard every valid entry before it.
      return raw
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as AuditEntry];
          } catch {
            return [];
          }
        });
    },
  };
}

/** In-memory audit sink for tests. */
export function memoryAuditLog(): AuditLog {
  const buf: AuditEntry[] = [];
  return {
    record: (e) => void buf.push(e),
    entries: () => buf.slice(),
  };
}
