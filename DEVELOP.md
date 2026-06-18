# Developing coble

## Setup & scripts

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

All state — sessions, checkpoints, audit log, global config — lives under `COBLE_HOME`
(default `~/.coble`), so isolated runs are one env var away:

```bash
COBLE_HOME=$(mktemp -d) node dist/cli.js doctor --no-ping
```

## Running

```bash
coble                                                  # interactive TUI
coble -p "count the TODOs in src and summarize them"   # one-shot, headless (scripting / CI)
coble -p -m ollama:llama3.1 "explain this repo"        # fully local — no key, no cloud
```

`-p` runs a single task, streams events, and exits.
