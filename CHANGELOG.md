# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **`coble policy install|status|uninstall [--project]`** — human-only command that writes a rendered
  agent-security policy block into `AGENTS.md` (user-level `~/.coble/AGENTS.md` by default, `--project`
  for `<cwd>/AGENTS.md`). Rejects the full playbook doc; accepts only the rendered
  `dist/agent-security-policy.md`. Idempotent in-place; preserves content outside the markers.
- **Web tools** — `web_fetch` (GET a URL) and `web_search` (Tavily; set `TAVILY_API_KEY` via
  `coble config set` or the env). `dangerous`-tier (approval-gated); under `--sandbox` they enforce the
  egress allowlist and refuse link-local/metadata IPs.
- **Two-layer `AGENTS.md` context** — loaded into the trusted system prompt: user-level
  `$COBLE_HOME/AGENTS.md` plus project `<cwd>/AGENTS.md` (project appended last, overrides).

### Fixed
- Render Anthropic array-content answers (previously the final reply could display blank).

## [0.4.1]

### Fixed
- The interactive TUI now writes to the audit log (`audit.jsonl`) like the headless,
  `review`, and `resume` paths already did — previously interactive sessions left no
  audit trail despite a comment claiming otherwise.

### Added
- `docs/audit-log.md` — what the audit log records, a runnable demo, and how to view it
  (linked from the README and SECURITY.md).

## [0.4.0]

TUI key-hint clarity.

### Changed
- The startup banner now states how to switch permission mode:
  **`shift+tab cycles permission mode (plan/default/careful/auto/bypass)`**.
- Renamed the middle tool-trail detail state `collapsed` → `compact` so the
  status bar (`tools: compact`) matches what's shown — every call listed, results
  summarized. Behaviour is unchanged: `tab` still cycles `hidden → compact → full`.

## [0.3.0]

Permission modes + customizable rules. See [SECURITY.md](./SECURITY.md).

### Added
- **Permission modes** (`--permission-mode`, settings `defaultMode`, TUI Shift+Tab):
  `plan` (read-only), `default`, `careful`, `auto` (model-judged), `bypass`.
  `--paranoid` / `--dangerously-allow` remain as aliases for `careful` / `bypass`.
- **Customizable allow/ask/deny rules** in layered `settings.yaml`
  (`~/.coble/settings.yaml` global + `<cwd>/.coble/settings.yaml` project),
  evaluated deny → ask → allow, overriding the mode gate per call. A **project
  file may only tighten** (its `allow`/`defaultMode`/`autoMode` are ignored) so a
  cloned repo cannot self-escalate.
- **`auto` mode** routes would-prompt calls to a configurable classifier model
  (`COBLE_AUTO_MODEL` / `settings.permissions.autoMode.model`) instead of the
  human. The classifier is shown the task + intent but **not** tool results
  (injection resistance), `git push`/PR still require a human, and it is **not** a
  security boundary — pair with `--sandbox`.

### Notes
- The deterministic classifier still decides *whether to ask*; `auto` mode adds an
  optional model judge on top — opt-in, per the design in `SECURITY.md`.

## [0.2.0]

Security model: evolve the command classifier into a defense-in-depth trust
boundary. See [SECURITY.md](./SECURITY.md).

### Added
- **Opt-in OS sandbox** (`--sandbox`, `--strict-sandbox`, `--allow-domain`,
  `COBLE_ALLOWED_DOMAINS`) confining `bash`/`git` subprocesses via
  `@anthropic-ai/sandbox-runtime` (Seatbelt on macOS, bubblewrap on Linux/WSL2):
  filesystem jail, default-deny network egress, and provider-key env scrub.
  Off by default; warns and falls back when the backend is unavailable
  (`--strict-sandbox` hard-fails instead).
- `coble doctor` now reports sandbox backend availability.
- Untrusted-content **spotlighting**: `read_file`/`bash` output (and untrusted
  error text) is wrapped in a nonce-bound `<untrusted-data>` envelope so injected
  file/command content cannot forge a boundary.
- `SECURITY.md` threat model; `CHANGELOG.md`.

### Fixed
- **Classifier bypasses** (`classifyBash`): newline and single `&` are now
  command separators; `env` is no longer treated as a safe binary
  (`env <cmd>` ran `<cmd>` unapproved); added argument-injection checks for
  `sort -o`/`--compress-program`, `date -s`, `rg --pre`/`--hostname-bin`/`-z`,
  and `uniq`'s output-file operand. Adversarial regression corpus added.
- **Workspace path jail** (`resolveInWorkspace`): resolves the real location of
  the deepest existing path component via `lstat`, closing static symlink
  read/write escapes — including dangling symlinks, which `existsSync` silently
  skipped.
- **Sandbox deny-read now covers the in-process read tools.** The OS deny-read
  list only bound `bash`/`git` subprocesses, so a model could `read_file('.env')`
  to pull provider keys into context. `read_file`/`edit_file` now refuse any
  denied path, matched live by `(device, inode)` identity (catches symlink,
  hard-link, and case-folded aliases) plus path containment for denied dirs and
  not-yet-existing paths — mirroring the path-based OS policy.

### Notes
- The classifier remains defense-in-depth (it decides whether to ask a human),
  not a security boundary; `--sandbox` is the OS-enforced boundary.
- `@anthropic-ai/sandbox-runtime` is pre-1.0; its API may change between releases.
