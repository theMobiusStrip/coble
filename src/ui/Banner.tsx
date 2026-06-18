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

// A little fishing boat (a "coble") in block elements — all guaranteed
// single-width (U+2580–U+259F) so the columns stay aligned everywhere.
const LOGO = ["  ▟█▙  ", " ▟███▙ ", "▟█████▙", "▀▀▀▀▀▀▀"];

const DEFAULT_TIPS = [
  "shell & git actions pause for your approval",
  "shift+tab cycles permission mode (plan/default/careful/auto/bypass)",
  'tab cycles tool detail (hidden/compact/full) · "exit" to quit · ctrl+c to cancel',
];

export function Banner({ cwd, model, hint, notes }: BannerProps) {
  const tips = hint ? [hint] : DEFAULT_TIPS;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Box flexDirection="column" marginRight={2}>
          {LOGO.map((line, i) => (
            <Text key={i} color="cyan" bold>
              {line}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text>
            <Text bold color="cyan">
              coble
            </Text>
            <Text dimColor> v{VERSION}</Text>
          </Text>
          {model ? <Text>{shortModel(model)}</Text> : <Text dimColor>no model · run setup</Text>}
          <Text dimColor>{cwd}</Text>
          {(notes ?? []).map((n, i) => (
            <Text key={i} dimColor>
              {n}
            </Text>
          ))}
        </Box>
      </Box>
      {tips.map((t, i) => (
        <Text key={i} color={hint ? "yellow" : undefined} dimColor={!hint}>
          {`   ${t}`}
        </Text>
      ))}
    </Box>
  );
}
