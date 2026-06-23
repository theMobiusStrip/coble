import { Box, Text } from "ink";
import { VERSION } from "../version.js";
import { shortModel } from "./theme.js";

export interface BannerProps {
  cwd: string;
  model?: string;
  /** Replaces the default tip lines (onboarding/setup contexts). */
  hint?: string;
  /** Extra status lines (e.g. key source, git branch). */
  notes?: string[];
}

const DEFAULT_TIPS = [
  "shell & git actions pause for your approval",
  "shift+tab cycles permission mode · tab cycles tool detail",
  'type / for commands · "exit" or ctrl+c to quit',
];

/** Pad a row label so values line up under each other. */
const label = (s: string) => `${s}`.padEnd(6);

export function Banner({ cwd, model, hint, notes }: BannerProps) {
  const tips = hint ? [hint] : DEFAULT_TIPS;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} alignSelf="flex-start">
        <Text>
          <Text color="cyan">⛵ </Text>
          <Text bold color="cyan">
            coble
          </Text>
          <Text dimColor> v{VERSION}</Text>
        </Text>
        {model ? (
          <Text>
            <Text dimColor>{label("model")}</Text>
            {shortModel(model)}
          </Text>
        ) : (
          <Text dimColor>no model · run setup</Text>
        )}
        <Text>
          <Text dimColor>{label("cwd")}</Text>
          <Text dimColor>{cwd}</Text>
        </Text>
        {(notes ?? []).map((n, i) => (
          <Text key={i} dimColor>
            {n}
          </Text>
        ))}
      </Box>
      {tips.map((t, i) => (
        <Text key={i} color={hint ? "yellow" : undefined} dimColor={!hint}>
          {`  ▸ ${t}`}
        </Text>
      ))}
    </Box>
  );
}
