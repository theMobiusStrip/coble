import type { StructuredToolInterface } from "@langchain/core/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyToolCall, summarizeCall } from "../approval.js";
import { makeCoreTools } from "./index.js";
import { hostAllowed, isBlockedIp, makeWebTools } from "./webTools.js";
import type { Sandbox } from "../sandbox.js";

function sandboxWith(egress: { restricted: boolean; allowedDomains: string[] }): Sandbox {
  return {
    init: async () => {},
    wrap: async (c) => c,
    dispose: async () => {},
    active: false,
    status: "test",
    scrubEnv: () => undefined,
    denyReadPaths: () => [],
    egressPolicy: () => egress,
  };
}

const findTool = (tools: ReturnType<typeof makeWebTools>, name: string): StructuredToolInterface => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t as StructuredToolInterface;
};

describe("isBlockedIp — SSRF guard (link-local / cloud metadata)", () => {
  it("blocks the cloud metadata IP and the whole 169.254/16 range", () => {
    expect(isBlockedIp("169.254.169.254")).toBe(true); // AWS/GCP metadata
    expect(isBlockedIp("169.254.0.1")).toBe(true);
    expect(isBlockedIp("::ffff:169.254.169.254")).toBe(true); // IPv4-mapped IPv6
  });
  it("blocks IPv6 link-local fe80::/10", () => {
    expect(isBlockedIp("fe80::1")).toBe(true);
    expect(isBlockedIp("FE80::abcd")).toBe(true);
  });
  it("allows public IPs and (local-first, human-approved) loopback/private", () => {
    expect(isBlockedIp("8.8.8.8")).toBe(false);
    expect(isBlockedIp("127.0.0.1")).toBe(false);
    expect(isBlockedIp("10.0.0.1")).toBe(false);
    expect(isBlockedIp("192.168.1.10")).toBe(false);
  });
});

describe("hostAllowed — egress allowlist", () => {
  it("permits everything when unrestricted (no --sandbox)", () => {
    expect(hostAllowed("anything.example", { restricted: false, allowedDomains: [] })).toBe(true);
  });
  it("default-denies under --sandbox with an empty allowlist", () => {
    expect(hostAllowed("example.com", { restricted: true, allowedDomains: [] })).toBe(false);
  });
  it("matches exact host and subdomains of an allowlisted domain", () => {
    const e = { restricted: true, allowedDomains: ["example.com"] };
    expect(hostAllowed("example.com", e)).toBe(true);
    expect(hostAllowed("api.example.com", e)).toBe(true);
    expect(hostAllowed("evil.com", e)).toBe(false);
    expect(hostAllowed("notexample.com", e)).toBe(false);
  });
});

describe("web tools — classification & toolset", () => {
  it("are dangerous-tier so they always hit the approval gate", () => {
    expect(classifyToolCall("web_fetch", { url: "https://x" })).toBe("dangerous");
    expect(classifyToolCall("web_search", { query: "x" })).toBe("dangerous");
  });
  it("summarize to the url / query", () => {
    expect(summarizeCall("web_fetch", { url: "https://example.com" })).toBe("https://example.com");
    expect(summarizeCall("web_search", { query: "bitgo news" })).toBe("bitgo news");
  });
  it("are included in the core toolset", () => {
    const names = makeCoreTools({ cwd: "/tmp" }).map((t) => t.name);
    expect(names).toContain("web_fetch");
    expect(names).toContain("web_search");
  });
});

describe("web_fetch — guard rejections (no network)", () => {
  it("rejects non-http(s) schemes", async () => {
    const fetchTool = findTool(makeWebTools({ cwd: "/tmp" }), "web_fetch");
    const out = (await fetchTool.invoke({ url: "file:///etc/passwd" })) as string;
    expect(out).toMatch(/web_fetch error/);
    expect(out).toMatch(/only http\/https/);
  });
  it("refuses a non-allowlisted host under --sandbox before any request", async () => {
    const ctx = { cwd: "/tmp", sandbox: sandboxWith({ restricted: true, allowedDomains: ["github.com"] }) };
    const fetchTool = findTool(makeWebTools(ctx), "web_fetch");
    const out = (await fetchTool.invoke({ url: "https://evil.example/x" })) as string;
    expect(out).toMatch(/not allowed under --sandbox/);
  });
});

describe("web_search — guard rejections (no network)", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_API_KEY;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = saved;
  });

  it("reports missing key without making a request", async () => {
    const searchTool = findTool(makeWebTools({ cwd: "/tmp" }), "web_search");
    const out = (await searchTool.invoke({ query: "x" })) as string;
    expect(out).toMatch(/TAVILY_API_KEY/);
  });
  it("refuses when api.tavily.com is not allowlisted under --sandbox", async () => {
    process.env.TAVILY_API_KEY = "tvly-fake";
    const ctx = { cwd: "/tmp", sandbox: sandboxWith({ restricted: true, allowedDomains: [] }) };
    const searchTool = findTool(makeWebTools(ctx), "web_search");
    const out = (await searchTool.invoke({ query: "x" })) as string;
    expect(out).toMatch(/not on the egress allowlist/);
  });
});
