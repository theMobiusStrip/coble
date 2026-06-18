# Audit log

Every tool decision coble makes is appended to a local log, so a run leaves an
inspectable trail of *what the agent did* and *why it was allowed or blocked*.

## Where

`$COBLE_HOME/audit.jsonl` (default `~/.coble/audit.jsonl`) — one JSON object per line.

## What gets logged

One entry per tool call, written the moment it runs, is denied, or errors — across
**every run mode**: the interactive TUI, headless `-p`, `coble review`, and `coble resume`.

| Field | Meaning |
| --- | --- |
| `ts` | ISO-8601 timestamp |
| `tool` | tool name — `bash`, `read_file`, `write_file`, `edit_file`, `git_push`, … |
| `summary` | one-line command / path / PR title (never file contents) |
| `tier` | danger tier: `safe` · `confirm` · `dangerous` |
| `decision` | `auto` (ran, no prompt) · `approved` (you approved) · `denied` (blocked or refused) · `error` (the tool threw) |
| `detail` | the reason — `mode:default`, `rule:deny Bash(curl:*)`, `auto:block <reason>`, `user denied approval`, or an error message |

It records **decisions and one-line summaries, not contents** — file bodies and command
*output* never reach the log, and coble never adds its own provider keys or `.env` values.

But a `bash` summary is the **literal command string**, so a secret written directly into a
command — an `Authorization: Bearer …` header, a `--password` flag, `FOO=secret cmd` — **will**
appear in the log, exactly as it shows in the on-screen tool trail and your shell history.
coble does not redact command text, so treat `audit.jsonl` as potentially sensitive and don't
share it blindly.

## Try it (no API key)

A deterministic scripted run against an isolated state dir:

```bash
npm run build
export COBLE_HOME=$(mktemp -d)        # isolate from your real ~/.coble
cat > /tmp/script.json <<'JSON'
[
  { "toolCalls": [{ "name": "bash", "args": { "command": "echo hello" } }] },
  { "toolCalls": [{ "name": "write_file", "args": { "path": "note.txt", "content": "hi" } }] },
  { "toolCalls": [{ "name": "bash", "args": { "command": "rm -rf build" } }] },
  { "content": "all done" }
]
JSON
node dist/cli.js -p -C "$(mktemp -d)" -m "scripted:/tmp/script.json" "demo"
```

The three tool calls produce three audit entries:

```jsonl
{"ts":"…","tool":"bash","summary":"echo hello","tier":"safe","decision":"auto","detail":"mode:default"}
{"ts":"…","tool":"write_file","summary":"note.txt","tier":"confirm","decision":"auto","detail":"mode:default"}
{"ts":"…","tool":"bash","summary":"rm -rf build","tier":"dangerous","decision":"denied","detail":"\"dangerous\"-tier call requires approval (headless)"}
```

## View it

```bash
coble audit            # the whole log
coble audit -n 20      # last 20 entries
```

```
2026-…  AUTO     safe      bash(echo hello)
2026-…  AUTO     confirm   write_file(note.txt)
2026-…  DENIED   dangerous bash(rm -rf build)
```

## Limitations

- **Not tamper-evident** — plain JSONL; anyone with file access can edit it. A
  hash-chained, tamper-evident log is tracked but not yet implemented.
- **No rotation / size cap** — the file grows unbounded.
- **No session id** — entries from all runs interleave in one file, ordered by `ts`.

The audit log is a *record*, not a security boundary — see [SECURITY.md](../SECURITY.md)
for the full trust model.
