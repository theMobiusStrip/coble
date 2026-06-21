import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage } from "@langchain/core/messages";
import { policyForMode, PERMISSION_MODES, type ApprovalPolicy, type PermissionMode } from "../core/approval.js";
import { setGlobalConfig } from "../core/config.js";
import { runAgent, type EngineOptions } from "../core/engine.js";
import type { AgentEvent, PendingCall, TokenUsage } from "../core/events.js";
import { resolveModel, type ResolvedModel } from "../core/models.js";
import type { Sandbox } from "../core/sandbox.js";
import { bashFailed } from "../core/tools/bash.js";
import { Banner } from "./Banner.js";
import { Onboarding } from "./Onboarding.js";
import { StatusBar } from "./StatusBar.js";
import { previewLines, TIER_COLOR, toolLabel } from "./theme.js";

export type EngineFn = (opts: EngineOptions) => AsyncIterable<AgentEvent>;

/** Default first-run helpers; injectable in tests. */
export const defaultSetupDeps = {
  /** true ⇒ show onboarding (no model resolvable and none explicitly chosen). */
  async needsSetup(modelSpec?: string): Promise<boolean> {
    if (modelSpec !== undefined) return false;
    try {
      await resolveModel(undefined);
      return false;
    } catch {
      return true;
    }
  },
  save(entries: Record<string, string>): void {
    for (const [k, v] of Object.entries(entries)) {
      setGlobalConfig(k, v);
      process.env[k] = v;
    }
  },
  async validate(spec: string): Promise<void> {
    const { model } = await resolveModel(spec);
    await model.invoke([new HumanMessage("Reply with exactly: ok")], {
      signal: AbortSignal.timeout(20_000),
    });
  },
};

export type SetupDeps = typeof defaultSetupDeps;

/** Next permission mode in the Shift+Tab cycle. */
function nextMode(m: PermissionMode): PermissionMode {
  const i = PERMISSION_MODES.indexOf(m);
  return PERMISSION_MODES[(i + 1) % PERMISSION_MODES.length] ?? "default";
}

/** Short footer label for the sandbox; undefined when --sandbox was not set. */
function sandboxLabel(sb: Sandbox | undefined): string | undefined {
  if (!sb || sb.status === "off") return undefined; // not requested
  if (sb.active) return "🔒 sandbox on";
  if (sb.status === "initializing") return "🔒 sandbox pending";
  return "⚠ sandbox unavailable"; // requested but fell back; see `coble doctor`
}

type ToolStatus = "running" | "ok" | "fail" | "denied";

/** How much of the tool trail to render. tab cycles hidden → compact → full. */
type ToolDetail = "hidden" | "compact" | "full";

type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; input: string; tier: string; status: ToolStatus; result?: string; ms?: number }
  | { kind: "info"; text: string; toolNoise?: boolean }
  | { kind: "error"; text: string };

export interface AppProps {
  cwd: string;
  policy: ApprovalPolicy;
  modelSpec?: string;
  initialPrompt?: string;
  /** OS sandbox confining bash/git (off by default). */
  sandbox?: Sandbox;
  /** Explicit classifier model for `auto` mode (undefined if none or if it failed
   *  to resolve). When `autoClassifierConfigured` is false, auto mode falls back
   *  to the agent model; when true but this is undefined, auto mode fails closed. */
  classifierModel?: BaseChatModel;
  /** Whether a separate auto-mode classifier was configured (autoMode.model /
   *  COBLE_AUTO_MODEL). Gates the fall-back-to-agent-model behavior. */
  autoClassifierConfigured?: boolean;
  /** Append-only audit sink, wired by the CLI; omitted in tests ⇒ no recording. */
  audit?: EngineOptions["audit"];
  /** Dependency injection for tests. */
  engine?: EngineFn;
  resolver?: (spec?: string) => Promise<ResolvedModel>;
  setup?: Partial<SetupDeps>;
}

const MAX_ITEMS = 500;

/** Patch the most recent still-running tool item (tool_end/denied resolve it). */
function resolveTool(items: Item[], patch: Partial<Extract<Item, { kind: "tool" }>>): Item[] | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    if (it?.kind === "tool" && it.status === "running") {
      const next = items.slice();
      next[i] = { ...it, ...patch };
      return next;
    }
  }
  return undefined;
}

/** Collapsed view of a command/input: first line only, hard-capped width. */
function compactInput(input: string, full: boolean): string {
  if (full) return input;
  const nl = input.indexOf("\n");
  const first = (nl === -1 ? input : input.slice(0, nl)).trimEnd();
  const truncated = nl !== -1 || first.length > 100;
  return truncated ? `${first.slice(0, 100)} …` : first;
}

function ToolView({ item, detail }: { item: Extract<Item, { kind: "tool" }>; detail: ToolDetail }) {
  const full = detail === "full";
  const dotColor =
    item.status === "ok" ? "green" : item.status === "running" ? "yellow" : "red";
  const result = (item.result ?? "").replace(/\s+$/, "");
  const resultLines = result.length === 0 ? [] : result.split("\n");
  // Collapsed (default): successful multi-line output shrinks to a count.
  // Failures always show their preview — errors are signal, not noise.
  const collapsed = !full && item.status === "ok" && resultLines.length > 1;
  const lines = collapsed
    ? [`${resultLines.length} lines (tab to expand)`]
    : item.result !== undefined
      ? previewLines(item.result, full ? 24 : 4)
      : [];
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={dotColor}>⏺</Text> <Text bold>{toolLabel(item.name)}</Text>
        <Text dimColor>({compactInput(item.input, full)})</Text>
      </Text>
      {item.status === "running" ? (
        <Text dimColor>
          {"  ⎿ "}
          <Spinner type="dots" /> running…
        </Text>
      ) : item.status === "denied" ? (
        <Text color="red">{"  ⎿ denied"}{item.result ? `: ${item.result}` : ""}</Text>
      ) : (
        lines.map((line, i) => (
          <Text key={i} dimColor>
            {i === 0 ? "  ⎿ " : "    "}
            {line}
          </Text>
        ))
      )}
    </Box>
  );
}

function MessageView({ item, detail }: { item: Item; detail: ToolDetail }) {
  switch (item.kind) {
    case "user":
      return <Text color="green">{`› ${item.text}`}</Text>;
    case "assistant":
      return (
        <Text>
          <Text color="cyan">⏺</Text> {item.text}
        </Text>
      );
    case "tool":
      return <ToolView item={item} detail={detail} />;
    case "error":
      return <Text color="red">{`✗ ${item.text}`}</Text>;
    case "info":
      return <Text dimColor>{item.text}</Text>;
  }
}

/**
 * Hidden mode keeps the conversation clean: finished tools and auto-approval
 * noise drop out; still-running tools (live activity) and denied calls
 * (a safety signal) stay visible.
 */
function isVisible(item: Item, detail: ToolDetail): boolean {
  if (detail !== "hidden") return true;
  if (item.kind === "tool") return item.status === "running" || item.status === "denied";
  if (item.kind === "info" && item.toolNoise) return false;
  return true;
}

export function App({ cwd, policy, modelSpec, initialPrompt, sandbox, classifierModel, autoClassifierConfigured, audit, engine, resolver, setup }: AppProps) {
  const { exit } = useApp();
  const [input, setInput] = useState(initialPrompt ?? "");
  const [items, setItems] = useState<Item[]>([]);
  const [streamText, setStreamText] = useState("");
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<PendingCall[] | null>(null);
  const [setupState, setSetupState] = useState<"checking" | "needed" | "done">("checking");
  const [usage, setUsage] = useState<TokenUsage>({ inputTokens: 0, outputTokens: 0 });
  const [modelLabel, setModelLabel] = useState<string | undefined>(modelSpec);
  const [detail, setDetail] = useState<ToolDetail>("hidden");
  const [autoApprove, setAutoApprove] = useState(false);
  const [mode, setMode] = useState<PermissionMode>(policy.mode);
  // Snapshotted because sandbox.active/status are getters that flip during a run.
  const [sbLabel, setSbLabel] = useState<string | undefined>(() => sandboxLabel(sandbox));
  const modelRef = useRef<ResolvedModel | null>(null);
  const approvalResolver = useRef<((decisions: Record<string, boolean>) => void) | null>(null);
  // Ref mirror of autoApprove: onApproval is a stable callback and must see the
  // current value, not the one captured at creation.
  const autoApproveRef = useRef(false);
  const setupDeps: SetupDeps = { ...defaultSetupDeps, ...setup };

  const append = useCallback((item: Item) => {
    setItems((prev) => [...prev.slice(-MAX_ITEMS), item]);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const needed = await setupDeps.needsSetup(modelSpec);
      if (cancelled) return;
      if (needed) {
        setSetupState("needed");
        return;
      }
      if (modelSpec !== undefined) {
        setModelLabel(modelSpec);
        setSetupState("done");
        return;
      }
      try {
        const resolved = await (resolver ?? resolveModel)(undefined);
        if (!cancelled) {
          modelRef.current = resolved;
          setModelLabel(resolved.label);
        }
      } catch {
        // Tests may bypass setup without a real model; keep the TUI usable.
      }
      if (!cancelled) setSetupState("done");
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  // Bridge the engine's onApproval promise to a y/a/N keypress. Once
  // approve-all is on, every later batch resolves instantly — the interactive
  // twin of --dangerously-allow, scoped to this session and opted into
  // explicitly. Each call still renders in the tool tree and the audit log.
  const onApproval = useCallback(
    (calls: PendingCall[]) => {
      if (autoApproveRef.current) {
        append({ kind: "info", toolNoise: true, text: `✓ auto-approved: ${calls.map((c) => toolLabel(c.name)).join(", ")}` });
        return Promise.resolve(Object.fromEntries(calls.map((c) => [c.id, true])));
      }
      return new Promise<Record<string, boolean>>((resolve) => {
        setApproval(calls);
        approvalResolver.current = resolve;
      });
    },
    [append],
  );

  const decide = useCallback(
    (approved: boolean, all = false) => {
      const calls = approval;
      const resolver = approvalResolver.current;
      if (calls === null || resolver === null) return;
      setApproval(null);
      approvalResolver.current = null;
      if (all) {
        autoApproveRef.current = true;
        setAutoApprove(true);
      }
      append({
        kind: "info",
        text: approved
          ? `✓ approved: ${calls.map((c) => toolLabel(c.name)).join(", ")}${all ? " — auto-approving the rest of this session" : ""}`
          : `✗ denied: ${calls.map((c) => toolLabel(c.name)).join(", ")}`,
      });
      resolver(Object.fromEntries(calls.map((c) => [c.id, approved])));
    },
    [append, approval],
  );

  useInput(
    (inputChar) => {
      if (approval === null) return;
      const ch = inputChar.toLowerCase();
      if (ch === "y") decide(true);
      else if (ch === "a") decide(true, true);
      else if (ch === "n") decide(false);
    },
    { isActive: approval !== null },
  );

  // The sandbox is reused across prompts (the engine init()s it idempotently
  // and skips teardown for interactive runs); dispose it once when the app exits.
  useEffect(() => {
    return () => {
      void sandbox?.dispose();
    };
  }, [sandbox]);

  // shift+tab cycles the permission mode; plain tab cycles the tool trail
  // (hidden → compact → full). tab (not ctrl+o) because ink-text-input filters
  // tab but would insert a literal "o" on ctrl+o.
  useInput((_ch, key) => {
    if (key.tab && key.shift) {
      setMode((m) => nextMode(m));
    } else if (key.tab) {
      setDetail((d) => (d === "hidden" ? "compact" : d === "compact" ? "full" : "hidden"));
    }
  });

  const submit = useCallback(
    async (raw: string) => {
      const prompt = raw.trim();
      if (prompt.length === 0 || busy) return;
      if (prompt === "exit" || prompt === "quit") {
        await sandbox?.dispose(); // await teardown on the explicit-quit path
        exit();
        return;
      }
      setInput("");
      append({ kind: "user", text: prompt });
      setBusy(true);
      let streamed = "";
      let gotText = false;
      try {
        if (modelRef.current === null) {
          modelRef.current = await (resolver ?? resolveModel)(modelSpec);
          setModelLabel(modelRef.current.label);
        }
        const { model } = modelRef.current;
        const run = (engine ?? runAgent)({
          prompt,
          cwd,
          model,
          policy: policyForMode(mode, policy.rules), // current mode + configured rules
          onApproval,
          sandbox,
          audit, // persist tool decisions to the audit log (omitted in tests)
          // auto mode: use the configured classifier (or undefined ⇒ fail closed
          // if it failed to resolve); fall back to the agent model only when no
          // separate classifier was configured.
          classifierModel: autoClassifierConfigured ? classifierModel : model,
        });
        for await (const ev of run) {
          switch (ev.type) {
            case "token":
              streamed += ev.text;
              setStreamText(streamed);
              break;
            case "model_end": {
              const text = streamed.length > 0 ? streamed : ev.text;
              if (text.trim().length > 0) {
                append({ kind: "assistant", text: text.trim() });
                gotText = true;
              }
              streamed = "";
              setStreamText("");
              break;
            }
            case "tool_start":
              append({ kind: "tool", name: ev.name, input: ev.input, tier: ev.tier, status: "running" });
              break;
            case "tool_end":
              setItems(
                (prev) =>
                  resolveTool(prev, {
                    status: ev.ok && !bashFailed(ev.name, ev.output) ? "ok" : "fail",
                    result: ev.output,
                    ms: ev.ms,
                  }) ?? prev,
              );
              break;
            case "tool_denied":
              setItems(
                (prev) =>
                  resolveTool(prev, { status: "denied", result: ev.reason }) ?? [
                    ...prev.slice(-MAX_ITEMS),
                    { kind: "tool", name: ev.name, input: ev.input, tier: "dangerous", status: "denied", result: ev.reason },
                  ],
              );
              break;
            case "final":
              setUsage((u) => ({
                inputTokens: u.inputTokens + ev.usage.inputTokens,
                outputTokens: u.outputTokens + ev.usage.outputTokens,
              }));
              // A run that produced no answer must say so — in hidden mode
              // there is no tool trail to hint at what happened.
              if (ev.capped && ev.text.trim().length === 0) {
                append({
                  kind: "error",
                  text: `stopped at the ${ev.steps}-step limit without a final answer — press tab to inspect the tool trail`,
                });
              } else if (!gotText && ev.text.trim().length === 0) {
                append({
                  kind: "error",
                  text: "the run ended without a final answer — press tab to inspect the tool trail",
                });
              }
              break;
            case "error":
              append({ kind: "error", text: ev.message });
              break;
            case "approval_required":
              // onApproval drives the prompt UI; nothing to log here.
              break;
            default:
              break;
          }
        }
      } catch (err) {
        append({ kind: "error", text: err instanceof Error ? err.message : String(err) });
      } finally {
        streamed = "";
        setStreamText("");
        setBusy(false);
        setSbLabel(sandboxLabel(sandbox)); // reflect engaged/fell-back state post-run
      }
    },
    [append, busy, cwd, engine, exit, modelSpec, onApproval, policy, resolver, sandbox, mode, classifierModel, autoClassifierConfigured],
  );

  const model = modelLabel ?? "no model";

  if (setupState !== "done") {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Banner cwd={cwd} model={modelLabel} hint={setupState === "checking" ? "checking configuration" : "first-run setup"} />
        {setupState === "checking" ? (
          <Text dimColor>checking configuration…</Text>
        ) : (
          <Onboarding
            save={setupDeps.save}
            validate={setupDeps.validate}
            onDone={(note, label) => {
              append({ kind: "info", text: `✓ ${note}` });
              setModelLabel(label);
              setSetupState("done");
            }}
            onSkip={() => {
              append({
                kind: "info",
                text: "setup skipped — configure later with `coble config set GOOGLE_API_KEY <key>` or pass -m.",
              });
              setSetupState("done");
            }}
          />
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Banner cwd={cwd} model={modelLabel} />
      {items.filter((item) => isVisible(item, detail)).map((item, i) => (
        <Box key={i} marginBottom={item.kind === "tool" || item.kind === "assistant" ? 1 : 0}>
          <MessageView item={item} detail={detail} />
        </Box>
      ))}
      {streamText.length > 0 ? (
        <Text>
          <Text color="cyan">⏺</Text> {streamText}
        </Text>
      ) : null}
      {approval !== null ? (
        <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={1} marginTop={1}>
          <Text bold color="yellow">
            ⚠ approval required — {approval.length} call(s)
          </Text>
          {approval.map((c) => (
            <Text key={c.id}>
              <Text color={TIER_COLOR[c.tier]}>{`  ${c.tier}`}</Text> <Text bold>{toolLabel(c.name)}</Text>
              <Text dimColor>({c.summary})</Text>
            </Text>
          ))}
          <Text>
            <Text color="green">y</Text> approve · <Text color="green">a</Text> approve all (rest of session) ·{" "}
            <Text color="red">n</Text> deny
          </Text>
        </Box>
      ) : busy ? (
        <Text color="yellow">
          <Spinner type="dots" /> working…
        </Text>
      ) : (
        <Box borderStyle="round" borderColor="gray" paddingX={1}>
          <Text color="green">{"› "}</Text>
          <TextInput value={input} onChange={setInput} onSubmit={(v) => void submit(v)} placeholder="task…" />
        </Box>
      )}
      <StatusBar model={model} usage={usage} autoApprove={autoApprove} toolDetail={detail} mode={mode} sandbox={sbLabel} />
    </Box>
  );
}
