import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

  it("rejects a sibling dir that shares the root's name prefix", async () => {
    // /tmp/coble-fs-XXXX-evil must not be treated as inside /tmp/coble-fs-XXXX
    const sibling = `${cwd}-evil`;
    await mkdir(sibling, { recursive: true });
    try {
      expect(() => resolveInWorkspace(cwd, path.join("..", `${path.basename(cwd)}-evil`, "x"))).toThrow(/escapes/);
    } finally {
      await rm(sibling, { recursive: true, force: true });
    }
  });

  it("rejects reads/writes through a symlink that points outside the root", async () => {
    // A symlink inside the workspace pointing at an out-of-tree dir: lexically
    // inside, but it follows out. realpath-of-ancestor must catch it.
    const outside = await mkdtemp(path.join(tmpdir(), "coble-outside-"));
    await writeFile(path.join(outside, "secret.txt"), "TOP SECRET", "utf8");
    await symlink(outside, path.join(cwd, "link"), "dir");
    try {
      expect(() => resolveInWorkspace(cwd, "link/secret.txt")).toThrow(/symlink/);
      // a symlink whose own target is the escape also fails
      await symlink(path.join(outside, "secret.txt"), path.join(cwd, "leak"), "file");
      expect(() => resolveInWorkspace(cwd, "leak")).toThrow(/symlink/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects a DANGLING symlink that points outside (write-escape)", async () => {
    // The dangerous case: a link whose target does not yet exist. `existsSync`
    // would follow it and report "missing", skipping the check; lstat must catch
    // it so write_file cannot create a file at the out-of-tree target.
    const outside = await mkdtemp(path.join(tmpdir(), "coble-outside-"));
    await symlink(path.join(outside, "loot.txt"), path.join(cwd, "report.txt"), "file");
    try {
      expect(() => resolveInWorkspace(cwd, "report.txt")).toThrow(/symlink/);
      await expect(
        get("write_file").invoke({ path: "report.txt", content: "x" }),
      ).rejects.toThrow(/symlink/);
      // and the dangling link with a suffix
      await symlink(path.join(outside, "nope"), path.join(cwd, "deadlink"), "dir");
      expect(() => resolveInWorkspace(cwd, "deadlink/child")).toThrow(/symlink/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("allows a symlink that stays inside the workspace", async () => {
    await mkdir(path.join(cwd, "real"), { recursive: true });
    await writeFile(path.join(cwd, "real", "ok.txt"), "fine", "utf8");
    await symlink(path.join(cwd, "real"), path.join(cwd, "alias"), "dir");
    expect(() => resolveInWorkspace(cwd, "alias/ok.txt")).not.toThrow();
  });
});

describe("fs tools honor the symlink jail", () => {
  it("read_file refuses to follow a symlink out of the workspace", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "coble-outside-"));
    await writeFile(path.join(outside, "id_rsa"), "PRIVATE KEY", "utf8");
    await symlink(outside, path.join(cwd, "esc"), "dir");
    try {
      await expect(get("read_file").invoke({ path: "esc/id_rsa" })).rejects.toThrow(/symlink/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
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
