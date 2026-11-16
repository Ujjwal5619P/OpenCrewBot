import { existsSync, mkdirSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import type { AppStatus } from "@/lib/shared/types";

// The data folder is chosen at runtime, so keep the bundler from tracing it.
export const DATA_DIR = resolve(/*turbopackIgnore: true*/ process.env.OPENCREWBOT_DATA_DIR || "./data");
export const WORKSPACES_DIR = resolve(DATA_DIR, "workspaces");
mkdirSync(WORKSPACES_DIR, { recursive: true });

// The app was called CrewRoom before; carry an existing database over once.
const APP_DB_PATH = resolve(DATA_DIR, "opencrewbot.db");
const LEGACY_DB_PATH = resolve(DATA_DIR, "crewroom.db");
if (!existsSync(APP_DB_PATH) && existsSync(LEGACY_DB_PATH)) renameSync(LEGACY_DB_PATH, APP_DB_PATH);

export const APP_DB_URL = `file:${APP_DB_PATH}`;
export const MASTRA_DB_URL = `file:${resolve(DATA_DIR, "mastra.db")}`;

/** The single local owner every bot thread belongs to. */
export const OWNER_ID = "owner";

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
export const DEFAULT_OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:3b";

export function ollamaBaseUrl(): string {
  return (process.env.OLLAMA_BASE_URL || process.env.OLLAMA_HOST || DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
}

const gOllama = globalThis as unknown as { __opencrewbotOllama?: { at: number; ok: boolean } };

export async function isOllamaReachable(force = false): Promise<boolean> {
  const now = Date.now();
  if (!force && gOllama.__opencrewbotOllama && now - gOllama.__opencrewbotOllama.at < 15_000) {
    return gOllama.__opencrewbotOllama.ok;
  }
  try {
    const res = await fetch(`${ollamaBaseUrl()}/api/tags`, { signal: AbortSignal.timeout(500) });
    const ok = res.ok;
    gOllama.__opencrewbotOllama = { at: now, ok };
    return ok;
  } catch {
    gOllama.__opencrewbotOllama = { at: now, ok: false };
    return false;
  }
}

export const keys = {
  nebius: () => Boolean(process.env.NEBIUS_API_KEY),
  tavily: () => Boolean(process.env.TAVILY_API_KEY),
  jev: () => Boolean(process.env.TYPESAFE_API_KEY),
  browserbase: () => Boolean(process.env.BROWSERBASE_API_KEY),
  composio: () => Boolean(process.env.COMPOSIO_API_KEY),
  github: () => Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN),
};

/** Without a Nebius key or reachable Ollama server, bots fall back to the scripted mock model. */
export const isMock = () => !keys.nebius() && !Boolean(gOllama.__opencrewbotOllama?.ok);

export async function resolveAppStatus(): Promise<AppStatus> {
  const ollamaAvailable = await isOllamaReachable();
  return {
    mock: !keys.nebius() && !ollamaAvailable,
    keys: { nebius: keys.nebius(), tavily: keys.tavily(), jev: keys.jev(), browserbase: keys.browserbase(), composio: keys.composio() },
    ollama: { available: ollamaAvailable, baseUrl: ollamaBaseUrl(), defaultModel: DEFAULT_OLLAMA_MODEL },
    dataDir: DATA_DIR,
  };
}

export function appStatus(): AppStatus {
  return {
    mock: isMock(),
    keys: { nebius: keys.nebius(), tavily: keys.tavily(), jev: keys.jev(), browserbase: keys.browserbase(), composio: keys.composio() },
    ollama: { available: Boolean(gOllama.__opencrewbotOllama?.ok), baseUrl: ollamaBaseUrl(), defaultModel: DEFAULT_OLLAMA_MODEL },
    dataDir: DATA_DIR,
  };
}
