# ⛵ coble

[![ci](https://github.com/theMobiusStrip/coble/actions/workflows/ci.yml/badge.svg)](https://github.com/theMobiusStrip/coble/actions/workflows/ci.yml)
[![evals](https://img.shields.io/badge/evals-18%2F18_scripted_%C2%B7_16%2F16_gpt--5.5-brightgreen)](./evals/RESULTS.md)
[![node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](./package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![npm](https://img.shields.io/npm/v/@themobiusstrip/coble)](https://www.npmjs.com/package/@themobiusstrip/coble)

A **local, provider-agnostic agent CLI** built on [LangGraph.js](https://github.com/langchain-ai/langgraphjs) and [Ink](https://github.com/vadimdemedes/ink).

coble is a small coding agent you run in your own terminal. The point isn't to out-feature Claude Code — it's a focused, readable implementation of the mechanics that make an agent trustworthy to run locally:

- **🔁 Durable sessions** — every step is checkpointed to SQLite. Kill the process mid-task and `coble resume <id>` continues from the last checkpoint *without re-running completed work*.
- **🙋 Human-in-the-loop** — dangerous tool calls (arbitrary shell, `git push`, opening a PR) pause the whole graph via LangGraph's `interrupt()` and wait for terminal approval. Approvals survive a crash too.
- **🛡️ Layered trust boundary** — every tool call is classified `safe` / `confirm` / `dangerous` (read-only shell runs freely, everything else is gated) and written to an append-only audit log. The classifier is defense-in-depth, not the boundary: `--sandbox` adds OS-level isolation (filesystem jail + default-deny network egress, Seatbelt/bubblewrap) that confines what an approved command can actually touch. See [SECURITY.md](./SECURITY.md).
- **🔌 Provider-agnostic** — one flag switches OpenAI `gpt-5.5`, Anthropic Claude, Google Gemini, or a fully local Ollama model.
- **🧪 Built-in evals** — 18 fixture-based tasks with outcome assertions, runnable against any model and run deterministically (key-free) in CI.

## Quickstart

```bash
# 1. install
npm install -g @themobiusstrip/coble

# 2. save a key once — effective from any directory afterwards
coble config set OPENAI_API_KEY sk-...       # or ANTHROPIC_API_KEY / GOOGLE_API_KEY
# for Google AI as the default:
# coble config set GOOGLE_API_KEY ...
# coble config set COBLE_MODEL google:gemini-3.5-flash
```

**Alternative — drive coble through a local Anthropic-compatible endpoint** (e.g. [meridian](https://github.com/rynfar/meridian) bridging a Claude Pro/Max subscription, LiteLLM, or any proxy that speaks the Anthropic API). Point the base URL at it; the key can be any non-empty placeholder when the proxy handles auth:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:3456 ANTHROPIC_API_KEY=x COBLE_MODEL=anthropic:claude-opus-4-8 coble
```

`ANTHROPIC_BASE_URL` is read by the underlying Anthropic SDK, so it works straight from the shell (or a `.env`) with no extra coble config.

No key yet? Just run `coble` — the TUI opens a **first-run wizard**: pick a provider, paste the key (input hidden), coble validates it with a live request and saves it globally. Verify any setup with `coble doctor`.

## Eval results

The tasks run two ways: **scripted** (deterministic, key-free, on every CI push) and against a **real model**. Assertions check task *outcomes* (file contents, branch state, refusals), so they're meaningful across models — the agent reaches them however it likes.

| Suite | Passed | Cost |
| --- | --- | --- |
| scripted (CI) | **18/18** | $0 |
| `openai:gpt-5.5` | **16/16** | ~$0.20 |

Scripted runs every fixture task on each push. The `gpt-5.5` figures are the 2026-06-11 baseline in [evals/RESULTS.md](./evals/RESULTS.md), recorded over the original 16 tasks; reproduce or refresh with `coble eval -m openai:gpt-5.5 --write`. See [`evals/tasks/`](./evals/tasks) for definitions.

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
- `GOOGLE_API_KEY` — [create one](https://aistudio.google.com/app/apikey); free-tier keys have tight per-day request quotas, and an agent task makes several requests, so expect 429s unless billing is enabled
- `COBLE_MODEL` — default model when `-m` is omitted, e.g. `openai:gpt-5.5` or `google:gemini-3.5-flash`
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
| `coble audit` | show the tool-call audit log ([format & demo](./docs/audit-log.md)) |
| `coble eval [--model spec] [--write]` | run the eval suite |

### Flags

- `-m, --model <provider:name>` — `openai:gpt-5.5`, `anthropic:claude-sonnet-4-6`, `google:gemini-3.5-flash`, `ollama:llama3.1`, or `scripted:file.json`
- `--permission-mode <mode>` — `plan` (read-only), `default`, `careful`, `auto` (model-judged), or `bypass`. In the TUI, **Shift+Tab** cycles modes. `--paranoid` and `--dangerously-allow` are aliases for `careful` and `bypass`.
- `--paranoid` — also require approval for workspace writes (alias for `--permission-mode careful`)
- `--dangerously-allow` — auto-approve dangerous calls (alias for `--permission-mode bypass`)
- `--sandbox` — confine `bash`/`git` subprocesses in an OS sandbox (filesystem jail + default-deny network egress). Falls back to a warning if the backend is unavailable; recommended for `coble review` over untrusted repos. See [SECURITY.md](./SECURITY.md).
- `--strict-sandbox` — refuse to run if the sandbox can't engage (implies `--sandbox`)
- `--allow-domain <host>` — permit a hostname through the egress allowlist under `--sandbox` (repeatable; also `COBLE_ALLOWED_DOMAINS`)

### Permission modes & rules

| Mode | Behaviour |
| --- | --- |
| `plan` | read-only — writes/commands are blocked; the agent plans without acting |
| `default` | reads + workspace writes auto-run; dangerous calls ask |
| `careful` | writes also ask |
| `auto` | a classifier **model** judges would-prompt calls (push/PR still ask); not a security boundary — pair with `--sandbox` |
| `bypass` | everything auto-runs |

Pre-approve or block specific commands/paths in `~/.coble/settings.yaml` (global) or
`<repo>/.coble/settings.yaml` (project). Rules are evaluated **deny → ask → allow** and
override the mode. A project file may only *tighten* (its `allow`/`defaultMode` are
ignored) so a cloned repo can't grant itself more access. See [SECURITY.md](./SECURITY.md).

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

coble loads two `AGENTS.md` layers into the agent's system prompt at startup, in order —
same pattern as Claude reading `CLAUDE.md` and Codex reading `AGENTS.md`:

1. **user-level** — `$COBLE_HOME/AGENTS.md` (`~/.coble/AGENTS.md` by default): your global
   conventions, applied in every workspace.
2. **project-level** — `<workspace>/AGENTS.md`: this repo only, appended after the global
   one so project rules build on (and can override) it.

Use them for conventions and guidance. It is **model guidance, not a hard block**: a
jailbroken agent can ignore it (like any context file). For deterministic enforcement, use
permission rules above or `--sandbox`.

The user-level file lives in `~/.coble` — outside every workspace and on the sandbox
deny-read list — so the agent cannot read or overwrite it. The project-level file is in the
workspace and therefore agent-writable, like `CLAUDE.md`.

> **Trust note:** `AGENTS.md` is loaded into the *trusted* system prompt (not wrapped as
> untrusted data). Treat it like `CLAUDE.md` — an `AGENTS.md` in a repo you did **not**
> author becomes trusted instructions, so review one before running coble in a cloned repo.
> `coble review` is the exception: it audits an untrusted target and deliberately ignores
> that target's `AGENTS.md`.

To install a security playbook, run `coble policy install` with its rendered policy file
— it writes the managed block into your `AGENTS.md`, in place and idempotently:

```bash
coble policy install path/to/agentic-security-playbooks/dist/agent-security-policy.md   # user-level (~/.coble/AGENTS.md)
coble policy install ./agent-security-policy.md --project                               # this repo (<cwd>/AGENTS.md)
coble policy status      # show both scopes
coble policy uninstall   # remove the block, keep the rest of the file
```

Run it yourself in a terminal — the command is human-only (it refuses agent-driven
invocation; best-effort, see [SECURITY.md](./SECURITY.md)). It rejects the full playbook
doc — pass the *rendered* policy (just the block), not the whole document.

## How it works — the trust boundary

The interesting part of coble is what happens to a tool call *before* it runs. The
LLM is untrusted; every call it proposes crosses one decision point:

```
   model proposes a tool call   ·   read · write · edit · bash · git/PR
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

Two ideas carry the design. A **deterministic classifier** sorts each command into a
danger tier (`safe` / `confirm` / `dangerous`) — triage for *whether to ask a human*,
never the boundary itself. The **OS sandbox** is the boundary: it confines what an
approved command can reach, however the command is spelled. In between, permission
**modes** and user `allow` / `ask` / `deny` rules decide what runs unattended, a project
`.coble/settings.yaml` may only *tighten* (a cloned repo can't grant itself access), and
untrusted tool output is wrapped in a spotlighting envelope so it can't smuggle
instructions back to the model. Full threat model and the honest limits of every layer:
[SECURITY.md](./SECURITY.md).

Underneath, the loop is a small LangGraph `StateGraph` (`agent → tools → agent`)
checkpointed to SQLite — so `interrupt()` can pause for approval and a killed run resumes
from its last step. That durability is deliberately boring infrastructure; the boundary
above is the part worth reading.

## Development

Build, test, local-isolation, and headless/one-shot usage notes live in [DEVELOP.md](./DEVELOP.md).

## License

MIT
