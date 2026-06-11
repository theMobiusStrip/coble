import type { AgentEvent } from "./events.js";
import type { SessionStore } from "./sessions.js";

/**
 * Pass engine events through unchanged while persisting terminal session state
 * (status / steps / cumulative usage) to the store. Keeps persistence orthogonal
 * to rendering: print mode and the TUI both consume the same passthrough stream.
 */
export async function* observeSession(
  events: AsyncIterable<AgentEvent>,
  store: SessionStore,
  sessionId: string,
): AsyncIterable<AgentEvent> {
  for await (const ev of events) {
    switch (ev.type) {
      case "final":
        store.update(sessionId, { status: "done", steps: ev.steps, usage: ev.usage, updatedAt: new Date().toISOString() });
        break;
      case "error":
        store.update(sessionId, { status: "error", updatedAt: new Date().toISOString() });
        break;
      case "interrupted":
        store.update(sessionId, { status: "paused", updatedAt: new Date().toISOString() });
        break;
      default:
        break;
    }
    yield ev;
  }
}
