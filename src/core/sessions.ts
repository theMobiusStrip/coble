import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { customAlphabet } from "nanoid";
import type { TokenUsage } from "./events.js";
import { sessionsPath } from "./store.js";

export type SessionStatus = "running" | "done" | "error" | "paused";

export interface Session {
  id: string;
  cwd: string;
  model: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  steps: number;
  usage: TokenUsage;
}

// Lowercase alphanumeric, unambiguous-enough, 8 chars → short resumable ids.
const newId = customAlphabet("23456789abcdefghijkmnpqrstuvwxyz", 8);

interface SessionFile {
  sessions: Session[];
}

function load(file: string): SessionFile {
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as SessionFile;
    if (!Array.isArray(parsed.sessions)) return { sessions: [] };
    return parsed;
  } catch {
    return { sessions: [] };
  }
}

function save(file: string, data: SessionFile): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, file);
}

export interface SessionStore {
  create(input: { cwd: string; model: string; prompt: string; nowIso: string }): Session;
  update(id: string, patch: Partial<Omit<Session, "id">>): Session | undefined;
  get(id: string): Session | undefined;
  /** Resolve a unique id prefix; returns undefined if absent, throws if ambiguous. */
  resolve(prefix: string): Session | undefined;
  list(): Session[];
}

export function openSessionStore(file: string = sessionsPath()): SessionStore {
  return {
    create({ cwd, model, prompt, nowIso }) {
      const data = load(file);
      const session: Session = {
        id: newId(),
        cwd,
        model,
        prompt,
        createdAt: nowIso,
        updatedAt: nowIso,
        status: "running",
        steps: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
      data.sessions.push(session);
      save(file, data);
      return session;
    },
    update(id, patch) {
      const data = load(file);
      const idx = data.sessions.findIndex((s) => s.id === id);
      if (idx === -1) return undefined;
      const merged = { ...data.sessions[idx], ...patch, id } as Session;
      data.sessions[idx] = merged;
      save(file, data);
      return merged;
    },
    get(id) {
      return load(file).sessions.find((s) => s.id === id);
    },
    resolve(prefix) {
      const matches = load(file).sessions.filter((s) => s.id.startsWith(prefix));
      if (matches.length === 0) return undefined;
      if (matches.length > 1) {
        throw new Error(`ambiguous session id "${prefix}" matches ${matches.length} sessions`);
      }
      return matches[0];
    },
    list() {
      return load(file).sessions.slice().reverse();
    },
  };
}
