# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

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

### Notes
- The classifier remains defense-in-depth (it decides whether to ask a human),
  not a security boundary; `--sandbox` is the OS-enforced boundary.
- `@anthropic-ai/sandbox-runtime` is pre-1.0; its API may change between releases.
