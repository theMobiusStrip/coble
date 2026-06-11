import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeFsTools, resolveInWorkspace } from "./fsTools.js";

let cwd: string;
let tools: ReturnType<typeof makeFsTools>;

const get = (name: string) => {
  const t = tools.find((t) => t.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "coble-fs-"));
  tools = makeFsTools({ cwd });
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("resolveInWorkspace", () => {
  it("rejects escaping paths", () => {
    expect(() => resolveInWorkspace(cwd, "../../etc/passwd")).toThrow(/escapes/);
    expect(() => resolveInWorkspace(cwd, "/etc/passwd")).toThrow(/escapes/);
  });

  it("accepts nested relative paths", () => {
    expect(resolveInWorkspace(cwd, "a/b/c.txt")).toBe(path.join(cwd, "a/b/c.txt"));
  });
});

describe("write_file / read_file", () => {
  it("round-trips content and creates parent dirs", async () => {
    const out = await get("write_file").invoke({ path: "deep/dir/hello.txt", content: "hi 🦞" });
    expect(String(out)).toContain("deep/dir/hello.txt");
    const back = await get("read_file").invoke({ path: "deep/dir/hello.txt" });
    expect(back).toBe("hi 🦞");
  });

  it("read_file fails cleanly on missing file", async () => {
    await expect(get("read_file").invoke({ path: "nope.txt" })).rejects.toThrow();
  });
});

describe("edit_file", () => {
  beforeEach(async () => {
    await writeFile(path.join(cwd, "f.txt"), "alpha beta alpha", "utf8");
  });

  it("replaces a unique string", async () => {
    await get("edit_file").invoke({ path: "f.txt", old_string: "beta", new_string: "BETA" });
    expect(await readFile(path.join(cwd, "f.txt"), "utf8")).toBe("alpha BETA alpha");
  });

  it("fails when old_string is missing", async () => {
    await expect(
      get("edit_file").invoke({ path: "f.txt", old_string: "gamma", new_string: "x" }),
    ).rejects.toThrow(/not found/);
  });

  it("fails on ambiguous match without replace_all", async () => {
    await expect(
      get("edit_file").invoke({ path: "f.txt", old_string: "alpha", new_string: "x" }),
    ).rejects.toThrow(/2 times/);
  });

  it("replace_all replaces every occurrence", async () => {
    await get("edit_file").invoke({ path: "f.txt", old_string: "alpha", new_string: "A", replace_all: true });
    expect(await readFile(path.join(cwd, "f.txt"), "utf8")).toBe("A beta A");
  });
});
