import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTasks } from "./load.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "coble-load-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadTasks", () => {
  it("loads .yaml/.yml task mappings sorted by filename", async () => {
    await writeFile(path.join(dir, "02-b.yaml"), "id: b\n", "utf8");
    await writeFile(path.join(dir, "01-a.yml"), "id: a\n", "utf8");
    await writeFile(path.join(dir, "notes.txt"), "ignored\n", "utf8");
    expect(loadTasks(dir).map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("returns [] for an empty directory (caller maps this to 'no tasks matched')", () => {
    expect(loadTasks(dir)).toEqual([]);
  });

  // Regression (D6): bad --tasks path yields a friendly message, not a raw fs error.
  it("throws a friendly error for a missing directory", () => {
    expect(() => loadTasks(path.join(dir, "nope"))).toThrow(/tasks directory not found/);
  });

  it("throws a friendly error when the path is a file, not a directory", async () => {
    const file = path.join(dir, "file.yaml");
    await writeFile(file, "id: x\n", "utf8");
    expect(() => loadTasks(file)).toThrow(/not a directory/);
  });

  // Regression (D14): an empty / comment-only YAML parses to null and must be
  // reported by name, not crash with "Cannot read properties of null".
  it("names an empty task file instead of throwing a TypeError", async () => {
    await writeFile(path.join(dir, "empty.yaml"), "", "utf8");
    expect(() => loadTasks(dir)).toThrow(/empty\.yaml is empty or not a single YAML task mapping/);
  });

  it("names a comment-only task file", async () => {
    await writeFile(path.join(dir, "c.yaml"), "# just a comment\n", "utf8");
    expect(() => loadTasks(dir)).toThrow(/c\.yaml is empty or not a single YAML task mapping/);
  });

  // Regression (D15): a YAML list (one file holding many tasks) is a single
  // non-mapping doc and must be flagged by name, not yield a blank error.
  it("rejects a YAML list with a named, actionable error", async () => {
    await writeFile(path.join(dir, "list.yaml"), "- id: a\n- id: b\n", "utf8");
    expect(() => loadTasks(dir)).toThrow(/list\.yaml is empty or not a single YAML task mapping/);
  });

  // Regression (D15): the missing-id error interpolates the filename.
  it("names the file missing an id", async () => {
    await writeFile(path.join(dir, "noid.yaml"), "description: foo\nprompt: hi\n", "utf8");
    expect(() => loadTasks(dir)).toThrow(/noid\.yaml is missing 'id'/);
  });

  it("reports a duplicate id with the offending filename", async () => {
    await writeFile(path.join(dir, "a.yaml"), "id: dup\n", "utf8");
    await writeFile(path.join(dir, "b.yaml"), "id: dup\n", "utf8");
    expect(() => loadTasks(dir)).toThrow(/duplicate task id 'dup' \(in b\.yaml\)/);
  });
});
