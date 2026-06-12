import { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";

type Provider = "openai" | "anthropic";

const PROVIDERS: Record<Provider, { key: string; spec: string; hint: string }> = {
  openai: {
    key: "OPENAI_API_KEY",
    spec: "openai:gpt-5.5",
    hint: "https://platform.openai.com/api-keys",
  },
  anthropic: {
    key: "ANTHROPIC_API_KEY",
    spec: "anthropic:claude-sonnet-4-6",
    hint: "https://console.anthropic.com/settings/keys",
  },
};

export interface OnboardingProps {
  /** Persist entries to the global config AND the current process env. */
  save: (entries: Record<string, string>) => void;
  /** Throw to reject the key (e.g. live ping failed). */
  validate: (spec: string) => Promise<void>;
  onDone: (note: string, model?: string) => void;
  onSkip: () => void;
}

/**
 * First-run setup: pick a provider, paste a key, validate it live, persist
 * globally. Triggered by the TUI when no model can be resolved.
 */
export function Onboarding({ save, validate, onDone, onSkip }: OnboardingProps) {
  const [step, setStep] = useState<"provider" | "key" | "validating">("provider");
  const [provider, setProvider] = useState<Provider>("openai");
  const [keyInput, setKeyInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  useInput(
    (ch, ink) => {
      if (step !== "provider") {
        if (ink.escape && step === "key") {
          setStep("provider");
          setError(null);
        }
        return;
      }
      if (ch === "1") {
        setProvider("openai");
        setStep("key");
      } else if (ch === "2") {
        setProvider("anthropic");
        setStep("key");
      } else if (ch === "3") {
        save({ COBLE_MODEL: "ollama:llama3.1" });
        onDone("default model set to ollama:llama3.1 — make sure `ollama pull llama3.1` has run.", "ollama:llama3.1");
      } else if (ch === "q" || ink.escape) {
        onSkip();
      }
    },
    { isActive: step !== "validating" },
  );

  const submitKey = async (raw: string) => {
    const value = raw.trim();
    if (value.length === 0) return;
    const { key, spec } = PROVIDERS[provider];
    setStep("validating");
    setError(null);
    const previous = process.env[key];
    process.env[key] = value; // stage for validation
    try {
      await validate(spec);
      save({ [key]: value, COBLE_MODEL: spec });
      onDone(`${key} saved globally — default model ${spec}.`, spec);
    } catch (err) {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
      setError((err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "validation failed");
      setKeyInput("");
      setStep("key");
    }
  };

  if (step === "provider") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold color="cyan">
          ⚙ first-run setup — no model configured yet
        </Text>
        <Text>
          {"  "}<Text color="green">1</Text> OpenAI (gpt-5.5)
        </Text>
        <Text>
          {"  "}<Text color="green">2</Text> Anthropic (claude-sonnet-4-6)
        </Text>
        <Text>
          {"  "}<Text color="green">3</Text> Ollama — local, free, no key
        </Text>
        <Text dimColor>press 1/2/3 to choose, q to skip</Text>
      </Box>
    );
  }

  const { key, hint } = PROVIDERS[provider];
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="cyan">
        ⚙ paste your {key}
      </Text>
      <Text dimColor>get one: {hint} — input is hidden; enter to validate, esc to go back</Text>
      {error === null ? null : <Text color="red">✗ {error}</Text>}
      {step === "validating" ? (
        <Text color="yellow">
          <Spinner type="dots" /> validating key with a live request…
        </Text>
      ) : (
        <Box>
          <Text color="green">{"key> "}</Text>
          <TextInput value={keyInput} onChange={setKeyInput} onSubmit={(v) => void submitKey(v)} mask="•" />
        </Box>
      )}
    </Box>
  );
}
