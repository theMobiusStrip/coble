import { useState } from "react";
import { Box, Text, useApp } from "ink";
import TextInput from "ink-text-input";

export function App() {
  const { exit } = useApp();
  const [input, setInput] = useState("");
  const [last, setLast] = useState<string | null>(null);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        ⛵ coble
      </Text>
      <Text dimColor>local agent cli — scaffold (agent core lands in M1)</Text>
      {last === null ? null : <Text>you said: {last}</Text>}
      <Box>
        <Text color="green">{"> "}</Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={(v) => {
            if (v.trim() === "exit") {
              exit();
              return;
            }
            setLast(v);
            setInput("");
          }}
          placeholder="type a task, enter to submit, 'exit' to quit"
        />
      </Box>
    </Box>
  );
}
