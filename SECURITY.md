# coble security model

coble is a local coding agent that edits your real repository and runs shell
commands. This document states its trust boundary, threat model, and what each
protection actually guarantees — including where it does **not**.

One-sentence version: **the classifier decides whether to ask a human; the OS
sandbox decides what an approved command can actually touch.** The classifier is
defense-in-depth, never the boundary.

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
| **Classifier** | "Should we ask the human?" | coble (`src/core/approval.ts`) | **No** — advisory triage, bypassable |
| **Human gate** | "Should this happen at all?" | `interrupt()` + human (`src/core/graph.ts`) | Yes, for *consent* |
| **Sandbox** | "What can the command touch?" | OS — Seatbelt / bubblewrap (`src/core/sandbox.ts`) | **Yes** — the real wall |
| **Spotlighting** | "Is this data or instructions?" | untrusted-data envelope (`src/core/prompts.ts`) | No — injection defense-in-depth |
| **Audit** | "What happened, and why allowed?" | append-only JSONL (`src/core/audit.ts`) | Yes, for *record* |

The sandbox sits **under** the approval gate, not instead of it: `tierExceeds` +
`interrupt()` still decide whether a command runs; the sandbox confines whatever
runs, and — unlike any app-level check — binds the command's whole subprocess
tree.

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
  otherwise `cat .env` would defeat the env-scrub below).
- **Default-deny network egress** — no outbound network unless a host is on the
  allowlist (`--allow-domain`, `COBLE_ALLOWED_DOMAINS`; the `origin` git remote
  is added automatically so an approved push still works). This removes the
  exfiltration leg of the lethal trifecta.
- **Provider-key scrub** — `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` /
  `GOOGLE_API_KEY` are stripped from the subprocess environment, so an approved
  command can't `echo $OPENAI_API_KEY` out.

`--strict-sandbox` refuses to run if the backend can't engage (otherwise coble
warns and falls back to classifier + gate). Run `coble doctor` to see whether the
backend is available on your platform.

Recommended profile for auditing untrusted code:
`coble review <repo> --sandbox` (or `--strict-sandbox`).

## Honest limitations (do not overclaim)

- **The classifier is not a boundary.** Allowlist-parsing of shell strings can
  never fully track shell semantics (`eval`, `xargs`, quoting, locale tricks).
  Known bypass classes are closed and regression-tested (`approval.test.ts`),
  but treat the classifier as triage; `--sandbox` is the boundary.
- **Egress is hostname-only.** The proxy allowlists by hostname; a broad entry
  (e.g. `github.com`) leaves a domain-fronting exfil path. Keep the allowlist
  narrow.
- **Symlink jail is not fully TOCTOU-proof.** `resolveInWorkspace` resolves the
  real path of the deepest existing ancestor (closing the static symlink
  escape), but a link swapped in between check and syscall could still slip
  through; it also only confines coble's *own* fs tools — subprocess writes are
  bounded by `--sandbox`, not this check.
- **Platform support.** Backend is Seatbelt (macOS) / bubblewrap (Linux, WSL2).
  On unsupported platforms (native Windows) `--sandbox` falls back to classifier
  + gate; `coble doctor` reports this.
- **Spotlighting is a hint, not a wall.** Wrapping untrusted tool output in an
  `<untrusted-data>` envelope helps the model separate data from instructions
  but does not stop a determined injection on its own — pair it with egress
  control.

## Not yet implemented (tracked)

- Declarative allow/deny permission rules (Claude-Code-style), to cut approval
  fatigue without weakening the gate.
- TLS-terminating egress proxy for content-level inspection.
- Tamper-evident (hash-chained) audit log.

## Reporting a vulnerability

Please open a security advisory on the GitHub repository rather than a public
issue. Include reproduction steps and the affected version.
