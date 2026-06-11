import type { StructuredToolInterface } from "@langchain/core/tools";
import { makeFsTools, type ToolContext } from "./fsTools.js";
import { makeBashTool } from "./bash.js";

export type { ToolContext } from "./fsTools.js";

export function makeCoreTools(ctx: ToolContext): StructuredToolInterface[] {
  return [...makeFsTools(ctx), makeBashTool(ctx)];
}
