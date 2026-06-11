import { useCallback, useRef, useState } from "react";
import { Box, Text, useApp } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import type { ApprovalPolicy } from "../core/approval.js";
import { formatUsage } from "../core/cost.js";
import { runAgent, type EngineOptions } from "../core/engine.js";
import type { AgentEvent } from "../core/events.js";
import { resolveModel, type ResolvedModel } from "../core/models.js";

export type EngineFn = (opts: EngineOptions) => AsyncIterable<AgentEvent>;

interface Line {
  kind: "user" | "assistant" | "tool" | "denied" | "info" | "error";
  text: string;
}

export interface AppProps {
  cwd: string;
  policy: ApprovalPolicy;
  modelSpec?: string;
  initialPrompt?: string;
  /** Dependency injection for tests. */
  engine?: EngineFn;
  resolver?: (spec?: string) => Promise<ResolvedModel>;
}

const MAX_LINES = 500;

export function App({ cwd, policy, modelSpec, initialPrompt, engine, resolver }: AppProps) {
  const { exit } = useApp();
  const [input, setInput] = useState(initialPrompt ?? "");
  const [lines, setLines] = useState<Line[]>([]);
  const [streamText, setStreamText] = useState("");
  const [busy, setBusy] = useState(false);
  const modelRef = useRef<ResolvedModel | null>(null);

  const append = useCallback((line: Line) => {
    setLines((prev) => [...prev.slice(-MAX_LINES), line]);
  }, []);

  const submit = useCallback(
    async (raw: string) => {
      const prompt = raw.trim();
      if (prompt.length === 0 || busy) return;
      if (prompt === "exit" || prompt === "quit") {
        exit();
        return;
      }
      setInput("");
      append({ kind: "user", text: `> ${prompt}` });
      setBusy(true);
      let streamed = "";
      try {
        if (modelRef.current === null) {
          modelRef.current = await (resolver ?? resolveModel)(modelSpec);
        }
        const { model, label } = modelRef.current;
        const run = (engine ?? runAgent)({ prompt, cwd, model, policy });
        for await (const ev of run) {
          switch (ev.type) {
            case "token":
              streamed += ev.text;
              setStreamText(streamed);
              break;
            case "model_end": {
              const text = streamed.length > 0 ? streamed : ev.text;
              if (text.trim().length > 0) append({ kind: "assistant", text });
              streamed = "";
              setStreamText("");
              break;
            }
            case "tool_start":
              append({ kind: "tool", text: `⚙ ${ev.name}(${ev.input})` });
              break;
            case "tool_end":
              append({ kind: "tool", text: `${ev.ok ? "✓" : "✗"} ${ev.name} (${ev.ms}ms)` });
              break;
            case "tool_denied":
              append({ kind: "denied", text: `✗ denied: ${ev.name}(${ev.input}) — ${ev.reason}` });
              break;
            case "final":
              append({
                kind: "info",
                text: `— done: ${ev.steps} step(s), ${formatUsage(modelRef.current.label, ev.usage)} [${label}]`,
              });
              break;
            case "error":
              append({ kind: "error", text: `error: ${ev.message}` });
              break;
            default:
              break;
          }
        }
      } catch (err) {
        append({ kind: "error", text: `error: ${err instanceof Error ? err.message : String(err)}` });
      } finally {
        streamed = "";
        setStreamText("");
        setBusy(false);
      }
    },
    [append, busy, cwd, engine, exit, modelSpec, policy, resolver],
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        ⛵ coble
      </Text>
      <Text dimColor>
        {cwd} — type a task; "exit" to quit
      </Text>
      {lines.map((line, i) => (
        <Text
          key={i}
          color={line.kind === "error" || line.kind === "denied" ? "red" : line.kind === "user" ? "green" : undefined}
          dimColor={line.kind === "tool" || line.kind === "info"}
        >
          {line.text}
        </Text>
      ))}
      {streamText.length > 0 ? <Text>{streamText}</Text> : null}
      {busy ? (
        <Text color="yellow">
          <Spinner type="dots" /> working…
        </Text>
      ) : (
        <Box>
          <Text color="green">{"> "}</Text>
          <TextInput value={input} onChange={setInput} onSubmit={(v) => void submit(v)} placeholder="task…" />
        </Box>
      )}
    </Box>
  );
}
