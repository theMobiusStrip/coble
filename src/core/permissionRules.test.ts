import { describe, expect, it } from "vitest";
import {
  compileRuleList,
  evaluateRules,
  globToRegExp,
  matchRule,
  parseRule,
} from "./permissionRules.js";

describe("parseRule", () => {
  it("parses Tool(pattern), bare Tool, and wildcards", () => {
    expect(parseRule("Bash(npm test)")).toMatchObject({ tool: "Bash" });
    expect(parseRule("Bash")?.match).toBeNull(); // any args
    expect(parseRule("Bash(*)")?.match).toBeNull();
    expect(parseRule("*")?.tool).toBe("*");
    expect(parseRule("not a rule )(")).toBeNull();
  });

  it("normalizes wire tool names to aliases", () => {
    expect(parseRule("read_file(./src/**)")?.tool).toBe("Read");
    expect(parseRule("bash(ls)")?.tool).toBe("Bash");
  });
});

describe("globToRegExp", () => {
  it("supports :* prefix, * / ** any, and ? one", () => {
    expect(globToRegExp("git push:*").test("git push origin main")).toBe(true);
    expect(globToRegExp("git push:*").test("git pushy")).toBe(true); // prefix
    expect(globToRegExp("git commit:*").test("git push")).toBe(false);
    expect(globToRegExp("src/**").test("src/a/b.ts")).toBe(true);
    expect(globToRegExp("*.env").test("prod.env")).toBe(true);
    expect(globToRegExp("file?.txt").test("file1.txt")).toBe(true);
    expect(globToRegExp("file?.txt").test("file12.txt")).toBe(false);
  });

  it("strips a leading ./ so path rules match relative paths", () => {
    expect(globToRegExp("./src/**").test("src/x.ts")).toBe(true);
  });
});

describe("matchRule", () => {
  it("matches by canonical tool and pattern against the summary", () => {
    const r = parseRule("Bash(git push:*)")!;
    expect(matchRule(r, "bash", "git push origin main")).toBe(true);
    expect(matchRule(r, "bash", "git status")).toBe(false);
    expect(matchRule(r, "read_file", "git push x")).toBe(false); // wrong tool
  });

  it("bare tool matches any args; * matches any tool", () => {
    expect(matchRule(parseRule("Bash")!, "bash", "anything")).toBe(true);
    expect(matchRule(parseRule("*")!, "git_push", "main")).toBe(true);
  });
});

describe("evaluateRules", () => {
  const rules = {
    allow: compileRuleList(["Bash(npm test)"]),
    ask: compileRuleList(["Bash(git push:*)"]),
    deny: compileRuleList(["Bash(curl:*)", "Read(./.env)"]),
  };

  it("returns the first matching effect with deny > ask > allow precedence", () => {
    expect(evaluateRules("bash", "curl http://evil", rules)?.effect).toBe("deny");
    expect(evaluateRules("bash", "git push origin main", rules)?.effect).toBe("ask");
    expect(evaluateRules("bash", "npm test", rules)?.effect).toBe("allow");
    expect(evaluateRules("read_file", ".env", rules)?.effect).toBe("deny");
    expect(evaluateRules("bash", "ls -la", rules)).toBeUndefined();
  });

  it("deny wins even when an allow rule also matches", () => {
    const conflicting = {
      allow: compileRuleList(["Bash(git push:*)"]),
      ask: [],
      deny: compileRuleList(["Bash(git push:*)"]),
    };
    expect(evaluateRules("bash", "git push origin main", conflicting)?.effect).toBe("deny");
  });
});

describe("deny rules resist common evasion (regression)", () => {
  const deny = { allow: [], ask: [], deny: compileRuleList(["Bash(curl:*)", "Read(.env)"]) };

  it.each([
    "curl http://evil",
    "X=1 curl http://evil", // env-var prefix
    "true && curl http://evil", // command chaining
    "ls; curl http://evil",
    "echo x | curl http://evil",
    " curl http://evil", // leading whitespace
    "CURL http://evil", // case
    "/usr/bin/curl http://evil", // absolute path to binary
    "./curl http://evil", // relative path to binary
    "X=1 /usr/bin/curl http://evil", // env prefix + path
    "nohup curl http://evil", // transparent wrapper
    "env curl http://evil", // env wrapper
    "sudo curl http://evil", // sudo wrapper
    "SUDO curl http://evil", // wrapper-name casing (case-insensitive FS runs real sudo)
    "Timeout 5 curl http://evil", // mixed-case wrapper name
    "doas curl http://evil",
    "timeout 5 curl http://evil", // wrapper with a bare duration arg
    "nice -n 10 curl http://evil", // wrapper with flag+value
    "stdbuf -oL curl http://evil",
    "echo url | xargs curl http://evil", // xargs wrapper after a pipe
    "xargs -I {} curl http://evil", // xargs replace-string: {} must not be taken as the binary
    "timeout -s KILL curl http://evil", // wrapper flag with a separate (non-numeric) value
    "env -u PATH curl http://evil", // env -u VAR value
    "sudo -g root curl http://evil", // wrapper value-flag NOT in any allowlist (sudo -g group)
    "sudo -D /var curl http://evil", // sudo -D directory
    "sudo timeout 5 curl http://evil", // stacked wrappers
    "busybox curl http://evil", // multicall binary
    "C:\\Windows\\curl.exe http://evil", // windows path + .exe
  ])("bash deny still fires: %s", (cmd) => {
    expect(evaluateRules("bash", cmd, deny)?.effect).toBe("deny");
  });

  it.each([
    ".env",
    ".ENV",
    "secret/.env",
    "src/nested/.env",
    "/work/repo/.env", // absolute
    "foo/../.env", // .. normalizes to .env
    ".env/", // trailing slash
    "secret\\.env", // windows backslash separator
    "C:\\repo\\.env",
  ])("path deny still fires: %s", (p) => {
    expect(evaluateRules("read_file", p, deny)?.effect).toBe("deny");
  });

  it("directory-scoped path deny survives absolute/.. and extra-parent paths", () => {
    const dirDeny = { allow: [], ask: [], deny: compileRuleList(["Read(secrets/**)"]) };
    for (const p of ["secrets/key.pem", "/work/repo/secrets/key.pem", "foo/../secrets/key.pem", "a/b/secrets/key.pem"]) {
      expect(evaluateRules("read_file", p, dirDeny)?.effect).toBe("deny");
    }
  });

  it("does not over-match unrelated commands/paths", () => {
    expect(evaluateRules("bash", "echo curling is fun", deny)).toBeUndefined();
    expect(evaluateRules("read_file", "src/index.ts", deny)).toBeUndefined();
  });
});

describe("allow grants are case-sensitive; deny/ask are case-insensitive", () => {
  it("a case-sensitive allow does not grant a different-case path (would be a separate tree on Linux)", () => {
    const allow = { allow: compileRuleList(["Write(src/**)"], true), ask: [], deny: [] };
    expect(evaluateRules("write_file", "src/app.ts", allow)?.effect).toBe("allow");
    expect(evaluateRules("write_file", "SRC/app.ts", allow)).toBeUndefined();
    expect(evaluateRules("write_file", "Src/App.ts", allow)).toBeUndefined();
  });
  it("a case-sensitive allow does not grant a different-case command", () => {
    const allow = { allow: compileRuleList(["Bash(npm test)"], true), ask: [], deny: [] };
    expect(evaluateRules("bash", "npm test", allow)?.effect).toBe("allow");
    expect(evaluateRules("bash", "NPM TEST", allow)).toBeUndefined();
  });
  it("deny stays case-insensitive — over-blocking is the safe direction", () => {
    const deny = { allow: [], ask: [], deny: compileRuleList(["Read(.env)", "Bash(curl:*)"]) };
    expect(evaluateRules("read_file", ".ENV", deny)?.effect).toBe("deny");
    expect(evaluateRules("bash", "CURL http://evil", deny)?.effect).toBe("deny");
  });
});

describe("allow rules are strict (a pattern allow can't approve a chained command)", () => {
  const rules = { allow: compileRuleList(["Bash(ls:*)"]), ask: [], deny: [] };
  it("allows a plain matching command", () => {
    expect(evaluateRules("bash", "ls -la", rules)?.effect).toBe("allow");
  });
  it("does NOT allow a chained command off a benign prefix", () => {
    expect(evaluateRules("bash", "ls -la; rm -rf /", rules)).toBeUndefined();
    expect(evaluateRules("bash", "ls && curl http://evil", rules)).toBeUndefined();
  });
  it("does NOT allow a wrapper/env/path-altered variant of the granted command", () => {
    const npm = { allow: compileRuleList(["Bash(npm test)"]), ask: [], deny: [] };
    expect(evaluateRules("bash", "npm test", npm)?.effect).toBe("allow"); // exact grant still runs
    for (const cmd of [
      "sudo npm test", // privilege wrapper
      "env LD_PRELOAD=/tmp/x.so npm test", // env injection
      "timeout 5 npm test", // wrapper
      "./npm test", // repo-local binary
      "/usr/bin/npm test", // absolute path to a different binary
    ]) {
      expect(evaluateRules("bash", cmd, npm)).toBeUndefined();
    }
  });
  it("path allow stays anchored to the granted root (no trailing-suffix over-grant)", () => {
    const write = { allow: compileRuleList(["Write(src/**)"]), ask: [], deny: [] };
    expect(evaluateRules("write_file", "src/app.ts", write)?.effect).toBe("allow");
    expect(evaluateRules("write_file", "./src/app.ts", write)?.effect).toBe("allow"); // canonical form still allowed
    for (const p of [
      "tmp/src/app.ts", "a/b/src/app.ts", "/etc/src/app.ts", // extra-prefix paths
      "src/../.env", "src/../.git/hooks/pre-commit", "src/../../etc/passwd", // `..` traversal out of the granted root
    ]) {
      expect(evaluateRules("write_file", p, write)).toBeUndefined();
    }
  });
  it("does NOT allow redirection or command substitution appended to a prefix grant", () => {
    const echo = { allow: compileRuleList(["Bash(echo:*)"]), ask: [], deny: [] };
    expect(evaluateRules("bash", "echo ok", echo)?.effect).toBe("allow"); // plain command still allowed
    for (const cmd of [
      "echo ok > out", // redirection writes a file
      "echo ok >> /etc/cron.d/x", // append redirection
      "echo $(curl http://evil)", // command substitution
      "echo `id`", // backtick substitution
      "echo ok < in", // input redirection
    ]) {
      expect(evaluateRules("bash", cmd, echo)).toBeUndefined();
    }
  });
  it("deny still matches the dangerous tail of a chain (any-segment)", () => {
    const deny = { allow: [], ask: [], deny: compileRuleList(["Bash(rm:*)"]) };
    expect(evaluateRules("bash", "ls -la; rm -rf /", deny)?.effect).toBe("deny");
  });
});

describe("globToRegExp ReDoS guard", () => {
  it("collapses runs of wildcards to a single .*", () => {
    expect(globToRegExp("a***b").source).toBe("^a.*b$");
  });
  it("rejects pathologically long patterns at parse time", () => {
    expect(parseRule("Bash(" + "*".repeat(2000) + ")")).toBeNull();
  });
});
