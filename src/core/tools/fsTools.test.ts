import { link, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeFsTools, resolveInWorkspace } from "./fsTools.js";
import { runtimeSandbox } from "../sandbox.js";

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

describe("fs tools honor the sandbox deny-read policy", () => {
  // A pre-init runtimeSandbox is a side-effect-free way to attach a deny-read
  // policy; denyReadPaths() returns it without standing up the OS backend.
  const withDeny = (denyRead: string[]) =>
    makeFsTools({ cwd, sandbox: runtimeSandbox({ cwd, allowedDomains: [], denyRead, envScrub: [] }) });
  const pick = (ts: ReturnType<typeof makeFsTools>, name: string) => {
    const t = ts.find((t) => t.name === name);
    if (!t) throw new Error(`missing tool ${name}`);
    return t;
  };

  beforeEach(async () => {
    await writeFile(path.join(cwd, ".env"), "OPENAI_API_KEY=sk-supersecret\n", "utf8");
  });

  it("read_file refuses a denied in-workspace file (.env)", async () => {
    const ts = withDeny([path.join(cwd, ".env")]);
    await expect(pick(ts, "read_file").invoke({ path: ".env" })).rejects.toThrow(/deny-read/);
  });

  it("edit_file refuses a denied file (its match count is an extraction oracle)", async () => {
    const ts = withDeny([path.join(cwd, ".env")]);
    await expect(
      pick(ts, "edit_file").invoke({ path: ".env", old_string: "sk-", new_string: "x" }),
    ).rejects.toThrow(/deny-read/);
  });

  it("cannot be bypassed by an in-workspace symlink alias to the denied file", async () => {
    // realLocation collapses `alias` to `.env`, so the lexical path differs but
    // the real target is denied — the guard must still fire.
    await symlink(path.join(cwd, ".env"), path.join(cwd, "alias"), "file");
    const ts = withDeny([path.join(cwd, ".env")]);
    await expect(pick(ts, "read_file").invoke({ path: "alias" })).rejects.toThrow(/deny-read/);
  });

  it("cannot be bypassed by a hard link to the denied file (same inode)", async () => {
    // A hard link is a second *real* name for the same inode — realpathSync
    // cannot resolve it away, so only the (dev, inode) identity check catches it.
    await link(path.join(cwd, ".env"), path.join(cwd, "hardalias"));
    const ts = withDeny([path.join(cwd, ".env")]);
    await expect(pick(ts, "read_file").invoke({ path: "hardalias" })).rejects.toThrow(/deny-read/);
  });

  it("denies a file nested under a denied directory (containment branch)", async () => {
    await mkdir(path.join(cwd, "secrets"), { recursive: true });
    await writeFile(path.join(cwd, "secrets", "key.pem"), "PRIVATE", "utf8");
    const ts = withDeny([path.join(cwd, "secrets")]);
    await expect(pick(ts, "read_file").invoke({ path: "secrets/key.pem" })).rejects.toThrow(/deny-read/);
  });

  it("denies a not-yet-existing denied path before revealing its absence", async () => {
    // realpathSync throws on the missing path; the lexical fallback must still
    // match so the guard fires with deny-read rather than a leaky ENOENT.
    const ts = withDeny([path.join(cwd, "ghost.env")]);
    await expect(pick(ts, "read_file").invoke({ path: "ghost.env" })).rejects.toThrow(/deny-read/);
  });

  it("does NOT catch a denied file moved out from under its own name (documented limit)", async () => {
    // Accepted limitation, matching the path-based OS deny-read: `mv .env env.bak`
    // then read_file('env.bak') succeeds. The same bypass is open to bash
    // (`mv .env x && cat x`); egress + key-scrub are the real boundary. SECURITY.md.
    const ts = withDeny([path.join(cwd, ".env")]);
    await rename(path.join(cwd, ".env"), path.join(cwd, "env.bak"));
    expect(await pick(ts, "read_file").invoke({ path: "env.bak" })).toContain("sk-supersecret");
  });

  it("still reads non-denied files", async () => {
    await writeFile(path.join(cwd, "ok.txt"), "fine", "utf8");
    const ts = withDeny([path.join(cwd, ".env")]);
    expect(await pick(ts, "read_file").invoke({ path: "ok.txt" })).toBe("fine");
  });

  it("does not gate writes — deny-read is read-only, mirroring the OS policy", async () => {
    const ts = withDeny([path.join(cwd, ".env")]);
    const out = await pick(ts, "write_file").invoke({ path: ".env", content: "X=1\n" });
    expect(String(out)).toContain(".env");
    // prove the write landed (a deny error would also contain ".env"):
    expect(await readFile(path.join(cwd, ".env"), "utf8")).toBe("X=1\n");
  });

  it("no policy (no sandbox) leaves reads unchanged", async () => {
    const ts = makeFsTools({ cwd }); // no sandbox ⇒ denyReadPaths() absent
    expect(await pick(ts, "read_file").invoke({ path: ".env" })).toContain("sk-supersecret");
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
