# ⛵ coble

A **local, provider-agnostic agent CLI** built on [LangGraph.js](https://github.com/langchain-ai/langgraphjs) and [Ink](https://github.com/vadimdemedes/ink).

coble is a small coding agent you run in your own terminal. The point isn't to out-feature Claude Code — it's a focused, readable implementation of the mechanics that make an agent trustworthy to run locally:

- **🔁 Durable sessions** — every step is checkpointed to SQLite. Kill the process mid-task and `coble resume <id>` continues from the last checkpoint *without re-running completed work*.
- **🙋 Human-in-the-loop** — dangerous tool calls (arbitrary shell, `git push`, opening a PR) pause the whole graph via LangGraph's `interrupt()` and wait for terminal approval. Approvals survive a crash too.
- **🛡️ Tiered tool sandbox** — every tool call is classified `safe` / `confirm` / `dangerous`; read-only shell commands run freely, everything else is gated. All calls are written to an append-only audit log.
- **🔌 Provider-agnostic** — one flag switches OpenAI `gpt-5.5`, Anthropic Claude, or a fully local Ollama model.
- **🧪 Built-in evals** — 16 fixture-based tasks with outcome assertions, runnable against any model and run deterministically (key-free) in CI.

## Eval results

The same 16 tasks run two ways: **scripted** (deterministic, key-free, on every CI push) and against a **real model**. Assertions check task *outcomes* (file contents, branch state, refusals), so they're meaningful across models — the agent reaches them however it likes.

| Suite | Passed | Cost |
| --- | --- | --- |
| scripted (CI) | **16/16** | $0 |
| `openai:gpt-5.5` | **16/16** | ~$0.20 |

See [evals/RESULTS.md](./evals/RESULTS.md) for the per-task table and [`evals/tasks/`](./evals/tasks) for the definitions. Reproduce with `coble eval -m openai:gpt-5.5 --write`.

> The first real-model run scored 11/16 — not because gpt-5.5 failed the tasks, but because five assertions over-specified the *path* (which tool to use, exact commit wording) instead of the *outcome*. For example, asked to delete everything, gpt-5.5 refused outright rather than attempting the command and being denied. Tightening those assertions to outcome-based — and leaving mechanism guarantees (denial, approval, audit) to the unit tests — is exactly the eval-iteration loop these harnesses exist to drive.

## Install & run

```bash
npm install
npm run build

# interactive TUI (uses ANTHROPIC_API_KEY / OPENAI_API_KEY if set)
node dist/cli.js

# one-shot, headless
node dist/cli.js -p "count the TODOs in src and summarize them"

# pick a model explicitly
node dist/cli.js -p -m ollama:llama3.1 "explain this repo"
node dist/cli.js -p -m openai:gpt-5.5 "..."
```

### Commands

| Command | Description |
| --- | --- |
| `coble [task]` | interactive TUI (or one-shot with `-p`) |
| `coble review [path]` | audit a repo → write `AUDIT.md` → branch + commit + PR (dry-run) |
| `coble sessions` | list sessions with status, steps and estimated cost |
| `coble resume <id>` | continue a session from its last checkpoint |
| `coble audit` | show the tool-call audit log |
| `coble eval [--model spec] [--write]` | run the eval suite |

### Flags

- `-m, --model <provider:name>` — `openai:gpt-5.5`, `anthropic:claude-sonnet-4-6`, `ollama:llama3.1`, or `scripted:file.json`
- `--paranoid` — also require approval for workspace writes
- `--dangerously-allow` — auto-approve dangerous calls (headless automation)

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

## Development

```bash
npm run dev        # tsx src/cli.tsx
npm run typecheck
npm test           # vitest (66 tests)
npm run eval       # scripted eval suite
npm run build
```

## License

MIT
