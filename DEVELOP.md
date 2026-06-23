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

All coble state lives under `COBLE_HOME` (default `~/.coble`), so isolated runs are one env var away:

```bash
COBLE_HOME=$(mktemp -d) node dist/cli.js doctor --no-ping
```

## Headless / CI

`-p` runs one task, streams events, and exits; `scripted:` models run key-free:

```bash
coble -p "count the TODOs in src and summarize them"   # headless
coble -p -m scripted:fixture.json "..."                # deterministic, no key (CI)
```

Full flag/provider reference: [README](./README.md).
