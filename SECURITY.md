# coble security model

coble is a local coding agent that edits your real repository and runs shell
commands. This document states its trust boundary, threat model, and what each
protection actually guarantees — including where it does **not**.

One-sentence version: **the classifier decides whether to ask a human; the OS
sandbox decides what an approved command can actually touch** — so the classifier
is defense-in-depth, never the boundary. It is a **deterministic** parse of the
command string (`src/core/approval.ts`), not an LLM judging intent: it can't be
prompt-injected, but it can't reason about what a command is *for* either — which
is exactly why the OS sandbox, not the classifier, is the boundary.

## Threat model

**Assets.** Your filesystem and secrets (`~/.ssh`, `~/.aws`, cloud creds), the
host machine, the repository under work, and the model-provider channel —
anything placed in the context window leaves your machine.

**Trust boundary.** The LLM is **untrusted**. It can be wrong, over-eager, or
hijacked by prompt injection. Every tool call crosses from the untrusted planner
into the host; that crossing is where the boundary is (or isn't) enforced.

**Adversaries.**
1. *The model itself* — hallucinated or over-eager destructive actions.
2. *Prompt injection* — instructions embedded in repo files, command output, or
   fetched content that the model treats as trusted. `coble review` over an
   arbitrary repo deliberately ingests untrusted content.
3. *A malicious task author* — a prompt that steers the agent toward
   exfiltration or host compromise.

**The lethal trifecta** ([Willison, 2025](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)):
private-data access **+** exposure to untrusted content **+** the ability to
communicate externally is exploitable by prompt injection. coble can hit all
three (it reads repo/secrets, ingests untrusted file/command output, and can
`bash`/`git push`). The highest-ROI mitigation is to **remove the exfiltration
leg** — which is what `--sandbox`'s default-deny network egress does.

## The layers

Each answers a *different* question; they are complementary, not redundant.

| Layer | Question | Enforced by | A security boundary? |
| --- | --- | --- | --- |
| **Classifier** | "Should we ask the human?" | coble — deterministic string parse, no model (`src/core/approval.ts`) | **No** — advisory triage, bypassable |
| **Human gate** | "Should this happen at all?" | `interrupt()` + human (`src/core/graph.ts`) | Yes, for *consent* |
| **Rules** | "Pre-approved or always-blocked?" | allow/ask/deny in `settings.yaml` (`src/core/permissionRules.ts`) | Partly — `deny` is enforced; like any allowlist, not a containment boundary |
| **Auto classifier** | "Should the model auto-approve this?" | a classifier **LLM**, opt-in `auto` mode (`src/core/autoMode.ts`) | **No** — probabilistic, injection-influenceable |
| **Sandbox** | "What can the command touch?" | OS — Seatbelt / bubblewrap (`src/core/sandbox.ts`) | **Yes** — the real wall |
| **Spotlighting** | "Is this data or instructions?" | untrusted-data envelope (`src/core/prompts.ts`) | No — injection defense-in-depth |
| **Audit** | "What happened, and why allowed?" | append-only JSONL (`src/core/audit.ts`) — [format & demo](./docs/audit-log.md) | Yes, for *record* |

The sandbox sits **under** the approval gate, not instead of it: the gate decides
whether a command runs; the sandbox confines what it touches — and, unlike any
app-level check, binds the whole subprocess tree.

## What each mode protects against

**Default (no `--sandbox`).** Deterministic classifier + human-in-the-loop gate
+ audit log. `safe`/`confirm` auto-run; `dangerous` (arbitrary shell, `git
push`, PR) requires approval (`--paranoid` also gates writes). coble's own
`read_file`/`write_file`/`edit_file` are confined to the workspace by a
symlink-aware path jail (`resolveInWorkspace`). This stops the *honest-mistake*
and *over-eager-model* adversaries, and stops obviously-dangerous shell. It does
**not** confine what an approved (or misclassified) `bash`/`git` subprocess
touches.

**`--sandbox`.** Adds the OS boundary around every `bash`/`git` subprocess:

- **Filesystem jail** — writes confined to the workspace + temp; reads of
  secret stores are denied — *even for a command the classifier rated `safe`*
  (e.g. `cat ~/.ssh/id_rsa`). Denied paths: `~/.coble`, `~/.ssh`, `~/.aws`,
  `~/.gnupg`, `~/.netrc`, `~/.npmrc`, `~/.git-credentials`, `~/.config/gcloud`,
  `~/.config/gh` (GitHub token), `~/.docker/config.json`, `~/.kube`, and the
  workspace's own `.env` / `.env.local` (a documented provider-key location —
  otherwise `cat .env` would defeat the env-scrub below). The same deny-read
  list is honored by coble's in-process `read_file`/`edit_file`, so a model
  cannot pull `.env` into context to sidestep the subprocess boundary. Matched
  live on each read by file identity (device + inode) — catching a symlink, hard
  link, or case-folded alias of a denied file — plus symlink-resolved path
  containment for files under a denied directory. Stores outside the workspace are
  unreachable via the path jail.
- **Default-deny network egress** — no outbound network unless a host is on the
  allowlist (`--allow-domain`, `COBLE_ALLOWED_DOMAINS`; the `origin` git remote
  is added automatically so an approved push still works). This removes the
  exfiltration leg of the lethal trifecta. The in-process web tools
  (`web_fetch`/`web_search`) do not pass through the subprocess proxy, so they
  enforce the SAME allowlist themselves (`Sandbox.egressPolicy()`), default-deny
  under `--sandbox`; both are also `dangerous`-tier (human-approved) and refuse
  link-local/cloud-metadata IPs (e.g. `169.254.169.254`) in every mode.
- **Provider-key scrub** — `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` /
  `GOOGLE_API_KEY` / `TAVILY_API_KEY` are stripped from the subprocess
  environment, so an approved command can't `echo $OPENAI_API_KEY` out.

`--strict-sandbox` refuses to run if the backend can't engage (otherwise coble
warns and falls back to classifier + gate). Run `coble doctor` to see whether the
backend is available on your platform.

Recommended profile for auditing untrusted code:
`coble review <repo> --sandbox` (or `--strict-sandbox`).

## Permission modes & rules

**Modes** (`plan`/`default`/`careful`/`auto`/`bypass`) gate reads, writes, and
dangerous calls at increasing strictness — see the table in [README](./README.md#permission-modes--rules).

**Rules** — `allow` / `ask` / `deny` patterns (`Tool(pattern)`, e.g. `Bash(git push:*)`,
`Read(./src/**)`) in `settings.yaml`, evaluated **deny → ask → allow**, overriding the mode
per call. `deny` holds in every mode (including `bypass`); `allow` auto-runs a matched call;
`ask` always prompts. Bash deny matching is hardened against the common evasions —
command chaining, env-var prefixes, casing, absolute/relative binary paths, and transparent
wrappers (`sudo`, `env`, `timeout`, `nice`, `xargs`, `busybox`, …); path rules normalize
`..`/separators and match by basename, so `Read(.env)` also blocks `*/.env`. But string
matching **cannot** be exhaustive: the wrapper set is open-ended and full shell obfuscation
(`sh -c '…'`, `eval`, base64) defeats any parser. **Treat bash deny rules as best-effort
defense-in-depth; for a hard guarantee use `--sandbox`** (the OS boundary), which contains a
command regardless of how it is spelled.

**Project settings can only tighten.** A `<repo>/.coble/settings.yaml` ships inside the
untrusted repo, so its `allow`, `defaultMode`, and `autoMode.model` are **ignored** — only
its `deny`/`ask` apply. Those grants come from the global `~/.coble/settings.yaml` or the
CLI, so a cloned repo cannot self-escalate (mirrors Claude Code).

### `auto` mode is model-judged, not a boundary

A separate **classifier LLM** decides whether a would-prompt call runs instead of asking you.
It sees the task, the agent's intent, and (for a write/edit) the agent's own proposed payload
(capped, fenced as untrusted) — but **not** tool results or file contents, so injected output
can't drive it. `git push`/PR and `rm -rf` of `/` or `$HOME` still require a human; a block
makes the agent replan. It's probabilistic — pair it with `--sandbox`. Configurable via
`COBLE_AUTO_MODEL` / `settings.permissions.autoMode.model` (one model round-trip per gated call).

## Honest limitations (do not overclaim)

- **The classifier is not a boundary.** String-parsing can't fully track shell
  semantics; known bypass classes are closed and regression-tested
  (`approval.test.ts`), but treat it as triage — `--sandbox` is the boundary.
- **Egress is hostname-only, and web tools widen it.** The proxy (and the
  in-process `web_fetch`/`web_search`, which enforce the same allowlist) match by
  hostname, so a broad entry (e.g. `github.com`) leaves a domain-fronting exfil
  path — keep the allowlist narrow. Web tools are `dangerous`-tier, GET-only, and
  block link-local/metadata IPs by resolved address; residual gaps: DNS-rebinding
  TOCTOU between the resolve check and the connect, loopback/private IPs *allowed*
  (local-first, human-approved), IPv6 ULA metadata not enumerated. Review fetched
  content as untrusted.
- **Symlink jail is not fully TOCTOU-proof.** `resolveInWorkspace` resolves the
  real path of the deepest existing ancestor (closing the static symlink
  escape), but a link swapped in between check and syscall could still slip
  through; it also only confines coble's *own* fs tools — subprocess writes are
  bounded by `--sandbox`, not this check.
- **Hard links into a denied *directory* aren't caught.** Deny-read matches a
  denied file by inode and a denied directory by path containment. A workspace
  file that is a hard link to a file *inside* a denied directory (e.g.
  `~/.ssh/id_rsa`) shares the secret's inode but matches neither the directory's
  inode nor a path under it — and a hard link has no canonical path to resolve
  back to. The OS sandbox's path-based deny-read shares this blind spot. It is
  narrow: hard links can't cross filesystems, `git clone` never creates them,
  and under `--sandbox` the backend makes the denied directory unreachable to
  the subprocess that would create the link — so the residual is a link planted
  outside coble beforehand. Keep secrets off the workspace's filesystem if this
  matters.
- **Deny-read matches paths/aliases, not relocated content.** Both the in-process
  guard and the path-based OS backend deny the file and its inode-identical
  aliases as they currently exist — not a *moved*, *renamed*, *replaced*, or
  *copied* secret under a new name (`mv .env x` / `cp .env x`, then read `x`). The
  same bypass is open to a `bash` subprocess (`mv .env x && cat x`), so
  confidentiality of the bytes rests on default-deny egress (they can't leave) +
  the key-scrub, not read refusal. Keep egress narrow.
- **Platform support.** Backend is Seatbelt (macOS) / bubblewrap (Linux, WSL2).
  On unsupported platforms (native Windows) `--sandbox` falls back to classifier
  + gate; `coble doctor` reports this.
- **Spotlighting is a hint, not a wall.** Wrapping untrusted tool output in an
  `<untrusted-data>` envelope helps the model separate data from instructions
  but does not stop a determined injection on its own — pair it with egress
  control.
- **`AGENTS.md` is a trusted channel.** `AGENTS.md` is loaded into the *system*
  prompt (not the `<untrusted-data>` envelope) — the same trust posture as
  `CLAUDE.md` — across two merged layers: the user-level `$COBLE_HOME/AGENTS.md`
  (outside every workspace and on the deny-read list, so the agent cannot read or
  overwrite it even when injected) and the in-workspace `<cwd>/AGENTS.md`
  (agent-writable, appended last so it can override the global one). So an
  `AGENTS.md` in a repo you did not author becomes trusted instructions; it can
  steer the model's intent but **cannot** lift any deterministic gate (deny/ask
  rules, permission mode, sandbox/egress, deny-read). `coble review` audits an
  untrusted target and therefore does **not** load the target's `AGENTS.md`.
  Review unfamiliar repos before running coble in them, and prefer `--sandbox`
  for untrusted code.
- **`coble policy install`'s human-only guard is best-effort.** The command
  writes the policy block into the user-level `~/.coble/AGENTS.md` (or, with
  `--project`, the in-workspace `AGENTS.md`). It refuses when it detects the
  agent-subprocess marker (`COBLE_AGENT_CHILD`) or a non-TTY, but an agent that
  controls its shell defeats both (`unset` the marker + allocate a PTY), so this
  is a deterrent, not a wall. The real protections: an agent-issued
  `coble policy …` is itself a `dangerous`-tier `bash` call that hits the
  approval gate, and `--sandbox` blocks the out-of-workspace `~/.coble` write at
  the OS layer. `--project` writes a file the agent can already edit, so it adds
  no capability. Install the policy yourself in a terminal.

## Not yet implemented (tracked)

- TLS-terminating egress proxy for content-level inspection.
- Tamper-evident (hash-chained) audit log.

## Reporting a vulnerability

Please open a security advisory on the GitHub repository rather than a public
issue. Include reproduction steps and the affected version.
