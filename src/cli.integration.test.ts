import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Spawns the real CLI (via tsx, against source) with an isolated COBLE_HOME so
// these exercise the commander action layer end-to-end — the surface unit tests
// don't reach. Each case is a regression guard for a Phase-2 defect (D2–D13).

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
const cli = path.join(repoRoot, "src", "cli.tsx");

let home: string;
let ws: string;
let doneScript: string; // a scripted model that just says "done" (no tools)
let writeScript: string; // a scripted model that writes a file then finishes

async function run(args: string[], opts: { home?: string } = {}) {
  return execa(tsxBin, [cli, ...args], {
    cwd: repoRoot,
    env: { ...process.env, COBLE_HOME: opts.home ?? home },
    reject: false,
    all: true,
    timeout: 30_000,
    input: "", // closed, non-TTY stdin
  });
}

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "coble-cli-home-"));
  ws = await mkdtemp(path.join(tmpdir(), "coble-cli-ws-"));
  doneScript = path.join(home, "done.json");
  writeScript = path.join(home, "write.json");
  await writeFile(doneScript, JSON.stringify([{ content: "done" }]), "utf8");
  await writeFile(
    writeScript,
    JSON.stringify([
      { content: "step", toolCalls: [{ name: "write_file", args: { path: "a.txt", content: "1" } }] },
      { content: "done" },
    ]),
    "utf8",
  );
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(ws, { recursive: true, force: true });
});

describe("cli action layer (regression guards)", () => {
  // D2: no interactive terminal → clear error + nonzero exit, not a raw Ink crash / exit 0.
  it("refuses the interactive TUI without a terminal", async () => {
    const r = await run(["-C", ws, "hello there"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.all).toContain("no interactive terminal detected");
  });

  // D3: audit -n rejects non-positive / non-numeric counts.
  it.each(["abc", "0", "-2"])("rejects audit -n %s", async (bad) => {
    const r = await run(["audit", "-n", bad]);
    expect(r.exitCode).not.toBe(0);
    expect(r.all).toContain("positive integer");
  });

  // D4: --paranoid and --dangerously-allow are mutually exclusive (fail loud, don't pick bypass).
  it("errors when --paranoid and --dangerously-allow are combined", async () => {
    const r = await run(["-p", "x", "--paranoid", "--dangerously-allow", "-C", ws, "-m", `scripted:${doneScript}`]);
    expect(r.exitCode).not.toBe(0);
    expect(r.all).toContain("mutually exclusive");
  });

  // D5: a bad -C/--cwd fails fast with a clear message.
  it("rejects a nonexistent workspace root", async () => {
    const r = await run(["-p", "x", "-C", "/no/such/workspace", "-m", `scripted:${doneScript}`]);
    expect(r.exitCode).not.toBe(0);
    expect(r.all).toContain("workspace root not found");
  });

  // D7: --allow-domain without --sandbox warns rather than silently dropping it.
  it("warns that --allow-domain has no effect without --sandbox", async () => {
    const r = await run(["-p", "do a thing", "--allow-domain", "evil.example.com", "-C", ws, "-m", `scripted:${doneScript}`]);
    expect(r.exitCode).toBe(0);
    expect(r.all).toContain("no effect without --sandbox");
  });

  // D11: resuming an already-finished session reports it, not a fake "done".
  it("reports nothing-to-resume for a completed session", async () => {
    const isoHome = await mkdtemp(path.join(tmpdir(), "coble-cli-resume-home-"));
    const taskWs = await mkdtemp(path.join(tmpdir(), "coble-cli-resume-ws-"));
    try {
      await run(["-p", "task one", "-m", `scripted:${writeScript}`, "--permission-mode", "bypass", "-C", taskWs], {
        home: isoHome,
      });
      const sessions = await run(["sessions"], { home: isoHome });
      const id = sessions.stdout.split("\n")[1]?.trim().split(/\s+/)[0];
      expect(id).toBeTruthy();
      const r = await run(["resume", id!], { home: isoHome });
      expect(r.all).toContain("is already done — nothing to resume");
      expect(r.all).not.toContain("— done:"); // no stale "done: N step(s)" line
    } finally {
      await rm(isoHome, { recursive: true, force: true });
      await rm(taskWs, { recursive: true, force: true });
    }
  });

  // D12: config set rejects an empty value (can't masquerade as a populated key).
  it("rejects an empty config value", async () => {
    const r = await run(["config", "set", "OPENAI_API_KEY", ""]);
    expect(r.exitCode).not.toBe(0);
    expect(r.all).toContain("is empty — nothing saved");
    const list = await run(["config", "list"]);
    expect(list.stdout).not.toContain("OPENAI_API_KEY");
  });

  // D13: review help no longer calls the default "dry-run" (the branch IS pushed).
  it("describes review's --live-pr honestly", async () => {
    const r = await run(["review", "--help"]);
    expect(r.stdout).toContain("push the audit branch");
    expect(r.stdout).not.toContain("default: dry-run)");
  });
});
