import { appendFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAuditLog } from "./audit.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "coble-audit-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("audit log", () => {
  it("appends entries as JSONL and reads them back", () => {
    const file = path.join(dir, "nested", "audit.jsonl");
    const log = openAuditLog(file);
    log.record({ ts: "t1", tool: "bash", summary: "ls", tier: "safe", decision: "auto" });
    log.record({ ts: "t2", tool: "bash", summary: "rm -rf x", tier: "dangerous", decision: "denied" });

    const back = openAuditLog(file).entries();
    expect(back).toHaveLength(2);
    expect(back[1]?.decision).toBe("denied");
    expect(back[1]?.tool).toBe("bash");
  });

  it("returns empty for a missing log", () => {
    expect(openAuditLog(path.join(dir, "absent.jsonl")).entries()).toEqual([]);
  });

  // Regression (D8): a partial/corrupt last line left by a crash/disk-full/kill
  // must drop only that line, not discard every valid entry before it.
  it("skips a corrupt trailing line but keeps the valid entries", () => {
    const file = path.join(dir, "audit.jsonl");
    const log = openAuditLog(file);
    log.record({ ts: "t1", tool: "bash", summary: "ls", tier: "safe", decision: "auto" });
    log.record({ ts: "t2", tool: "write_file", summary: "a.txt", tier: "confirm", decision: "approved" });
    appendFileSync(file, '{"ts":"t3","tool":"ba'); // simulate a half-written final line

    const back = openAuditLog(file).entries();
    expect(back).toHaveLength(2);
    expect(back.map((e) => e.tool)).toEqual(["bash", "write_file"]);
  });
});
