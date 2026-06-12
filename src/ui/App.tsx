import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import { HumanMessage } from "@langchain/core/messages";
import type { ApprovalPolicy } from "../core/approval.js";
import { setGlobalConfig } from "../core/config.js";
import { runAgent, type EngineOptions } from "../core/engine.js";
import type { AgentEvent, PendingCall, TokenUsage } from "../core/events.js";
import { resolveModel, type ResolvedModel } from "../core/models.js";
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

type ToolStatus = "running" | "ok" | "fail" | "denied";

type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; input: string; tier: string; status: ToolStatus; result?: string; ms?: number }
  | { kind: "info"; text: string }
  | { kind: "error"; text: string };

export interface AppProps {
  cwd: string;
  policy: ApprovalPolicy;
  modelSpec?: string;
  initialPrompt?: string;
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

function ToolView({ item }: { item: Extract<Item, { kind: "tool" }> }) {
  const dotColor =
    item.status === "ok" ? "green" : item.status === "running" ? "yellow" : "red";
  const lines = item.result !== undefined ? previewLines(item.result) : [];
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={dotColor}>⏺</Text> <Text bold>{toolLabel(item.name)}</Text>
        <Text dimColor>({item.input})</Text>
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

function MessageView({ item }: { item: Item }) {
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
      return <ToolView item={item} />;
    case "error":
      return <Text color="red">{`✗ ${item.text}`}</Text>;
    case "info":
      return <Text dimColor>{item.text}</Text>;
  }
}

export function App({ cwd, policy, modelSpec, initialPrompt, engine, resolver, setup }: AppProps) {
  const { exit } = useApp();
  const [input, setInput] = useState(initialPrompt ?? "");
  const [items, setItems] = useState<Item[]>([]);
  const [streamText, setStreamText] = useState("");
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<PendingCall[] | null>(null);
  const [setupState, setSetupState] = useState<"checking" | "needed" | "done">("checking");
  const [usage, setUsage] = useState<TokenUsage>({ inputTokens: 0, outputTokens: 0 });
  const [modelLabel, setModelLabel] = useState<string | undefined>(modelSpec);
  const modelRef = useRef<ResolvedModel | null>(null);
  const approvalResolver = useRef<((decisions: Record<string, boolean>) => void) | null>(null);
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

  // Bridge the engine's onApproval promise to a y/N keypress.
  const onApproval = useCallback(
    (calls: PendingCall[]) =>
      new Promise<Record<string, boolean>>((resolve) => {
        setApproval(calls);
        approvalResolver.current = resolve;
      }),
    [],
  );

  const decide = useCallback(
    (approved: boolean) => {
      const calls = approval;
      const resolver = approvalResolver.current;
      if (calls === null || resolver === null) return;
      setApproval(null);
      approvalResolver.current = null;
      append({
        kind: "info",
        text: `${approved ? "✓ approved" : "✗ denied"}: ${calls.map((c) => toolLabel(c.name)).join(", ")}`,
      });
      resolver(Object.fromEntries(calls.map((c) => [c.id, approved])));
    },
    [append, approval],
  );

  useInput(
    (inputChar) => {
      if (approval === null) return;
      if (inputChar.toLowerCase() === "y") decide(true);
      else if (inputChar.toLowerCase() === "n") decide(false);
    },
    { isActive: approval !== null },
  );

  const submit = useCallback(
    async (raw: string) => {
      const prompt = raw.trim();
      if (prompt.length === 0 || busy) return;
      if (prompt === "exit" || prompt === "quit") {
        exit();
        return;
      }
      setInput("");
      append({ kind: "user", text: prompt });
      setBusy(true);
      let streamed = "";
      try {
        if (modelRef.current === null) {
          modelRef.current = await (resolver ?? resolveModel)(modelSpec);
          setModelLabel(modelRef.current.label);
        }
        const { model } = modelRef.current;
        const run = (engine ?? runAgent)({ prompt, cwd, model, policy, onApproval });
        for await (const ev of run) {
          switch (ev.type) {
            case "token":
              streamed += ev.text;
              setStreamText(streamed);
              break;
            case "model_end": {
              const text = streamed.length > 0 ? streamed : ev.text;
              if (text.trim().length > 0) append({ kind: "assistant", text: text.trim() });
              streamed = "";
              setStreamText("");
              break;
            }
            case "tool_start":
              append({ kind: "tool", name: ev.name, input: ev.input, tier: ev.tier, status: "running" });
              break;
            case "tool_end":
              setItems((prev) => resolveTool(prev, { status: ev.ok ? "ok" : "fail", result: ev.output, ms: ev.ms }) ?? prev);
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
      }
    },
    [append, busy, cwd, engine, exit, modelSpec, onApproval, policy, resolver],
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
      {items.map((item, i) => (
        <Box key={i} marginBottom={item.kind === "tool" || item.kind === "assistant" ? 1 : 0}>
          <MessageView item={item} />
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
            approve? <Text color="green">y</Text> {"/"} <Text color="red">n</Text>
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
      <StatusBar model={model} usage={usage} />
    </Box>
  );
}
