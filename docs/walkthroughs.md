# Walkthroughs

Runnable end-to-end walkthroughs of coble's three core flows — resume, approval, and repo review. They avoid external writes by default; the review example pushes only to a local bare repository unless `--live-pr` is added intentionally.

## 1. Resume

Terminal A:

```bash
export COBLE_HOME="$(mktemp -d)"
npm run build
node dist/cli.js -p -m ollama:llama3.1 "audit src and summarize the riskiest file"
```

Kill Terminal A while the task is running.

Terminal B:

```bash
node dist/cli.js sessions
node dist/cli.js resume <session-id>
```

What happens: the session id, a partial run, and resume continuing from the recorded checkpoint.

## 2. Approval

```bash
export COBLE_HOME="$(mktemp -d)"
npm run build
node dist/cli.js -p -m ollama:llama3.1 "push this repository to origin main"
```

When the approval prompt appears, answer `n`.

What happens: the dangerous tool approval, the refusal, and the agent switching away from the push.

## 3. Repo Review

```bash
export COBLE_HOME="$(mktemp -d)"
npm run build

COBLE_REPO="$PWD"
WORK_ROOT="$(mktemp -d)"
git clone "$COBLE_REPO" "$WORK_ROOT/repo"
git init --bare "$WORK_ROOT/origin.git"
git -C "$WORK_ROOT/repo" remote set-url origin "$WORK_ROOT/origin.git"

node "$COBLE_REPO/dist/cli.js" review "$WORK_ROOT/repo" -m ollama:llama3.1 --dangerously-allow
```

What happens: `AUDIT.md` being written, a branch being pushed to the local bare remote, the PR tool staying in dry-run mode, and the final review summary.

To run the same flow against GitHub for a real PR, point the example repo at a GitHub remote and add `--live-pr` only after explicitly approving the external write.
