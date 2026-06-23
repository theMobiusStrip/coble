# ⛵ coble

[![ci](https://github.com/theMobiusStrip/coble/actions/workflows/ci.yml/badge.svg)](https://github.com/theMobiusStrip/coble/actions/workflows/ci.yml)
[![evals](https://img.shields.io/badge/evals-18%2F18_scripted_%C2%B7_16%2F16_gpt--5.5-brightgreen)](./evals/RESULTS.md)
[![node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](./package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![npm](https://img.shields.io/npm/v/@themobiusstrip/coble)](https://www.npmjs.com/package/@themobiusstrip/coble)

A **local, provider-agnostic coding-agent CLI for learning agentic security** — a small, readable codebase that makes an AI agent's trust boundary explicit and auditable. Built on [LangGraph.js](https://github.com/langchain-ai/langgraphjs) and [Ink](https://github.com/vadimdemedes/ink).

A small coding agent for your terminal: durable SQLite-checkpointed sessions, human-in-the-loop approvals, provider-agnostic (OpenAI · Anthropic · Google · Ollama), and built-in evals. The part worth reading is the trust boundary.

## Security principle

> **Assume the model is compromised — then be honest, in code, about the one layer that actually contains it.**

- **The LLM is untrusted** — every tool call is the crossing from untrusted planner to your real machine.
- **Exactly one real boundary:** `--sandbox` (OS-level filesystem jail + default-deny egress + key scrub). Everything else — classifier, rules, auto-mode, spotlighting — is defense-in-depth, and each says so in the source.

Full threat model, the per-layer "boundary or not?" table, and honest limitations: **[SECURITY.md](./SECURITY.md)**.

## Quickstart

```bash
# 1. install
npm install -g @themobiusstrip/coble

# 2. save a key once — effective from any directory afterwards
coble config set OPENAI_API_KEY sk-...       # or ANTHROPIC_API_KEY / GOOGLE_API_KEY
# default to Google AI:  coble config set COBLE_MODEL google:gemini-3.5-flash
```

No key yet? Just run `coble` — a first-run wizard picks a provider, validates the key with a live request, and saves it globally. Verify with `coble doctor`.

**Local/proxy endpoint** (e.g. [meridian](https://github.com/rynfar/meridian), LiteLLM — anything speaking the Anthropic API): point `ANTHROPIC_BASE_URL` at it (read by the Anthropic SDK, so a shell var or `.env` is enough):

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:3456 ANTHROPIC_API_KEY=x COBLE_MODEL=anthropic:claude-opus-4-8 coble
```

## Eval results

Assertions check task *outcomes* (file contents, branch state, refusals), so they hold across models. Scripted runs are deterministic and key-free (every CI push); the model column is a recorded baseline.

| Suite | Passed | Cost |
| --- | --- | --- |
| scripted (CI) | **18/18** | $0 |
| `openai:gpt-5.5` | **16/16** | ~$0.20 |

`gpt-5.5` is the 2026-06-11 baseline ([evals/RESULTS.md](./evals/RESULTS.md)); refresh with `coble eval -m openai:gpt-5.5 --write`. Task defs: [`evals/tasks/`](./evals/tasks).

## Configuration

| Method | Scope | Example |
| --- | --- | --- |
| `coble config set KEY <value>` | **global** — every run (`~/.coble/env`, mode `600`) | `coble config set OPENAI_API_KEY sk-...` |
| shell environment | current shell / profile | `export ANTHROPIC_API_KEY=sk-ant-...` |
| project `.env` | runs started from that directory | `OPENAI_API_KEY=sk-...` in `./.env` |
| `-m` flag | single invocation (model only) | `coble -p -m ollama:llama3.1 "..."` |

**Precedence** (first wins): `-m` flag → shell env → project `.env` → global config.

Keys coble reads:

- `OPENAI_API_KEY` · `ANTHROPIC_API_KEY` · `GOOGLE_API_KEY` — provider keys ([OpenAI](https://platform.openai.com/api-keys) / [Anthropic](https://console.anthropic.com/settings/keys) / [Google](https://aistudio.google.com/app/apikey); free Google keys 429 quickly).
- `TAVILY_API_KEY` — key for `web_search` ([Tavily](https://tavily.com)); absent ⇒ the tool reports it's unconfigured (no crash).
- `COBLE_MODEL` — default model when `-m` is omitted, e.g. `openai:gpt-5.5`.
- `OLLAMA_HOST` — Ollama endpoint (default `http://localhost:11434`).
- `COBLE_HOME` — state dir (sessions, checkpoints, audit log, global config; default `~/.coble`).

Inspect with `coble config list` / `path` and `coble doctor`. Keys are stored mode `0600`, masked in output, and never written to the audit log or session store.

### Docker

```bash
docker build -t coble .

# state + global config persist via the /data mount; run against the current repo
docker run --rm -it \
  -v "$PWD:/workspace" -v "$HOME/.coble:/data" -e OPENAI_API_KEY \
  coble -p -m openai:gpt-5.5 "summarize this repository"
```

### Commands

| Command | Description |
| --- | --- |
| `coble [task]` | interactive TUI (or one-shot with `-p`) |
| `coble config set/get/list/unset/path` | manage global config — keys, default model |
| `coble policy install/status/uninstall [--project]` | install the security-policy block into `AGENTS.md` (user-level, or `--project`); human-only |
| `coble doctor [--no-ping]` | check setup: keys, model, connectivity, git/gh |
| `coble review [path]` | audit a repo → write `AUDIT.md` → branch + commit + PR (dry-run) |
| `coble sessions` | list sessions with status, steps and estimated cost |
| `coble resume <id>` | continue a session from its last checkpoint |
| `coble audit` | show the tool-call audit log ([format & demo](./docs/audit-log.md)) |
| `coble eval [--model spec] [--write]` | run the eval suite |

### Flags

- `-m, --model <provider:name>` — `openai:gpt-5.5`, `anthropic:claude-sonnet-4-6`, `google:gemini-3.5-flash`, `ollama:llama3.1`, or `scripted:file.json`
- `-C, --cwd <dir>` — workspace root for this run (default: current directory)
- `-p, --print` — non-interactive: run one task, print events, exit
- `--permission-mode <mode>` — `plan` / `default` / `careful` / `auto` / `bypass` (Shift+Tab cycles in the TUI). `--paranoid` and `--dangerously-allow` alias `careful` and `bypass`.
- `--sandbox` — confine `bash`/`git` in an OS sandbox (fs jail + default-deny egress); warns and falls back if unavailable. Recommended for `coble review`.
- `--strict-sandbox` — refuse to run if the sandbox can't engage (implies `--sandbox`)
- `--allow-domain <host>` — permit a host through the egress allowlist under `--sandbox` (repeatable; also `COBLE_ALLOWED_DOMAINS`)

### Web tools (`web_fetch`, `web_search`)

The agent can reach the network via two `dangerous`-tier tools (approved like `bash`): `web_fetch <url>` (GET → text, redirects re-validated, body capped) and `web_search <query>` (via [Tavily](https://tavily.com); set `TAVILY_API_KEY`). They run in coble's main process and enforce the egress allowlist themselves — default-deny under `--sandbox` (`--allow-domain` to permit), link-local/metadata IPs always refused, output wrapped as untrusted. See [SECURITY.md](./SECURITY.md).

### Permission modes & rules

| Mode | Behaviour |
| --- | --- |
| `plan` | read-only — writes/commands blocked; the agent plans without acting |
| `default` | reads + workspace writes auto-run; dangerous calls ask |
| `careful` | writes also ask |
| `auto` | a classifier **model** judges would-prompt calls (push/PR still ask) — not a boundary; pair with `--sandbox` |
| `bypass` | everything auto-runs |

Pre-approve or block commands/paths in `~/.coble/settings.yaml` (global) or `<repo>/.coble/settings.yaml` (project), evaluated **deny → ask → allow** over the mode. A project file may only *tighten* (its `allow`/`defaultMode` are ignored). Details: [SECURITY.md](./SECURITY.md).

```yaml
# ~/.coble/settings.yaml
permissions:
  defaultMode: default
  allow: ["Bash(npm test)", "Read(./src/**)"]
  ask:   ["Bash(git push:*)"]
  deny:  ["Read(./.env)", "Bash(curl:*)"]
  autoMode:
    model: anthropic:claude-haiku-4-5   # classifier for `auto` mode
```

### Context (`AGENTS.md`)

coble loads two `AGENTS.md` layers into the system prompt — same pattern as `CLAUDE.md` (Claude) / `AGENTS.md` (Codex):

1. **user-level** — `$COBLE_HOME/AGENTS.md`: global conventions, every workspace.
2. **project-level** — `<workspace>/AGENTS.md`: this repo, appended last so it can override the global one.

It is model guidance, not a hard block — for enforcement use permission rules or `--sandbox`. `AGENTS.md` is loaded into the *trusted* prompt, so review one before running coble in a cloned repo ([SECURITY.md](./SECURITY.md); `coble review` deliberately ignores the target's).

To install a security playbook, run `coble policy install` with its **rendered** policy file (not the full doc) — it writes a managed block into `AGENTS.md`, in place and idempotently. Human-only:

```bash
coble policy install path/to/dist/agent-security-policy.md   # user-level (~/.coble/AGENTS.md)
coble policy install ./agent-security-policy.md --project    # this repo
coble policy status      # both scopes
coble policy uninstall   # remove the block, keep the rest
```

## How it works — the trust boundary

Every tool call the (untrusted) LLM proposes crosses one decision point:

```
   model proposes a tool call   ·   read · write · edit · bash · git/PR · web fetch/search
        │
        ▼
   decideCall — one gate per call
        rules   deny → ask → allow      ← ~/.coble (global) + repo .coble/settings.yaml
        mode    plan · default · careful · auto · bypass   ← --permission-mode / Shift+Tab
        │
        ├─ deny  → blocked inline (holds even in bypass)
        ├─ ask   → human approval via interrupt()
        ├─ auto  → auto mode: a classifier LLM decides   (git push / PR still ask)
        └─ allow → runs
        │ approved
        ▼
   run — with --sandbox, inside an OS filesystem jail + default-deny network
         egress (Seatbelt / bubblewrap) that confines whatever the command does
        │
        ▼
   append-only audit log
```

The **deterministic classifier** sorts each call into a danger tier — triage for *whether to ask a human*, never the boundary. The **OS sandbox** is the boundary — it confines what an approved command can reach, however it's spelled. Honest limits of every layer: [SECURITY.md](./SECURITY.md).

Underneath, the loop is a small LangGraph `StateGraph` checkpointed to SQLite, so `interrupt()` can pause for approval and a killed run resumes from its last step.

## Development

Build, test, and headless/CI usage live in [DEVELOP.md](./DEVELOP.md).

## License

MIT
