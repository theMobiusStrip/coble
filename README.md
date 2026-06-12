# ⛵ coble

[![ci](https://github.com/theMobiusStrip/coble/actions/workflows/ci.yml/badge.svg)](https://github.com/theMobiusStrip/coble/actions/workflows/ci.yml)
[![evals](https://img.shields.io/badge/evals-16%2F16_scripted_%C2%B7_16%2F16_gpt--5.5-brightgreen)](./evals/RESULTS.md)
[![node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](./package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
<!-- after npm publish, add:
[![npm](https://img.shields.io/npm/v/coble)](https://www.npmjs.com/package/coble)
-->

A **local, provider-agnostic agent CLI** built on [LangGraph.js](https://github.com/langchain-ai/langgraphjs) and [Ink](https://github.com/vadimdemedes/ink).

coble is a small coding agent you run in your own terminal. The point isn't to out-feature Claude Code — it's a focused, readable implementation of the mechanics that make an agent trustworthy to run locally:

- **🔁 Durable sessions** — every step is checkpointed to SQLite. Kill the process mid-task and `coble resume <id>` continues from the last checkpoint *without re-running completed work*.
- **🙋 Human-in-the-loop** — dangerous tool calls (arbitrary shell, `git push`, opening a PR) pause the whole graph via LangGraph's `interrupt()` and wait for terminal approval. Approvals survive a crash too.
- **🛡️ Tiered tool sandbox** — every tool call is classified `safe` / `confirm` / `dangerous`; read-only shell commands run freely, everything else is gated. All calls are written to an append-only audit log.
- **🔌 Provider-agnostic** — one flag switches OpenAI `gpt-5.5`, Anthropic Claude, or a fully local Ollama model.
- **🧪 Built-in evals** — 16 fixture-based tasks with outcome assertions, runnable against any model and run deterministically (key-free) in CI.

## Quickstart

```bash
# 1. install — from source until the npm package ships
git clone https://github.com/theMobiusStrip/coble.git && cd coble
npm install && npm run build && npm link     # puts `coble` on your PATH
# (once published, this becomes: npm install -g coble)

# 2. save a key once — effective from any directory afterwards
coble config set OPENAI_API_KEY sk-...       # or ANTHROPIC_API_KEY sk-ant-...

# 3. go
coble -p "count the TODOs in src and summarize them"   # one-shot, headless
coble                                                  # interactive TUI
```

No key yet? Just run `coble` — the TUI opens a **first-run wizard**: pick a provider, paste the key (input hidden), coble validates it with a live request and saves it globally. Verify any setup with `coble doctor`.

```bash
# fully local — no key, no cloud
coble -p -m ollama:llama3.1 "explain this repo"
```

## Eval results

The same 16 tasks run two ways: **scripted** (deterministic, key-free, on every CI push) and against a **real model**. Assertions check task *outcomes* (file contents, branch state, refusals), so they're meaningful across models — the agent reaches them however it likes.

| Suite | Passed | Cost |
| --- | --- | --- |
| scripted (CI) | **16/16** | $0 |
| `openai:gpt-5.5` | **16/16** | ~$0.20 |

See [evals/RESULTS.md](./evals/RESULTS.md) for the per-task table and [`evals/tasks/`](./evals/tasks) for the definitions. Reproduce with `coble eval -m openai:gpt-5.5 --write`.

> The first real-model run scored 11/16 — not because gpt-5.5 failed the tasks, but because five assertions over-specified the *path* (which tool to use, exact commit wording) instead of the *outcome*. For example, asked to delete everything, gpt-5.5 refused outright rather than attempting the command and being denied. Tightening those assertions to outcome-based — and leaving mechanism guarantees (denial, approval, audit) to the unit tests — is exactly the eval-iteration loop these harnesses exist to drive.

## Configuration

Four ways to configure, by scope:

| Method | Scope | Example |
| --- | --- | --- |
| `coble config set KEY <value>` | **global** — every run, any directory (`~/.coble/env`, mode `600`) | `coble config set OPENAI_API_KEY sk-...` |
| shell environment | current shell / profile | `export ANTHROPIC_API_KEY=sk-ant-...` |
| project `.env` | runs started from that directory | `OPENAI_API_KEY=sk-...` in `./.env` |
| `-m` flag | single invocation (model choice only) | `coble -p -m ollama:llama3.1 "..."` |

**Precedence** (first match wins): `-m` flag → shell env → project `.env` → global config.

Keys coble reads:

- `OPENAI_API_KEY` — [create one](https://platform.openai.com/api-keys)
- `ANTHROPIC_API_KEY` — [create one](https://console.anthropic.com/settings/keys)
- `COBLE_MODEL` — default model when `-m` is omitted, e.g. `openai:gpt-5.5`
- `OLLAMA_HOST` — remote/Docker Ollama endpoint (default `http://localhost:11434`)
- `COBLE_HOME` — state directory (sessions, checkpoints, audit log, global config; default `~/.coble`)

Inspect with `coble config list` (values masked; `--reveal` to print), `coble config path`, and `coble doctor` — which checks node version, state dir, keys (masked, with their source), default-model resolution, provider connectivity, and git/gh.

**Security**: the global config file is written mode `0600`; command output masks values by default; keys are never written to the audit log or session store.

### Docker

```bash
docker build -t coble .

# keep coble state outside the container and run against the current repo;
# the /data mount also carries your global config (coble config set … on the host)
docker run --rm -it \
  -v "$PWD:/workspace" \
  -v "$HOME/.coble:/data" \
  -e OPENAI_API_KEY \
  coble -p -m openai:gpt-5.5 "summarize this repository"

# local model path, assuming Ollama is reachable from the container
docker run --rm -it \
  -v "$PWD:/workspace" \
  -v "$HOME/.coble:/data" \
  -e OLLAMA_HOST=http://host.docker.internal:11434 \
  coble -p -m ollama:llama3.1 "count TODOs in src"
```

### Commands

| Command | Description |
| --- | --- |
| `coble [task]` | interactive TUI (or one-shot with `-p`) |
| `coble config set/get/list/unset/path` | manage global config — keys, default model |
| `coble doctor [--no-ping]` | check setup: keys, model, connectivity, git/gh |
| `coble review [path]` | audit a repo → write `AUDIT.md` → branch + commit + PR (dry-run) |
| `coble sessions` | list sessions with status, steps and estimated cost |
| `coble resume <id>` | continue a session from its last checkpoint |
| `coble audit` | show the tool-call audit log |
| `coble eval [--model spec] [--write]` | run the eval suite |

### Flags

- `-m, --model <provider:name>` — `openai:gpt-5.5`, `anthropic:claude-sonnet-4-6`, `ollama:llama3.1`, or `scripted:file.json`
- `--paranoid` — also require approval for workspace writes
- `--dangerously-allow` — auto-approve dangerous calls (headless automation)

## Demos

The release demo set is three short terminal recordings:

| Demo | Shows |
| --- | --- |
| Resume | checkpointed execution survives a killed process and resumes by session id |
| Approval | dangerous `git push` intent pauses for approval; refusal changes the plan |
| Repo review | `coble review <repo>` writes `AUDIT.md`, branches, pushes to a local bare remote and prepares a PR in dry-run mode |

The exact recording commands live in [docs/demo-scripts.md](./docs/demo-scripts.md).

## How it works

```
        ┌──────── Ink TUI ────────┐   ┌──── print mode ────┐   ┌── eval runner ──┐
        └────────────┬────────────┘   └──────────┬─────────┘   └────────┬────────┘
                     └──────────── AgentEvent stream ───────────────────┘
                                          │
                              ┌───────────▼───────────┐
                              │  Agent core (LangGraph)│
                              │  agent ⇄ tools loop    │
                              │  interrupt() approvals │
                              └─────┬──────────┬───────┘
                   ┌────────────────┘          └───────────────┐
        ┌──────────▼─────────┐            ┌────────────────────▼───────────┐
        │ model layer        │            │ tools: read/write/edit/bash    │
        │ openai│anthropic│  │            │ + git_branch/commit/push/PR    │
        │ ollama│scripted    │            │ danger tiers · audit log       │
        └────────────────────┘            └────────────────────────────────┘
                                          │
                              ┌───────────▼───────────┐
                              │ SQLite checkpointer    │
                              │ sessions · resume      │
                              └────────────────────────┘
```

The agent is a LangGraph `StateGraph` with an `agent → tools → agent` loop. The tools node gathers approvals through a single `interrupt()` *before* executing anything (LangGraph re-runs an interrupted node from the top on resume, so no side effect may precede the pause). Persistence is a SQLite checkpointer keyed by session id; resuming invokes the graph with `null` so it continues the thread's pending work.

### Why a framework here?

A bare agent loop is ~40 lines and needs no framework. coble leans on LangGraph specifically for the three things that *are* painful to hand-roll: **durable checkpointing**, **interrupt/resume for human approval**, and an inspectable execution graph. Everything else (tools, model layer, UI) is plain TypeScript talking to provider SDKs.

For a longer architecture write-up, see [docs/blog/architecture.md](./docs/blog/architecture.md).

## Development

```bash
npm install        # from a clone
npm run dev        # tsx src/cli.tsx
npm run typecheck
npm test           # vitest
npm run eval       # scripted eval suite
npm run build
npm run pack:dry   # inspect the npm package without publishing
npm run docker:build
```

All state — sessions, checkpoints, audit log, global config — lives under `COBLE_HOME` (default `~/.coble`), so isolated runs are one env var away:

```bash
COBLE_HOME=$(mktemp -d) node dist/cli.js doctor --no-ping
```

## License

MIT
