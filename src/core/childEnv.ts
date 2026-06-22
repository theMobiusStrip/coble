/**
 * Env var coble sets on every subprocess it spawns for the agent (the `bash`
 * tool). The `coble policy install/uninstall` commands check for it (with a
 * non-TTY check) and refuse when present, to deter a prompt-injected agent from
 * shelling out to `coble policy install <attacker-file>`.
 *
 * BEST-EFFORT TRIAGE, NOT A BOUNDARY. An agent that controls its shell defeats
 * both checks at once — `unset COBLE_AGENT_CHILD` clears this marker and a PTY
 * (`python3 -c "import pty; pty.spawn(...)"`) gives the child a real controlling
 * terminal so `isTTY` is true. The actual protections for the user-level context
 * file are: (1) running `coble policy install` from the agent is ITSELF a
 * `dangerous`-tier `bash` call, so it hits the normal approval gate the human
 * sees; and (2) `--sandbox` blocks the out-of-workspace `~/.coble` write at the
 * OS layer. This marker just stops the naive/accidental case — like coble's
 * classifier, it is defense-in-depth, never the wall.
 */
export const COBLE_AGENT_CHILD = "COBLE_AGENT_CHILD";
