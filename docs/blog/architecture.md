# Building coble: a local agent loop you can audit

Most coding agents are interesting at the product boundary: a prompt goes in, a patch or command comes out. `coble` is intentionally smaller. It is a local CLI that keeps the mechanics visible: graph state, tool calls, approval gates, durable checkpoints, and evals that judge outcomes instead of exact tool traces.

The project is built around one claim: a local agent becomes easier to trust when its control flow is explicit and replayable.

## The core loop

`coble` uses LangGraph.js for the agent loop:

```text
agent -> tools -> agent
```

The graph keeps messages, pending approvals, usage accounting, and session metadata in state. The model layer is deliberately thin: a `provider:model` string resolves to OpenAI, Anthropic, Ollama, or a deterministic scripted model used by the eval suite.

That provider split matters because the rest of the system should not care which model proposed a tool call. The graph sees a model response, classifies any requested tool, and either executes it or pauses for approval.

## Why LangGraph

A bare loop is not hard. The hard parts are the operational edges:

- checkpoint before and after meaningful steps
- resume a killed process without replaying completed side effects
- pause the graph for a human approval and continue with the decision
- keep a structure that is inspectable in tests

Those are exactly the pieces LangGraph gives the project. The framework is not there to make the loop clever; it is there to make the loop durable.

## Tools and approval tiers

The tool surface starts small: read, write, edit, bash, and a vertical git/PR tool group for repo review. Every tool call is classified:

| Tier | Examples | Default behavior |
| --- | --- | --- |
| safe | read, list, grep | run directly |
| confirm | write, edit, allowlisted shell | run unless `--paranoid` is set |
| dangerous | arbitrary shell, push, PR creation | require approval |

Approvals happen before side effects. That ordering is the important part: if the process dies while waiting, resuming the session returns to the pending approval instead of guessing whether the command already ran.

Every decision is also appended to an audit log under `COBLE_HOME`, so a run leaves a local trail.

## Persistence model

The local state root is `~/.coble` by default, overrideable with `COBLE_HOME`. The SQLite checkpointer stores LangGraph state; a JSON session index powers `coble sessions`; audit events go to JSONL.

This split keeps the runtime simple:

- graph state belongs to the checkpointer
- user-facing session metadata belongs to the session index
- tool-decision evidence belongs to the audit log

Tests use temporary `COBLE_HOME` directories, so persistence behavior can be exercised without touching the user's real state.

## Evals

The eval harness is fixture-based. Each task has a prompt, an isolated workspace, and assertions over outcomes: file exists, content matches, command refused, branch state is correct.

That distinction is deliberate. Tool-call traces are useful for debugging, but they are brittle as pass/fail criteria. A strong agent may refuse a destructive request outright instead of attempting the exact command a test author expected. `coble` treats that as success when the outcome is right.

CI runs the scripted model path deterministically. Real-model runs can be written back to `evals/RESULTS.md` when a maintainer wants to refresh the public table.

## The vertical workflow

The showcase workflow is repo review:

```bash
coble review .
```

The review prompt asks the agent to inspect a repository, write `AUDIT.md`, create a branch, commit the report, and prepare a pull request. By default the PR step is a dry run; `--live-pr` is the explicit switch that crosses into external writes.

That vertical path gives the project a concrete product test: not "can the agent call tools", but "can it complete a useful review workflow while preserving local approvals and auditability."

## What this is not

`coble` is not trying to be a general Claude Code replacement. It is a compact implementation of the mechanisms that make local agents understandable: state, tools, approvals, persistence, and evals.

That small surface is the point. The codebase is meant to be readable enough that a user can inspect the trust boundary before letting the agent touch a real repo.
