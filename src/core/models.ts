import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ScriptedChatModel, loadScript } from "./scripted.js";

export interface ResolvedModel {
  model: BaseChatModel;
  label: string;
}

function defaultSpec(): string {
  if (process.env.COBLE_MODEL) return process.env.COBLE_MODEL;
  if (process.env.ANTHROPIC_API_KEY) return "anthropic:claude-sonnet-4-6";
  if (process.env.OPENAI_API_KEY) return "openai:gpt-5.5";
  throw new Error(
    [
      "no model configured. Fix with one of:",
      "  coble config set OPENAI_API_KEY <key>       # get one: https://platform.openai.com/api-keys",
      "  coble config set ANTHROPIC_API_KEY <key>    # get one: https://console.anthropic.com/settings/keys",
      '  coble -m ollama:llama3.1 "<task>"           # local & free — https://ollama.com',
      "or export the key in your shell, or pin a default: coble config set COBLE_MODEL provider:model",
    ].join("\n"),
  );
}

/**
 * Resolve "provider:model" into a chat model instance.
 * Providers are imported lazily so startup stays fast and a missing optional
 * dependency only matters if you actually select it.
 */
export async function resolveModel(spec?: string): Promise<ResolvedModel> {
  const s = spec ?? defaultSpec();
  const sep = s.indexOf(":");
  const provider = sep === -1 ? s : s.slice(0, sep);
  const name = sep === -1 ? "" : s.slice(sep + 1);

  switch (provider) {
    case "openai": {
      const { ChatOpenAI } = await import("@langchain/openai");
      const model = name || "gpt-5.5";
      return { model: new ChatOpenAI({ model }), label: `openai:${model}` };
    }
    case "anthropic": {
      const { ChatAnthropic } = await import("@langchain/anthropic");
      const model = name || "claude-sonnet-4-6";
      return { model: new ChatAnthropic({ model }), label: `anthropic:${model}` };
    }
    case "ollama": {
      const { ChatOllama } = await import("@langchain/ollama");
      const model = name || "llama3.1";
      // Honor OLLAMA_HOST (same variable the ollama CLI uses) for remote/Docker setups.
      const baseUrl = process.env.OLLAMA_HOST;
      return {
        model: new ChatOllama({ model, ...(baseUrl ? { baseUrl } : {}) }),
        label: `ollama:${model}`,
      };
    }
    case "scripted": {
      if (!name) throw new Error("scripted model needs a script file: -m scripted:path/to/script.json");
      const turns = await loadScript(name);
      return { model: new ScriptedChatModel(turns), label: `scripted:${name}` };
    }
    default:
      throw new Error(
        `unknown model provider "${provider}" — expected openai:, anthropic:, ollama: or scripted:`,
      );
  }
}
