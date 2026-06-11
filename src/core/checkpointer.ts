import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { checkpointDbPath, ensureHome } from "./store.js";

/** File-backed checkpointer at COBLE_HOME/checkpoints.db (durable across processes). */
export function openCheckpointer(): SqliteSaver {
  ensureHome();
  return SqliteSaver.fromConnString(checkpointDbPath());
}
