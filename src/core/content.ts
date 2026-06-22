/**
 * Flatten LangChain message content to plain text. Content is either a string
 * (OpenAI, Ollama) or an array of content blocks (Anthropic, and others when a
 * turn mixes text with tool_use / thinking / images). Only `text` blocks
 * contribute; non-text blocks (tool_use, thinking, image, …) yield nothing.
 *
 * Centralizing this matters: extracting text with a bare `typeof content ===
 * "string"` check silently drops the whole answer for array-content providers,
 * which surfaces to the user as "the run ended without a final answer".
 */
export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        typeof c === "string"
          ? c
          : typeof (c as { text?: unknown }).text === "string"
            ? (c as { text: string }).text
            : "",
      )
      .join("");
  }
  return "";
}
