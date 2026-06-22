import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COBLE_AGENT_CHILD } from "./childEnv.js";
import { userContextPath } from "./context.js";
import {
  AgentBlockedError,
  assertHumanInvocation,
  installPolicy,
  loadRenderedPolicy,
  policyStatus,
  uninstallPolicy,
} from "./policyInstall.js";

let home: string;
let srcDir: string;
let proj: string;
let savedHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "coble-policy-home-"));
  srcDir = await mkdtemp(path.join(tmpdir(), "coble-policy-src-"));
  proj = await mkdtemp(path.join(tmpdir(), "coble-policy-proj-"));
  savedHome = process.env.COBLE_HOME;
  process.env.COBLE_HOME = home; // isolate from the real ~/.coble/AGENTS.md
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.COBLE_HOME;
  else process.env.COBLE_HOME = savedHome;
  await rm(home, { recursive: true, force: true });
  await rm(srcDir, { recursive: true, force: true });
  await rm(proj, { recursive: true, force: true });
});

/** A canonical managed block at column zero. */
const block = (v: number, body = "POLICY BODY") =>
  `<!-- BEGIN agentic-security-playbooks v${v} -->\n${body}\n<!-- END agentic-security-playbooks v${v} -->`;

/** A RENDERED policy file: just the block (+ optional surrounding blank lines). */
const rendered = (v: number, body?: string) => `\n${block(v, body)}\n`;

/** The FULL playbook doc: prose + an indented example + the block fenced in a
 *  section — i.e. non-blank content outside the markers. Must be rejected. */
const fullDoc = (v: number, body?: string) =>
  [
    "# Playbook",
    "",
    "Look for the marker pair:",
    "",
    `       <!-- BEGIN agentic-security-playbooks v${v} -->`,
    "       ...",
    `       <!-- END agentic-security-playbooks v${v} -->`,
    "",
    "## Installed block",
    "",
    "```markdown",
    block(v, body),
    "```",
    "",
  ].join("\n");

async function writeSrc(name: string, text: string): Promise<string> {
  const p = path.join(srcDir, name);
  await writeFile(p, text, "utf8");
  return p;
}

const readUser = () => readFile(userContextPath(), "utf8");
const projFile = () => path.join(proj, "AGENTS.md");

describe("loadRenderedPolicy", () => {
  it("accepts a rendered policy (just the block)", async () => {
    const r = loadRenderedPolicy(await writeSrc("policy.md", rendered(1, "REAL BODY")));
    expect(r.version).toBe(1);
    expect(r.block).toBe(block(1, "REAL BODY"));
  });

  it("rejects the full playbook doc with a pointer to the rendered file", async () => {
    const src = await writeSrc("agentic-security-playbook.md", fullDoc(1));
    expect(() => loadRenderedPolicy(src)).toThrow(/full playbook.*rendered policy|dist\/agent-security-policy\.md/);
  });

  it("throws when there is no block at all", async () => {
    const src = await writeSrc("x.md", "# just a doc\n");
    expect(() => loadRenderedPolicy(src)).toThrow(/no agentic-security-playbooks block/);
  });

  it("throws on malformed markers (mismatched versions)", async () => {
    const bad = "<!-- BEGIN agentic-security-playbooks v1 -->\nx\n<!-- END agentic-security-playbooks v2 -->\n";
    const src = await writeSrc("bad.md", bad);
    expect(() => loadRenderedPolicy(src)).toThrow(/malformed/);
  });
});

describe("installPolicy — user-level (default)", () => {
  it("inserts into a missing target", async () => {
    const r = installPolicy({ file: await writeSrc("p.md", rendered(1)) });
    expect(r.status).toBe("inserted");
    expect(r.project).toBe(false);
    expect(await readUser()).toBe(`${block(1)}\n`);
  });

  it("is idempotent — second run is unchanged and does not rewrite", async () => {
    const file = await writeSrc("p.md", rendered(1));
    installPolicy({ file });
    const before = await readUser();
    expect(installPolicy({ file }).status).toBe("unchanged");
    expect(await readUser()).toBe(before);
  });

  it("replaces a stale same-version block, preserving surrounding content", async () => {
    await writeFile(userContextPath(), `# My rules\n- be nice\n\n${block(1, "OLD")}\n`, "utf8");
    const r = installPolicy({ file: await writeSrc("p.md", rendered(1, "NEW")) });
    expect(r.status).toBe("replaced");
    const out = await readUser();
    expect(out).toContain("# My rules");
    expect(out).toContain("NEW");
    expect(out).not.toContain("OLD");
  });

  it("appends after existing user content when no block is present", async () => {
    await writeFile(userContextPath(), "# My rules\n- be nice\n", "utf8");
    const r = installPolicy({ file: await writeSrc("p.md", rendered(1)) });
    expect(r.status).toBe("inserted");
    expect(await readUser()).toBe(`# My rules\n- be nice\n\n${block(1)}\n`);
  });

  it("refuses to downgrade a newer installed version", async () => {
    const newer = `${block(2, "V2")}\n`;
    await writeFile(userContextPath(), newer, "utf8");
    const r = installPolicy({ file: await writeSrc("p.md", rendered(1)) });
    expect(r.status).toBe("refused-downgrade");
    expect(await readUser()).toBe(newer);
  });

  it("upgrades an older installed version", async () => {
    await writeFile(userContextPath(), `${block(1, "V1")}\n`, "utf8");
    const r = installPolicy({ file: await writeSrc("p.md", rendered(2, "V2")) });
    expect(r.status).toBe("replaced");
    expect(r.version).toBe(2);
    expect(await readUser()).toContain("V2");
  });

  it("refuses a malformed target and leaves it untouched", async () => {
    const bad = `${block(1)}\n${block(1)}\n`; // two BEGINs
    await writeFile(userContextPath(), bad, "utf8");
    const r = installPolicy({ file: await writeSrc("p.md", rendered(1)) });
    expect(r.status).toBe("malformed-target");
    expect(await readUser()).toBe(bad);
  });

  it("rejects installing the full playbook doc", async () => {
    const src = await writeSrc("agentic-security-playbook.md", fullDoc(1));
    expect(() => installPolicy({ file: src })).toThrow(/full playbook|dist\/agent-security-policy\.md/);
    expect(existsSync(userContextPath())).toBe(false); // nothing written
  });
});

describe("installPolicy — project scope", () => {
  it("writes <cwd>/AGENTS.md, not the user file", async () => {
    const r = installPolicy({ file: await writeSrc("p.md", rendered(1)), project: true, cwd: proj });
    expect(r.status).toBe("inserted");
    expect(r.project).toBe(true);
    expect(r.path).toBe(projFile());
    expect(await readFile(projFile(), "utf8")).toBe(`${block(1)}\n`);
    expect(existsSync(userContextPath())).toBe(false); // user file untouched
  });

  it("project and user scopes are independent", async () => {
    installPolicy({ file: await writeSrc("u.md", rendered(1)) }); // user
    installPolicy({ file: await writeSrc("p.md", rendered(2)), project: true, cwd: proj }); // project
    expect(policyStatus().version).toBe(1);
    expect(policyStatus({ project: true, cwd: proj }).version).toBe(2);
  });
});

describe("CRLF targets (P4 robustness)", () => {
  it("detects a CRLF-saved block and replaces in place — no duplicate", async () => {
    const crlf = `${block(1)}\n`.replace(/\n/g, "\r\n");
    await writeFile(userContextPath(), crlf, "utf8");
    expect(policyStatus().installed).toBe(true); // markers detected despite \r
    const r = installPolicy({ file: await writeSrc("p.md", rendered(1)) });
    expect(["unchanged", "replaced"]).toContain(r.status);
    const out = await readUser();
    expect((out.match(/BEGIN agentic-security-playbooks/g) ?? []).length).toBe(1); // not duplicated
  });
});

describe("policyStatus", () => {
  it("reports not installed when absent", () => {
    expect(policyStatus().installed).toBe(false);
  });
  it("reports the installed version + scope", async () => {
    installPolicy({ file: await writeSrc("p.md", rendered(3)) });
    const s = policyStatus();
    expect(s).toMatchObject({ installed: true, version: 3, project: false });
  });
  it("reports malformed markers", async () => {
    await writeFile(userContextPath(), "<!-- BEGIN agentic-security-playbooks v1 -->\nx\n", "utf8");
    expect(policyStatus().malformed).toBe(true);
  });
});

describe("uninstallPolicy", () => {
  it("removes the block, preserving surrounding content", async () => {
    await writeFile(userContextPath(), `# My rules\n\n${block(1)}\n`, "utf8");
    expect(uninstallPolicy().status).toBe("removed");
    expect(await readUser()).toBe("# My rules\n");
  });
  it("removes a sole block leaving an empty file", async () => {
    installPolicy({ file: await writeSrc("p.md", rendered(1)) });
    expect(uninstallPolicy().status).toBe("removed");
    expect(await readUser()).toBe("");
  });
  it("project scope removes only the project file", async () => {
    installPolicy({ file: await writeSrc("p.md", rendered(1)), project: true, cwd: proj });
    const r = uninstallPolicy({ project: true, cwd: proj });
    expect(r).toMatchObject({ status: "removed", project: true });
    expect(await readFile(projFile(), "utf8")).toBe("");
  });
  it("reports not-present when absent or blockless", async () => {
    expect(uninstallPolicy().status).toBe("not-present");
    await writeFile(userContextPath(), "# just my rules\n", "utf8");
    expect(uninstallPolicy().status).toBe("not-present");
    expect(existsSync(userContextPath())).toBe(true);
  });
});

describe("assertHumanInvocation — human-only guardrail", () => {
  it("allows a human at a TTY with no agent marker", () => {
    expect(() => assertHumanInvocation({ env: {}, isTTY: true })).not.toThrow();
  });
  it("refuses when the coble-spawned-subprocess marker is set (agent shelled out)", () => {
    expect(() => assertHumanInvocation({ env: { [COBLE_AGENT_CHILD]: "1" }, isTTY: true })).toThrow(AgentBlockedError);
  });
  it("refuses with no TTY", () => {
    expect(() => assertHumanInvocation({ env: {}, isTTY: false })).toThrow(AgentBlockedError);
  });

  it("is best-effort only: a cleared marker + a (PTY-faked) TTY passes — known, not a boundary", () => {
    // Documents the deliberate limitation: an agent that controls its shell can
    // `unset COBLE_AGENT_CHILD` and allocate a PTY. The real gates are the bash
    // approval prompt in front of `coble policy …` and `--sandbox`. See childEnv.ts.
    expect(() => assertHumanInvocation({ env: {}, isTTY: true })).not.toThrow();
  });
});
