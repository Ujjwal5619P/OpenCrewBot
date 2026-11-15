import { ModelRouterLanguageModel } from "@mastra/core/llm";
import type {
  Bot,
  ModelOption,
  ModelProviderId,
  ModelProviderStatus,
  ModelSelection,
  ModelTaskType,
} from "@/lib/shared/types";

export const DEFAULT_MODEL = "MiniMaxAI/MiniMax-M3";
export const MODEL_REQUEST_CONTEXT_KEY = "opencrewbot.modelResolution";

type Row = [id: string, context: number, tools: boolean, reasoning: boolean, vision: boolean, inPerM: number, outPerM: number];
const STATIC: Row[] = [
  ["MiniMaxAI/MiniMax-M3", 1048576, true, true, false, 0.3, 1.2],
  ["deepseek-ai/DeepSeek-V4-Flash-0731", 1024000, true, true, false, 0.14, 0.28],
  ["deepseek-ai/DeepSeek-V4.1-Flash", 1048000, true, true, true, 0.3, 1.2],
  ["deepseek-ai/DeepSeek-V4-Pro", 1048576, true, true, false, 1.75, 3.5],
  ["Qwen/Qwen3.5-397B-A17B", 262144, true, true, false, 0.6, 3.6],
  ["Qwen/Qwen3.8-27B", 262144, true, true, false, 0.45, 3],
  ["Qwen/Qwen3-235B-A22B-Instruct-2507", 262144, true, false, false, 0.2, 0.6],
  ["Qwen/Qwen3-30B-A3B-Instruct-2507", 262144, true, false, false, 0.1, 0.3],
  ["zai-org/GLM-5.3", 1024000, true, true, false, 1.4, 4.4],
  ["zai-org/GLM-5.3-Flash", 1024000, true, true, false, 0.15, 0.5],
  ["moonshotai/Kimi-K3", 1048576, true, true, false, 3, 15],
  ["moonshotai/Kimi-K2.7-Code", 262144, true, true, false, 0.95, 4],
  ["nvidia/Nemotron-3_5-Lightning", 1048576, true, true, false, 0.06, 0.24],
  ["nvidia/nemotron-3-super-120b-a12b", 262144, true, true, false, 0.3, 0.9],
  ["nvidia/Nemotron-3-Ultra-550b-a55b", 1048576, true, true, false, 1, 3],
  ["openai/gpt-oss-120b", 131072, true, true, false, 0.15, 0.6],
  ["NousResearch/Hermes-4-405B", 131072, true, true, false, 1, 3],
  ["google/gemma-3-27b-it", 110000, true, false, true, 0.1, 0.3],
];

export interface ModelResolution {
  providerId: ModelProviderId | "mock";
  model: string;
  option?: ModelOption;
  simulated: boolean;
  fallbackFrom?: ModelSelection;
}

export interface ModelCatalog {
  models: ModelOption[];
  providers: ModelProviderStatus[];
}

export function isModelResolution(value: unknown): value is ModelResolution {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const providerId = candidate.providerId;
  const model = candidate.model;
  const simulated = candidate.simulated;
  return (
    (providerId === "nebius" || providerId === "ollama" || providerId === "mock") &&
    typeof model === "string" &&
    typeof simulated === "boolean" &&
    (providerId === "mock") === simulated
  );
}

const label = (id: string) => (id.split("/").pop() ?? id).replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
const staticModels: ModelOption[] = STATIC.map(([id, context, tools, reasoning, vision, inputPerM, outputPerM]) => ({
  id,
  label: label(id),
  provider: id.split("/")[0],
  providerId: "nebius",
  context,
  tools,
  reasoning,
  vision,
  inputPerM,
  outputPerM,
  live: false,
  available: false,
}));

interface LiveModel {
  id: string;
  name?: string;
  context_length?: number;
  architecture?: { modality?: string };
  pricing?: { prompt?: string; completion?: string };
  supported_features?: string[] | null;
  status?: string | null;
}

interface CachedCatalog {
  at: number;
  catalog: ModelCatalog;
}

const globalState = globalThis as unknown as { __opencrewbotModelCatalog?: CachedCatalog };
const LIVE_TTL_MS = 10 * 60 * 1000;

function providerStatus(
  providerId: ModelProviderId,
  available: boolean,
  configured: boolean,
  message?: string,
): ModelProviderStatus {
  return {
    providerId,
    label: providerId === "nebius" ? "Nebius Token Factory" : "Ollama",
    available,
    configured,
    ...(message ? { message } : {}),
  };
}

async function fetchNebius(): Promise<{ models: ModelOption[]; status: ModelProviderStatus }> {
  const key = process.env.NEBIUS_API_KEY;
  if (!key) {
    return {
      models: staticModels,
      status: providerStatus("nebius", false, false, "NEBIUS_API_KEY is not configured; Nebius selections use mock mode."),
    };
  }
  try {
    const res = await fetch("https://api.tokenfactory.nebius.com/v1/models?verbose=true", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return {
        models: staticModels,
        status: providerStatus("nebius", false, true, `Nebius model discovery returned HTTP ${res.status}.`),
      };
    }
    const json = (await res.json()) as { data?: LiveModel[] };
    const known = new Map(staticModels.map((option) => [option.id, option]));
    const models: ModelOption[] = [];
    for (const item of json.data ?? []) {
      const modality = item.architecture?.modality ?? "text->text";
      if (!modality.endsWith("->text") || (item.status && item.status !== "active")) continue;
      const base = known.get(item.id);
      const features = item.supported_features
        ? new Set(item.supported_features.map((feature) => feature.toLowerCase()))
        : null;
      const perMillion = (value?: string) =>
        value === undefined ? null : Math.round(Number(value) * 1e6 * 10_000) / 10_000;
      models.push({
        id: item.id,
        label: item.name ? label(item.name.split("/").pop() ?? item.name) : base?.label ?? label(item.id),
        provider: item.id.split("/")[0],
        providerId: "nebius",
        context: item.context_length ?? base?.context ?? 0,
        tools: features ? features.has("tools") : (base?.tools ?? false),
        reasoning: features ? features.has("reasoning") : (base?.reasoning ?? false),
        vision: base?.vision ?? modality.includes("image"),
        inputPerM: perMillion(item.pricing?.prompt) ?? base?.inputPerM ?? null,
        outputPerM: perMillion(item.pricing?.completion) ?? base?.outputPerM ?? null,
        live: true,
        available: true,
      });
    }
    if (!models.length) {
      return {
        models: staticModels,
        status: providerStatus("nebius", false, true, "Nebius did not report any supported chat models."),
      };
    }
    return { models, status: providerStatus("nebius", true, true) };
  } catch {
    return {
      models: staticModels,
      status: providerStatus("nebius", false, true, "Nebius model discovery is unavailable."),
    };
  }
}

function ollamaBaseUrl(): URL {
  const raw = process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434";
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("OLLAMA_BASE_URL must be an HTTP(S) URL without embedded credentials or query parameters.");
  }
  return url;
}

async function fetchOllama(): Promise<{ models: ModelOption[]; status: ModelProviderStatus }> {
  let baseUrl: URL;
  try {
    baseUrl = ollamaBaseUrl();
  } catch (error) {
    return {
      models: [],
      status: providerStatus("ollama", false, false, error instanceof Error ? error.message : "Invalid Ollama URL."),
    };
  }
  try {
    const endpoint = new URL("api/tags", `${baseUrl.href.replace(/\/+$/, "")}/`);
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) {
      return {
        models: [],
        status: providerStatus("ollama", false, true, `Ollama model discovery returned HTTP ${response.status}.`),
      };
    }
    const payload = (await response.json()) as { models?: Array<{ name?: string; model?: string; details?: { family?: string } }> };
    const allTaggedModels = payload.models ?? [];
    const taggedModels = allTaggedModels
      .slice(0, 20)
      .flatMap((item) => {
        const id = item.name ?? item.model;
        return id && id.length <= 200 ? [{ id, family: item.details?.family ?? "Ollama" }] : [];
      });
    const models = new Array<ModelOption>(taggedModels.length);
    let nextIndex = 0;
    await Promise.all(Array.from({ length: Math.min(10, taggedModels.length) }, async () => {
      while (nextIndex < taggedModels.length) {
        const index = nextIndex++;
        const item = taggedModels[index];
        const showUrl = new URL("api/show", `${baseUrl.href.replace(/\/+$/, "")}/`);
        let capabilities = new Set<string>();
        let context = 0;
        try {
          const showResponse = await fetch(showUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: item.id }),
            signal: AbortSignal.timeout(1500),
          });
          if (showResponse.ok) {
            const details = (await showResponse.json()) as {
              capabilities?: string[];
              model_info?: Record<string, unknown>;
            };
            capabilities = new Set((details.capabilities ?? []).map((value) => value.toLowerCase()));
            const contextEntry = Object.entries(details.model_info ?? {}).find(([key]) => key.endsWith(".context_length"))?.[1];
            if (typeof contextEntry === "number" && Number.isFinite(contextEntry)) context = contextEntry;
          }
        } catch {
          // A model listed by /api/tags remains visible, but unknown capabilities are not advertised.
        }
        models[index] = {
          id: item.id,
          label: label(item.id),
          provider: item.family,
          providerId: "ollama",
          context,
          tools: capabilities.has("tools"),
          reasoning: capabilities.has("thinking"),
          vision: capabilities.has("vision"),
          inputPerM: null,
          outputPerM: null,
          live: true,
          available: true,
        };
      }
    }));
    return models.length
      ? {
          models,
          status: providerStatus(
            "ollama",
            true,
            true,
            allTaggedModels.length > taggedModels.length ? "Showing the first 20 installed Ollama models." : undefined,
          ),
        }
      : { models: [], status: providerStatus("ollama", false, true, "No local Ollama models were found.") };
  } catch {
    return {
      models: [],
      status: providerStatus("ollama", false, true, "Ollama is not reachable at the configured endpoint."),
    };
  }
}

/** Providers and models that are actually available to this server process. */
export async function listModelCatalog(fresh = false): Promise<ModelCatalog> {
  const cached = globalState.__opencrewbotModelCatalog;
  if (!fresh && cached && Date.now() - cached.at < LIVE_TTL_MS) return cached.catalog;
  const [nebius, ollama] = await Promise.all([fetchNebius(), fetchOllama()]);
  const catalog = {
    models: [...nebius.models, ...ollama.models].sort(
      (a, b) => Number(b.available) - Number(a.available) || Number(b.tools) - Number(a.tools) ||
        a.providerId.localeCompare(b.providerId) || a.id.localeCompare(b.id),
    ),
    providers: [nebius.status, ollama.status],
  };
  globalState.__opencrewbotModelCatalog = { at: Date.now(), catalog };
  return catalog;
}

/** The model picker keeps configured Nebius choices visible even without a key. */
export async function listModels(fresh = false): Promise<ModelOption[]> {
  return (await listModelCatalog(fresh)).models;
}

export async function findModel(id: string, providerId: ModelProviderId = "nebius"): Promise<ModelOption | undefined> {
  return (await listModelCatalog()).models.find((model) => model.id === id && model.providerId === providerId);
}

export function selectionForBot(bot: Bot, taskType: ModelTaskType): ModelSelection {
  return bot.modelRouting?.[taskType] ?? { providerId: bot.modelProvider ?? "nebius", model: bot.model };
}

function supportsBotTools(bot: Bot, option: ModelOption): boolean {
  return !Object.values(bot.tools).some(Boolean) || option.tools;
}

function availableOption(
  bot: Bot,
  selection: ModelSelection,
  catalog: ModelCatalog,
): ModelOption | undefined {
  const option = catalog.models.find(
    (model) => model.providerId === selection.providerId && model.id === selection.model && model.available,
  );
  return option && supportsBotTools(bot, option) ? option : undefined;
}

/** Pure selection logic so provider routing and fallback rules can be tested without network access. */
export function selectModelForBot(bot: Bot, taskType: ModelTaskType, catalog: ModelCatalog): ModelResolution {
  const primary = selectionForBot(bot, taskType);
  const option = availableOption(bot, primary, catalog);
  if (option) return { providerId: primary.providerId, model: primary.model, option, simulated: false };

  if (bot.fallbackModel) {
    const fallback = availableOption(bot, bot.fallbackModel, catalog);
    if (!fallback) {
      throw new Error(
        `The configured ${bot.fallbackModel.providerId} fallback model "${bot.fallbackModel.model}" is unavailable or cannot run this bot's tools.`,
      );
    }
    return {
      providerId: bot.fallbackModel.providerId,
      model: bot.fallbackModel.model,
      option: fallback,
      simulated: false,
      fallbackFrom: primary,
    };
  }

  const provider = catalog.providers.find((item) => item.providerId === primary.providerId);
  if (primary.providerId === "nebius" && !provider?.configured) {
    return { providerId: "mock", model: "scripted-mock", simulated: true };
  }
  throw new Error(
    `The configured ${primary.providerId} model "${primary.model}" is unavailable or cannot run this bot's tools. Choose an available model or configure an explicit fallback.`,
  );
}

export async function resolveModelForBot(bot: Bot, taskType: ModelTaskType): Promise<ModelResolution> {
  return selectModelForBot(bot, taskType, await listModelCatalog());
}

/** Build a Mastra router model from server-only provider configuration. */
export function mastraModelFor(selection: ModelSelection): string | ModelRouterLanguageModel {
  if (selection.providerId === "nebius") return `nebius/${selection.model}`;
  const baseUrl = ollamaBaseUrl();
  return new ModelRouterLanguageModel({
    providerId: "ollama",
    modelId: selection.model,
    url: `${baseUrl.href.replace(/\/+$/, "")}/v1`,
    ...(process.env.OLLAMA_API_KEY ? { apiKey: process.env.OLLAMA_API_KEY } : {}),
  });
}

export function mastraModelForResolution(resolution: ModelResolution): string | ModelRouterLanguageModel {
  if (resolution.providerId === "mock") throw new Error("Simulated model resolution does not use a remote model provider.");
  return mastraModelFor({ providerId: resolution.providerId, model: resolution.model });
}

export function costUsd(model: ModelOption | undefined, input: number | null, output: number | null): number | null {
  if (!model || input === null || output === null || model.inputPerM === null || model.outputPerM === null) return null;
  return (input * model.inputPerM + output * model.outputPerM) / 1e6;
}
