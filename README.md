# ⛵ coble

A **local, provider-agnostic agent CLI** built on LangGraph.js and Ink.

- **Durable sessions** — SQLite checkpointing; kill the process mid-task and `coble resume` continues from where it stopped
- **Human-in-the-loop** — dangerous tool calls (shell, push, PR) pause the graph for terminal approval
- **Provider-agnostic** — one flag switches OpenAI / Anthropic / local Ollama
- **Built-in evals** — fixture-based task suite with assertion scoring, runs in CI

> Status: under construction. See [PLAN.md](./PLAN.md) for the milestone plan.

## Development

```bash
npm install
npm run dev        # interactive TUI
npm run typecheck
npm test
npm run build
```
